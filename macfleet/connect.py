from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from macfleet.activity import Activity, default_activity_path
from macfleet.leases import Leases, default_state_path
from macfleet.shares import Shares, default_shares_path
from macfleet.vm import (
    GOLDEN,
    Runner,
    Tart,
    VmInfo,
    _run,
    _run_nocheck,
    ensure_mutable,
    fullname,
    shortname,
    validate_label,
    validate_name,
)

GUEST_USER = "admin"
SERVER_PORT = 8000
SSH_OPTS = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
]


def _spawn(argv: list[str]) -> None:
    # start_new_session detaches the child into its own process group + session so it
    # OUTLIVES the engine. The desktop host spawns this engine in a process group and
    # SIGTERMs that whole group on quit (see desktop/src-tauri/src/lib.rs); without the
    # break, every backgrounded `tart run` would inherit that group and be killed on app
    # exit — hard-stopping the entire fleet on every quit/dev-rebuild. VMs are a persistent
    # fleet (also driven by the CLI/MCP), so they must not die with the window.
    subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)


def ssh_cmd(ip: str, remote_cmd: str) -> list[str]:
    return ["ssh", *SSH_OPTS, f"{GUEST_USER}@{ip}", remote_cmd]


def scp_push_cmd(ip: str, local: str, remote: str) -> list[str]:
    return ["scp", *SSH_OPTS, local, f"{GUEST_USER}@{ip}:{remote}"]


def scp_pull_cmd(ip: str, remote: str, local: str) -> list[str]:
    return ["scp", *SSH_OPTS, f"{GUEST_USER}@{ip}:{remote}", local]


class GuestControl:
    """Computer-use client that drives a VM's in-guest `cua-computer-server` over its
    HTTP `/cmd` endpoint. Keeps a tiny, dependency-free surface (screenshot/click/type/
    key) so the API and desktop don't depend on the heavy `cua-computer` client."""

    def __init__(self, base_url: str, opener: Callable[..., Any] = urllib.request.urlopen):
        self._base = base_url.rstrip("/")
        self._open = opener

    def _cmd(self, command: str, **params: Any) -> dict:
        body = json.dumps({"command": command, "params": params}).encode()
        req = urllib.request.Request(
            f"{self._base}/cmd", data=body, headers={"content-type": "application/json"}
        )
        try:
            with self._open(req, timeout=30) as resp:
                raw = resp.read().decode()
        except (urllib.error.URLError, OSError) as exc:
            raise RuntimeError(f"computer-server unreachable: {exc}") from exc
        # /cmd streams Server-Sent Events: one or more `data: {json}` lines.
        result: dict = {}
        for line in raw.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                line = line[5:].strip()
            if not line.startswith("{"):
                continue
            result = json.loads(line)
            if not result.get("success", True):
                raise RuntimeError(result.get("error", f"{command} failed"))
        return result

    def screenshot(self) -> bytes:
        return base64.b64decode(self._cmd("screenshot")["image_data"])

    def click(self, x: int, y: int) -> None:
        self._cmd("left_click", x=x, y=y)

    def type(self, text: str) -> None:
        self._cmd("type_text", text=text)

    def key(self, combo: str) -> None:
        keys = [k.strip() for k in combo.replace("-", "+").split("+") if k.strip()]
        if len(keys) > 1:
            self._cmd("hotkey", keys=keys)
        elif keys:
            self._cmd("press_key", key=keys[0])


