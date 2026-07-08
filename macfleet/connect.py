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
from macfleet.vm import Runner, Tart, VmInfo, _run, _run_nocheck, fullname, shortname

GUEST_USER = "admin"
SERVER_PORT = 8000
SSH_OPTS = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
]


def _spawn(argv: list[str]) -> None:
    subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


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
                 activity: Activity | None = None) -> None:
        self.tart = tart or Tart(run=run)
        self._run = run
        self._spawn = spawn
        self._run_nocheck = run_nocheck
        self._leases = leases or Leases(default_state_path())
        self._clock = clock
        self.activity = activity or Activity(default_activity_path())
        self._res_cache: dict[str, dict] = {}

    def _state(self, full: str) -> str:
        return self.tart.get_config(full)["State"]

    def _fetch_config(self, full: str) -> dict | None:
        try:
            c = self.tart.get_config(full)
        except Exception:
            return None
        return {"cpu": c.get("CPU"), "memory_mb": c.get("Memory"), "disk_gb": c.get("Disk")}

    def suspend(self, name: str) -> None:
        self.tart.suspend(fullname(name))
        self._leases.suspend(fullname(name))

    def resume(self, name: str) -> None:
        self._spawn(["tart", "run", fullname(name), "--no-graphics"])
        self._leases.unsuspend(fullname(name))

    def create(self, name: str, from_snapshot: str | None = None,
               ttl: float | None = None, cpu: int | None = None,
               memory: int | None = None, disk: int | None = None) -> None:
        self.reap()
        target = fullname(name)
        if target not in {v.name for v in self.tart.list()}:
            src = f"mfsnap-{from_snapshot}" if from_snapshot else "mf-golden"
            self.tart.clone(src, target)
        # `tart set --disk-size` is grow-only — shrinking raises. Only pass it through
        # when it actually grows the freshly-cloned VM's disk.
        disk_size = disk
        if disk is not None and disk <= self.tart.get_config(target)["Disk"]:
            disk_size = None
        if cpu is not None or memory is not None or disk_size is not None:
            # freshly-cloned VM is stopped, so `tart set` is valid here
            self.tart.set_config(target, cpu=cpu, memory=memory, disk_size=disk_size)
        self._res_cache.pop(target, None)
        # background `tart run` so it doesn't block the caller
        self._spawn(["tart", "run", target, "--no-graphics"])
        if ttl is not None:
            self._leases.record(target, ttl)

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
        self.tart.stop(fullname(name))
        self._leases.unsuspend(fullname(name))

    def nuke(self, name: str) -> None:
        try:
            self.tart.stop(fullname(name))
        except RuntimeError:
            pass
        self.tart.delete(fullname(name))
        self._res_cache.pop(fullname(name), None)
        self._leases.unsuspend(fullname(name))

    def ip(self, name: str) -> str:
        return self.tart.ip(fullname(name))

    def ssh(self, name: str, remote_cmd: str) -> str:
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
        src = fullname(name)
        was_running = self._state(src) == "running"
        if was_running:
            try:
                self.tart.suspend(src)
            except RuntimeError:
                self.tart.stop(src)  # clean-disk fallback if the image can't suspend
        self.tart.clone(src, f"mfsnap-{shortname(name)}-{label}")
        if was_running:
            self._spawn(["tart", "run", src, "--no-graphics"])  # resume original
        return f"{shortname(name)}-{label}"

    def snapshots(self) -> list[dict]:
        out = []
        for v in self.tart.list():
            if v.name.startswith("mfsnap-"):
                sid = v.name[len("mfsnap-"):]
                vm, _, label = sid.partition("-")
                out.append({"id": sid, "vm": vm, "label": label, "size": v.size})
        return out

    def delete_snapshot(self, snapshot_id: str) -> None:
        self.tart.delete(f"mfsnap-{snapshot_id}")

    def computer(self, name: str) -> GuestControl:
        if os.environ.get("MACFLEET_ALLOW_CONTROL") != "1":
            raise RuntimeError(
                "computer-use disabled — set MACFLEET_ALLOW_CONTROL=1 (VM-only)."
            )
        return GuestControl(f"http://{self.ip(name)}:{SERVER_PORT}")

    def rename(self, old: str, new: str) -> None:
        self.tart.rename(fullname(old), fullname(new))
        self._res_cache.pop(fullname(old), None)
        self._leases.rename(fullname(old), fullname(new))

    def duplicate(self, name: str, new: str) -> None:
        src = fullname(name)
        was_running = self._state(src) == "running"
        if was_running:
            try:
                self.tart.suspend(src)
            except RuntimeError:
                self.tart.stop(src)
        self.tart.clone(src, fullname(new))
        if was_running:
            self._spawn(["tart", "run", src, "--no-graphics"])
            self._spawn(["tart", "run", fullname(new), "--no-graphics"])

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
        proc = self._run_nocheck(["tart", "exec", fullname(name), "/bin/sh", "-lc", command])
        return {"stdout": proc.stdout, "exit_code": proc.returncode}

    def metrics(self, name: str) -> dict:
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