class Fleet:
    def __init__(self, tart: Tart | None = None, run: Runner = _run,
                 spawn: Callable[[list[str]], None] = _spawn,
                 run_nocheck: Runner = _run_nocheck,
                 leases: Leases | None = None,
                 clock: Callable[[], float] = time.time,
                 activity: Activity | None = None,
                 shares: Shares | None = None) -> None:
        self.tart = tart or Tart(run=run)
        self._run = run
        self._spawn = spawn
        self._run_nocheck = run_nocheck
        self._leases = leases or Leases(default_state_path())
        self._shares = shares or Shares(default_shares_path())
        self._clock = clock
        self.activity = activity or Activity(default_activity_path())
        self._res_cache: dict[str, dict] = {}
        # Guest IP keyed by full name. A running VM's IP is stable for its boot, but `tart
        # ip` is a subprocess on the hot path — status() runs it for every running VM on
        # every /vms poll, and screenshot/exec/ssh hit it too. Cache it and drop the entry
        # on any op that stops or renames the VM (invalidated in down/nuke/suspend/resume/
        # rename), so the next call re-resolves against the fresh boot.
        self._ip_cache: dict[str, str] = {}

    def _state(self, full: str) -> str:
        return self.tart.get_config(full)["State"]

    def _fetch_config(self, full: str) -> dict | None:
        try:
            c = self.tart.get_config(full)
        except Exception:
            return None
        return {"cpu": c.get("CPU"), "memory_mb": c.get("Memory"), "disk_gb": c.get("Disk")}

    def suspend(self, name: str) -> None:
        ensure_mutable(name)
        self.tart.suspend(fullname(name))
        self._forget_ip(fullname(name))
        self._leases.suspend(fullname(name))

    def resume(self, name: str) -> None:
        ensure_mutable(name)
        self._forget_ip(fullname(name))
        self._spawn(self._run_argv(fullname(name)))
        self._leases.unsuspend(fullname(name))

    def create(self, name: str, from_snapshot: str | None = None,
               ttl: float | None = None, cpu: int | None = None,
               memory: int | None = None, disk: int | None = None) -> None:
        target = ensure_mutable(name)
        validate_name(name)
        # One `tart list`, reused for both the reclaim check and the existence check.
        # Deliberately NOT a full self.reap(): reaping every expired lease here would make
        # an unrelated expired VM's (slow) graceful stop block this create. The API's
        # background reap loop and list_vms() sweep those; create only needs to reclaim the
        # ONE name it's about to take if a lease on it already expired.
        existing = {v.name for v in self.tart.list()}
        if target in existing and target in set(self._leases.expired(self._clock())):
            try:
                self.nuke(shortname(target))
            except RuntimeError:
                pass
            self._leases.drop(target)
            existing.discard(target)
        cloned = target not in existing
        if cloned:
            src = f"mfsnap-{from_snapshot}" if from_snapshot else "mf-golden"
            self.tart.clone(src, target)
            # Resources can only be set on a stopped VM, and only a freshly-cloned one is
            # stopped here — applying them to a pre-existing (possibly running) VM would
            # make `tart set` fail. `tart set --disk-size` is also grow-only, so pass it
            # through only when it grows the clone's disk.
            disk_size = disk
            if disk is not None and disk <= self.tart.get_config(target)["Disk"]:
                disk_size = None
            if cpu is not None or memory is not None or disk_size is not None:
                self.tart.set_config(target, cpu=cpu, memory=memory, disk_size=disk_size)
            self._res_cache.pop(target, None)
        # background `tart run` so it doesn't block the caller
        self._spawn(self._run_argv(target))
        if ttl is not None:
            self._leases.record(target, ttl)

    def warm_golden(self, timeout: float = 180.0, poll: float = 3.0,
                    sleep: Callable[[float], None] = time.sleep) -> bool:
        """Boot mf-golden, wait for its guest server, then SUSPEND it — so every future
        create clones an already-booted image that resumes in ~2s instead of cold-booting
        macOS for ~30-60s (the dominant cost of `create`). One-time; re-run after re-baking
        golden. Returns True once golden is suspended-warm, False if the guest never became
        reachable within `timeout` (golden left running so it can be inspected)."""
        if GOLDEN not in {v.name for v in self.tart.list()}:
            raise RuntimeError(f"{GOLDEN} not found — bake it first (see `macfleet bake`)")
        self._forget_ip(GOLDEN)
        self._spawn(self._run_argv(GOLDEN))
        deadline = self._clock() + timeout
        while self._clock() < deadline:
            if self.status("golden"):
                self.tart.suspend(GOLDEN)
                self._forget_ip(GOLDEN)
                return True
            sleep(poll)
        return False

    def host_info(self) -> dict:
        out = self._run(["sysctl", "-n", "hw.memsize", "hw.ncpu"]).stdout
        memsize, cpu_count = out.split()
        name = self._run(["hostname"]).stdout.strip()
        return {"total_mem_gb": round(int(memsize) / 1024**3), "cpu_count": int(cpu_count), "name": name}

    def up(self, name: str) -> None:
        self.create(name)

    def reap(self, existing: list[VmInfo] | None = None) -> list[str]:
        now = self._clock()
        names = {v.name for v in (existing if existing is not None else self.tart.list())}
        reaped = []
        for full in self._leases.expired(now):
            if full in names:
                try:
                    self.nuke(shortname(full))
                except RuntimeError:
                    pass
            self._leases.drop(full)
            reaped.append(full)
        return reaped

    def list_vms(self) -> list[dict]:
        vms = self.tart.list()
        reaped = set(self.reap(existing=vms))
        vms = [v for v in vms if v.name not in reaped]
        # Health-check running VMs concurrently — each check is a network round-trip to
        # the guest, so doing them sequentially made /vms scale with fleet size and stall
        # under screenshot load. Parallel keeps the list responsive.
        running = [v for v in vms if v.state == "running"]
        health: dict[str, bool] = {}
        uncached = [v for v in vms if v.name not in self._res_cache]
        if running or uncached:
            with ThreadPoolExecutor(max_workers=min(8, len(vms))) as pool:
                if running:
                    health = dict(pool.map(lambda v: (v.name, self.status(shortname(v.name))), running))
                for name, res in pool.map(lambda v: (v.name, self._fetch_config(v.name)), uncached):
                    if res is not None:
                        self._res_cache[name] = res
        suspended = self._leases.suspended()
        return [{"name": v.name,
                 "state": "suspended" if (v.name in suspended and v.state == "running") else v.state,
                 "source": v.source, "healthy": health.get(v.name, False),
                 **self._res_cache.get(v.name, {"cpu": None, "memory_mb": None, "disk_gb": None})}
                for v in vms]

    def down(self, name: str) -> None:
        ensure_mutable(name)
        self.tart.stop(fullname(name))
        self._forget_ip(fullname(name))
        self._leases.unsuspend(fullname(name))

    def restart(self, name: str) -> None:
        """Stop mf-<name> and boot it again — the way to apply a shared-folder change to a
        running VM (shares only take effect on `tart run`)."""
        ensure_mutable(name)
        full = fullname(name)
        try:
            self.tart.stop(full)
        except RuntimeError:
            pass
        self._forget_ip(full)
        self._leases.unsuspend(full)
        self._spawn(self._run_argv(full))

    def nuke(self, name: str) -> None:
        ensure_mutable(name)
        try:
            self.tart.stop(fullname(name))
        except RuntimeError:
            pass
        self.tart.delete(fullname(name))
        self._res_cache.pop(fullname(name), None)
        self._forget_ip(fullname(name))
        self._leases.unsuspend(fullname(name))
        self._shares.drop(fullname(name))

    def ip(self, name: str) -> str:
        full = fullname(name)
        cached = self._ip_cache.get(full)
        if cached:
            return cached
        ip = self.tart.ip(full)
        if ip:
            self._ip_cache[full] = ip
        return ip

    def _forget_ip(self, full: str) -> None:
        self._ip_cache.pop(full, None)

    def _run_argv(self, full: str) -> list[str]:
        """`tart run` command for a VM, including its shared-folder `--dir` flags. Every
        boot site goes through this so shares are (re)applied on each start."""
        argv = ["tart", "run", full, "--no-graphics"]
        for s in self._shares.get(full):
            flag = f"--dir={s['tag']}:{s['host_path']}"
            if s.get("read_only"):
                flag += ":ro"
            argv.append(flag)
        return argv

    def get_shares(self, name: str) -> list[dict]:
        return self._shares.get(fullname(name))

    def set_shares(self, name: str, shares: list[dict]) -> None:
        """Replace a VM's shared folders. Validates each tag (filesystem-safe, unique) and
        that the host path is an existing directory; expands `~`; read-only defaults True.
        Takes effect on the VM's next start (see restart)."""
        ensure_mutable(name)
        tag_re = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
        seen: set[str] = set()
        normalized: list[dict] = []
        for s in shares:
            tag = str(s.get("tag", ""))
            host_path = os.path.expanduser(str(s.get("host_path", "")))
            if not tag_re.fullmatch(tag):
                raise RuntimeError(
                    f"invalid share tag {tag!r}: use letters, digits, '.', '_', '-'")
            if tag in seen:
                raise RuntimeError(f"duplicate share tag {tag!r}")
            seen.add(tag)
            if not os.path.isdir(host_path):
                raise RuntimeError(f"shared folder not found: {host_path}")
            normalized.append({"tag": tag, "host_path": host_path,
                               "read_only": bool(s.get("read_only", True))})
        self._shares.set(fullname(name), normalized)

    def ssh(self, name: str, remote_cmd: str) -> str:
        ensure_mutable(name)
        return self._run(ssh_cmd(self.ip(name), remote_cmd)).stdout

    def status(self, name: str) -> bool:
        # Short timeout: this runs on every /vms poll, so a slow/contended guest must
        # fail fast rather than stall the whole fleet list.
        try:
            with urllib.request.urlopen(
                f"http://{self.ip(name)}:{SERVER_PORT}/status", timeout=2
            ) as resp:
                return b"ok" in resp.read()
        except Exception:
            return False

    def logs(self, name: str, lines: int = 100) -> str:
        from macfleet.provision import SERVER_LOG

        return self.ssh(name, f"tail -n {int(lines)} {SERVER_LOG} 2>/dev/null || true")

    def snapshot(self, name: str, label: str) -> str:
        src = ensure_mutable(name)
        validate_label(label)
        sid = f"mfsnap-{shortname(name)}-{label}"
        if sid in {v.name for v in self.tart.list()}:
            raise RuntimeError(f"snapshot {shortname(name)}-{label} already exists")
        was_running = self._state(src) == "running"
        if was_running:
            try:
                self.tart.suspend(src)
            except RuntimeError:
                self.tart.stop(src)  # clean-disk fallback if the image can't suspend
        self.tart.clone(src, sid)
        if was_running:
            self._spawn(self._run_argv(src))  # resume original
            self._leases.unsuspend(src)
        return f"{shortname(name)}-{label}"

    def snapshots(self) -> list[dict]:
        out = []
        for v in self.tart.list():
            if v.name.startswith("mfsnap-"):
                sid = v.name[len("mfsnap-"):]
                # Labels forbid '-' (validate_label), so the last '-' always separates the
                # (possibly hyphenated) VM name from the label — split from the right.
                vm, _, label = sid.rpartition("-")
                out.append({"id": sid, "vm": vm, "label": label, "size": v.size})
        return out

    def delete_snapshot(self, snapshot_id: str) -> None:
        self.tart.delete(f"mfsnap-{snapshot_id}")

    def computer(self, name: str) -> GuestControl:
        ensure_mutable(name)
        if os.environ.get("MACFLEET_ALLOW_CONTROL") != "1":
            raise RuntimeError(
                "computer-use disabled — set MACFLEET_ALLOW_CONTROL=1 (VM-only)."
            )
        return GuestControl(f"http://{self.ip(name)}:{SERVER_PORT}")

    def rename(self, old: str, new: str) -> None:
        ensure_mutable(old)
        ensure_mutable(new)
        validate_name(new)
        self.tart.rename(fullname(old), fullname(new))
        self._res_cache.pop(fullname(old), None)
        self._forget_ip(fullname(old))
        self._leases.rename(fullname(old), fullname(new))
        self._shares.rename(fullname(old), fullname(new))

    def duplicate(self, name: str, new: str) -> None:
        src = ensure_mutable(name)
        ensure_mutable(new)
        validate_name(new)
        was_running = self._state(src) == "running"
        if was_running:
            try:
                self.tart.suspend(src)
            except RuntimeError:
                self.tart.stop(src)
        self.tart.clone(src, fullname(new))
        if was_running:
            self._spawn(self._run_argv(src))
            self._leases.unsuspend(src)
            self._spawn(self._run_argv(fullname(new)))

    def restore(self, name: str, snapshot_id: str) -> None:
        """Restore mf-<name> to a snapshot: stop+delete the current VM (if any), clone the
        snapshot over its name, and boot it (resumes the captured state). Destructive — the
        VM's current disk/state is discarded. Works when the VM no longer exists (recreate)."""
        target = ensure_mutable(name)
        validate_name(name)
        snap = f"mfsnap-{snapshot_id}"
        names = {v.name for v in self.tart.list()}
        if snap not in names:
            raise RuntimeError(f"snapshot {snapshot_id} not found")
        if target in names:
            try:
                self.tart.stop(target)
            except RuntimeError:
                pass
            self.tart.delete(target)
            self._res_cache.pop(target, None)
            self._forget_ip(target)
            self._leases.unsuspend(target)
        self.tart.clone(snap, target)
        self._spawn(self._run_argv(target))

    def resources(self, name: str) -> dict:
        c = self.tart.get_config(fullname(name))

        def get(key: str) -> Any:
            try:
                return c[key]
            except KeyError:
                raise RuntimeError(f"unexpected tart get output: missing {key}") from None

        return {"cpu": get("CPU"), "memory_mb": get("Memory"), "disk_gb": get("Disk"),
                "display": get("Display"), "state": get("State")}

    def set_resources(self, name: str, cpu: int | None = None, memory: int | None = None,
                      disk_size: int | None = None, display: str | None = None) -> None:
        ensure_mutable(name)
        current = self.resources(name)
        if current["state"] == "running":
            raise RuntimeError("stop the VM before changing resources")
        if disk_size is not None and disk_size <= current["disk_gb"]:
            disk_size = None  # tart set --disk-size is grow-only
        self.tart.set_config(fullname(name), cpu=cpu, memory=memory,
                             disk_size=disk_size, display=display)
        self._res_cache.pop(fullname(name), None)

    def connection_info(self, name: str) -> dict:
        ip = self.ip(name)
        return {"ip": ip, "ssh": f"ssh {GUEST_USER}@{ip}",
                "vnc": f"open vnc://{GUEST_USER}@{ip}",
                "guest_server": f"http://{ip}:{SERVER_PORT}", "exec": True}

    def exec(self, name: str, command: str) -> dict:
        ensure_mutable(name)
        proc = self._run_nocheck(["tart", "exec", fullname(name), "/bin/sh", "-lc", command])
        return {"stdout": proc.stdout, "exit_code": proc.returncode}

    def metrics(self, name: str) -> dict:
        ensure_mutable(name)
        proc = self._run_nocheck(
            ["tart", "exec", fullname(name), "/bin/sh", "-lc",
             "top -l1 -n0 | grep -E 'CPU usage|PhysMem'"])
        if proc.returncode != 0:
            raise RuntimeError(f"metrics unavailable: {proc.stderr.strip() or 'exec failed'}")
        cpu_pct = 0.0
        mem_used_mb = 0
        for line in proc.stdout.splitlines():
            if "CPU usage" in line:
                m = re.search(r"([\d.]+)%\s+idle", line)
                if m:
                    cpu_pct = round(100 - float(m.group(1)), 1)
            elif "PhysMem" in line:
                m = re.search(r"([\d.]+)([MG])\s+used", line)
                if m:
                    val = float(m.group(1))
                    mem_used_mb = int(val * 1024) if m.group(2) == "G" else int(val)
        total = self._res_cache.get(fullname(name), {}).get("memory_mb") or self.resources(name)["memory_mb"]
        return {"cpu_pct": cpu_pct, "mem_used_mb": mem_used_mb, "mem_total_mb": total}

    def activity_recent(self, limit: int = 20) -> list[dict]:
        return self.activity.recent(limit)
