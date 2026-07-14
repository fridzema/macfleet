from __future__ import annotations

import json
import hashlib
import os
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any

from macfleet._lock import state_lock
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

# Substrings that mark an SSH failure as a transient connection problem (guest still booting)
# worth retrying — as opposed to a genuine nonzero exit from the remote command, which is not.
_SSH_TRANSIENT = (
    "connection refused", "connection timed out", "operation timed out",
    "connection closed", "no route to host", "timed out",
)


def _spawn(argv: list[str]) -> "subprocess.Popen[bytes]":
    # start_new_session detaches the child into its own process group + session so it
    # OUTLIVES the engine. The desktop host spawns this engine in a process group and
    # SIGTERMs that whole group on quit (see desktop/src-tauri/src/lib.rs); without the
    # break, every backgrounded `tart run` would inherit that group and be killed on app
    # exit — hard-stopping the entire fleet on every quit/dev-rebuild. VMs are a persistent
    # fleet (also driven by the CLI/MCP), so they must not die with the window. The handle is
    # returned so Fleet can reap it once the VM stops (see Fleet._boot).
    return subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True)


def _spawn_restore(argv: list[str]) -> "subprocess.Popen[bytes]":
    """Spawn a resume attempt with diagnostics retained in an anonymous temporary file.

    The restore probe must distinguish the one known un-restorable VZ failure from unrelated
    launch failures before it discards saved state. A file avoids an unread PIPE blocking a
    long-lived successful `tart run`.
    """
    diagnostic = tempfile.TemporaryFile()
    child = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=diagnostic,
                             start_new_session=True)
    child._macfleet_diagnostic = diagnostic  # type: ignore[attr-defined]
    return child


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

    def __init__(self, base_url: str, token: str | None = None,
                 opener: Callable[..., Any] = urllib.request.urlopen):
        self._base = base_url.rstrip("/")
        self._token = token
        self._open = opener

    def _cmd(self, command: str, **params: Any) -> dict:
        body = json.dumps({"command": command, "params": params}).encode()
        headers = {"content-type": "application/json"}
        if self._token:
            headers["x-macfleet-guest-token"] = self._token
        req = urllib.request.Request(f"{self._base}/cmd", data=body, headers=headers)
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

    def _get(self, path: str, timeout: float = 30) -> bytes:
        headers = {}
        if self._token:
            headers["x-macfleet-guest-token"] = self._token
        req = urllib.request.Request(f"{self._base}{path}", headers=headers)
        try:
            with self._open(req, timeout=timeout) as resp:
                return resp.read()
        except (urllib.error.URLError, OSError) as exc:
            raise RuntimeError(f"computer-server unreachable: {exc}") from exc

    def screenshot(self) -> bytes:
        return self._get("/macfleet/screenshot")

    def logs(self, lines: int = 100, cursor: int | None = None) -> dict:
        query = f"lines={lines}"
        if cursor is not None:
            query += f"&cursor={cursor}"
        return json.loads(self._get(f"/macfleet/logs?{query}").decode())

    def metrics(self) -> dict:
        return json.loads(self._get("/macfleet/metrics", timeout=10).decode())

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


# Ordered provisioning phases surfaced to the desktop while create() runs. clone/configure are
# recorded synchronously by create() (the frontend can't observe them); boot/health are advanced
# from live tart state + the guest health check list_vms() already runs. The desktop renders these
# as a stepper (VmProvisioning.vue).
_PROVISION_PHASES: tuple[tuple[str, str], ...] = (
    ("clone", "Clone image"),
    ("configure", "Apply resources"),
    ("boot", "Boot guest"),
    ("health", "Guest health check"),
)
# Lifetimes for the provisioning records above. A completed record lingers one SSE cycle so the
# desktop sees the done=True frame, then is dropped; an errored or stalled create (VM never
# materialized) is swept after PROVISION_TTL so the map can't grow unbounded.
_PROVISION_LINGER = 2.0
_PROVISION_TTL = 180.0

# VZ restore failures are not consistently prompt: real hardware has produced the diagnostic
# more than five seconds after `tart run` started. A successful boot runs for the VM's lifetime,
# so retain the child briefly and inspect it after a conservative bounded window. If it died with
# the exact known signature, discard only the unusable saved state and cold-boot; any other launch
# failure preserves that state. This is synchronous so a short-lived CLI worker cannot disappear
# before recovery executes.
_RESTORE_PROBE_SECONDS = 15.0
_IP_CACHE_TTL = 15.0
_RESOURCE_CACHE_TTL = 30.0
_RESTORE_FAILURE_MARKERS = ("failed to restore", "invalid argument")


class Fleet:
    def __init__(self, tart: Tart | None = None, run: Runner = _run,
                 spawn: Callable[[list[str]], Any] = _spawn,
                 run_nocheck: Runner = _run_nocheck,
                 leases: Leases | None = None,
                 clock: Callable[[], float] = time.time,
                 activity: Activity | None = None,
                 shares: Shares | None = None,
                 sleep: Callable[[float], None] = time.sleep,
                 monotonic: Callable[[], float] = time.monotonic,
                 operation_lock_dir: str | None = None) -> None:
        self.tart = tart or Tart(run=run)
        self._run = run
        self._spawn = spawn
        self._run_nocheck = run_nocheck
        self._leases = leases or Leases(default_state_path())
        self._shares = shares or Shares(default_shares_path())
        self._clock = clock
        self._sleep = sleep
        self._monotonic = monotonic
        self._operation_lock_dir = Path(operation_lock_dir or self._leases.storage_dir) / "operations"
        self.activity = activity or Activity(default_activity_path())
        self._res_cache: dict[str, dict] = {}
        self._res_cache_at: dict[str, float] = {}
        # Handles for backgrounded `tart run` children, kept so their zombies are reaped once
        # the VM stops (a detached `tart run` stays a direct child of the engine, so nothing
        # reaps its defunct entry otherwise). Swept on every boot; see _boot.
        self._spawned: list = []
        # Guest IP keyed by full name. A running VM's IP is stable for its boot, but `tart
        # ip` is a subprocess on the hot path — status() runs it for every running VM on
        # every /vms poll, and screenshot/exec/ssh hit it too. Cache it and drop the entry
        # on any op that stops or renames the VM (invalidated in down/nuke/suspend/resume/
        # rename), so the next call re-resolves against the fresh boot.
        self._ip_cache: dict[str, tuple[float, str]] = {}
        # The guest gateway rotates its command token on every boot. Cache it for the
        # lifetime of that boot and invalidate it alongside the IP on every lifecycle op.
        self._control_tokens: dict[str, str] = {}
        self._control_token_ips: dict[str, str] = {}
        # Coalesce bursts from the event stream, mutation-triggered refreshes, and fallback
        # polling. Tart state is refreshed at most once per second; guest health has its own
        # adaptive TTL so a stable fleet does not probe every VM on every UI update.
        self._fleet_cache: tuple[float, list[dict]] | None = None
        self._health_cache: dict[str, tuple[float, bool]] = {}
        self._cache_lock = threading.Lock()
        # Provisioning progress per just-created VM (full name -> record), surfaced to the desktop
        # stepper via list_vms()/the SSE stream and GET /vms/{name}/provision. Created by create(),
        # advanced by list_vms() as the guest boots + turns healthy, dropped once complete or on
        # nuke. `_started_at`/`_done_at` are internal bookkeeping, stripped from the public view.
        self._provision: dict[str, dict] = {}
        self._provision_lock = threading.Lock()
        # The file locks coordinate CLI, MCP, and API processes. The in-process locks make the
        # critical sections re-entrant-safe and avoid relying on platform-specific flock behavior
        # between threads in one process.
        self._operation_locks = [threading.RLock() for _ in range(64)]

    @contextmanager
    def _locked_vms(self, *full_names: str):
        names = sorted(set(full_names))
        with ExitStack() as stack:
            digests = {name: hashlib.sha256(name.encode()).hexdigest() for name in names}
            # Acquire striped thread locks by stripe number, independent of VM-name ordering,
            # so hash collisions cannot invert lock order between multi-VM operations.
            for stripe in sorted({int(digest[:8], 16) % 64 for digest in digests.values()}):
                stack.enter_context(self._operation_locks[stripe])
            for name in names:
                digest = digests[name]
                stack.enter_context(state_lock(str(self._operation_lock_dir / digest)))
            yield

    def _state(self, full: str) -> str:
        return self.tart.get_config(full)["State"]

    def _fetch_config(self, full: str) -> dict | None:
        try:
            c = self.tart.get_config(full)
        except Exception:
            return None
        return {"cpu": c.get("CPU"), "memory_mb": c.get("Memory"), "disk_gb": c.get("Disk")}

    def suspend(self, name: str) -> None:
        full = ensure_mutable(name)
        with self._locked_vms(full):
            self.tart.suspend(full)
            self._forget_ip(full)
            self._leases.suspend(full)
            self._invalidate_fleet(full)

    def resume(self, name: str) -> None:
        full = fullname(name)
        ensure_mutable(name)
        with self._locked_vms(full):
            self._forget_ip(full)
            # Clear the intentional-suspend marker before probing the launch. A generic
            # launch failure puts it back; doing this afterwards would erase that diagnosis.
            self._leases.unsuspend(full)
            self._resume_or_coldboot(full, preserve_suspend_on_failure=True)
            self._invalidate_fleet(full)

    def _resume_or_coldboot(self, full: str, *, preserve_suspend_on_failure: bool) -> None:
        """Boot `full`, restoring its suspend state when possible.

        Probe the child synchronously so short-lived CLI/API workers cannot exit before restore
        recovery runs. Only Tart's known un-restorable VZ error triggers a cold boot; unrelated
        launch failures preserve the saved state for a later retry.
        """
        argv = self._run_argv(full)
        self._spawned = [p for p in self._spawned if p.poll() is None]
        child = _spawn_restore(argv) if self._spawn is _spawn else self._spawn(argv)
        if child is None:  # injected test spawn — nothing to watch
            return
        self._spawned.append(child)
        self._coldboot_if_restore_failed(
            full, argv, child, preserve_suspend_on_failure=preserve_suspend_on_failure
        )

    def _restore_ready(self, full: str, timeout: float) -> bool:
        """Probe guest readiness without using the normal IP cache or two-second status timeout."""
        try:
            deadline = self._monotonic() + timeout
            ip = self.tart.ip(full, timeout=timeout)
            if not ip:
                return False
            remaining = deadline - self._monotonic()
            if remaining <= 0:
                return False
            with urllib.request.urlopen(
                f"http://{ip}:{SERVER_PORT}/status", timeout=remaining
            ) as resp:
                return b"ok" in resp.read()
        except Exception:
            return False

    def _coldboot_if_restore_failed(
        self, full: str, argv: list[str], child: Any, *, preserve_suspend_on_failure: bool = True
    ) -> None:
        diagnostic = getattr(child, "_macfleet_diagnostic", None)

        def close_diagnostic() -> None:
            if diagnostic is not None:
                diagnostic.close()
                child._macfleet_diagnostic = None

        # Warm restores normally expose their guest status in a couple of seconds, so do not
        # impose the full slow-failure safety window on the common path. A failed status probe
        # drops the IP cache because DHCP may still replace a stale address from saved state.
        interval = 0.25
        health_interval = 1.0
        deadline = self._monotonic() + _RESTORE_PROBE_SECONDS
        next_health = self._monotonic() + health_interval
        while self._monotonic() < deadline:
            if child.poll() is not None:
                break
            now = self._monotonic()
            if now >= next_health:
                remaining = deadline - now
                if remaining <= 0:
                    break
                if self._restore_ready(full, min(interval, remaining)):
                    close_diagnostic()
                    return
                next_health = self._monotonic() + health_interval
            remaining = deadline - self._monotonic()
            if remaining > 0:
                self._sleep(min(interval, remaining))

        if child.poll() is None:
            close_diagnostic()
            return

        if (child.returncode or 0) == 0:
            close_diagnostic()
            return
        message = ""
        if diagnostic is not None:
            try:
                diagnostic.seek(0)
                message = diagnostic.read(64 * 1024).decode(errors="replace").lower()
            finally:
                diagnostic.close()
        # Never destroy saved state for a generic early launch failure. Only Tart's known VZ
        # restore signature proves that the state itself is unusable.
        if all(marker in message for marker in _RESTORE_FAILURE_MARKERS):
            try:
                self.tart.stop(full)  # drop the un-restorable saved state
            except RuntimeError:
                pass
            self._boot(argv)  # cold boot
        elif preserve_suspend_on_failure:
            # resume() optimistically cleared this marker when it launched Tart. Restore it when
            # the launch failed without consuming the saved state, so the UI remains truthful and
            # a later resume can retry.
            self._leases.suspend(full)
            self._invalidate_fleet(full)

    def suspend_all(self) -> list[str]:
        """Suspend every running fleet VM (mf-* except golden) — used by the desktop app on
        quit so the fleet freezes cleanly and resumes fast next launch. Best-effort: a hung
        or failing VM must not block the others. Returns the full names it suspended."""
        already = set(self._leases.suspended())
        targets = [v.name for v in self.tart.list()
                   if v.state == "running" and v.name != GOLDEN and v.name not in already]
        if not targets:
            return []

        def _suspend(full: str) -> str | None:
            try:
                with self._locked_vms(full):
                    self.tart.suspend(full)
                    self._forget_ip(full)
                    self._leases.suspend(full)
                    self._invalidate_fleet(full)
                return full
            except RuntimeError:
                return None

        # `tart suspend` is the slow part (writes VM memory to disk) — run it concurrently.
        with ThreadPoolExecutor(max_workers=min(8, len(targets))) as pool:
            done = [full for full in pool.map(_suspend, targets) if full]
        return done

    def _prov_init(self, full: str) -> None:
        steps = [{"key": k, "label": lbl, "status": "pending"} for k, lbl in _PROVISION_PHASES]
        with self._provision_lock:
            self._provision[full] = {"name": shortname(full), "steps": steps, "done": False,
                                     "error": None, "_started_at": self._clock(), "_done_at": None}

    def _prov_set(self, full: str, key: str, status: str) -> None:
        with self._provision_lock:
            rec = self._provision.get(full)
            if rec is None:
                return
            for step in rec["steps"]:
                if step["key"] == key:
                    step["status"] = status
                    break

    def _prov_error(self, full: str, msg: str) -> None:
        with self._provision_lock:
            rec = self._provision.get(full)
            if rec is None:
                return
            for step in rec["steps"]:
                if step["status"] == "active":
                    step["status"] = "error"
            rec["error"] = msg

    def _advance_provision(self, full: str, running: bool, healthy: bool) -> None:
        """Move a tracked create's boot/health steps forward from live tart state + guest health
        (both already computed by list_vms). A terminal (errored) record is left untouched."""
        with self._provision_lock:
            rec = self._provision.get(full)
            if rec is None or rec["error"]:
                return
            steps = {s["key"]: s for s in rec["steps"]}
            if healthy:
                steps["boot"]["status"] = "done"
                steps["health"]["status"] = "done"
                rec["done"] = True
                if rec["_done_at"] is None:
                    rec["_done_at"] = self._clock()
            elif running:
                steps["boot"]["status"] = "done"
                steps["health"]["status"] = "active"
            elif steps["boot"]["status"] == "pending":
                steps["boot"]["status"] = "active"

    def _prune_provision(self, live_fulls: set[str]) -> None:
        now = self._clock()
        with self._provision_lock:
            drop = [full for full, rec in self._provision.items()
                    if (rec["_done_at"] is not None and now - rec["_done_at"] >= _PROVISION_LINGER)
                    or (full not in live_fulls and now - rec["_started_at"] > _PROVISION_TTL)]
            for full in drop:
                self._provision.pop(full, None)

    @staticmethod
    def _public_prov(rec: dict) -> dict:
        # Strip the internal `_`-prefixed bookkeeping so it never leaks into the API/SSE payload.
        return {"name": rec["name"], "steps": [dict(s) for s in rec["steps"]],
                "done": rec["done"], "error": rec["error"]}

    def provisioning(self) -> dict[str, dict]:
        """Snapshot of every in-flight provisioning record, keyed by short name (SSE payload)."""
        with self._provision_lock:
            return {rec["name"]: self._public_prov(rec) for rec in self._provision.values()}

    def provision(self, name: str) -> dict | None:
        with self._provision_lock:
            rec = self._provision.get(fullname(name))
            return self._public_prov(rec) if rec is not None else None

    def create(self, name: str, from_snapshot: str | None = None,
               ttl: float | None = None, cpu: int | None = None,
               memory: int | None = None, disk: int | None = None) -> None:
        target = ensure_mutable(name)
        validate_name(name)
        # Lock the destination only: clones from the same golden/snapshot source are safe to run
        # concurrently and fleet spin-up should not serialize on a shared read-only source.
        with self._locked_vms(target):
            self._create_unlocked(name, from_snapshot=from_snapshot, ttl=ttl, cpu=cpu,
                                  memory=memory, disk=disk)

    def _create_unlocked(self, name: str, from_snapshot: str | None = None,
                         ttl: float | None = None, cpu: int | None = None,
                         memory: int | None = None, disk: int | None = None) -> None:
        target = ensure_mutable(name)
        # One `tart list`, reused for both the reclaim check and the existence check.
        # Deliberately NOT a full self.reap(): reaping every expired lease here would make
        # an unrelated expired VM's (slow) graceful stop block this create. The API's
        # background reap loop and list_vms() sweep those; create only needs to reclaim the
        # ONE name it's about to take if a lease on it already expired.
        inventory = {v.name: v for v in self.tart.list()}
        existing = set(inventory)
        if target in existing and target in set(self._leases.expired(self._clock())):
            try:
                self._nuke_unlocked(shortname(target))
            except RuntimeError:
                # Preserve the lease so the background reaper retries. Do not pretend the name
                # is free: clone cleanup must never delete a target we failed to reclaim.
                raise RuntimeError(f"expired VM {shortname(target)} could not be reclaimed") from None
            existing.discard(target)
            inventory.pop(target, None)
        # Init after the reclaim above (whose nuke would otherwise drop a fresh record).
        self._prov_init(target)
        cloned = target not in existing
        if cloned:
            src = f"mfsnap-{from_snapshot}" if from_snapshot else "mf-golden"
            try:
                self._prov_set(target, "clone", "active")
                self.tart.clone(src, target)
                self._prov_set(target, "clone", "done")
                # Resources can only be set on a stopped VM, and only a freshly-cloned one is
                # stopped here. `tart set --disk-size` is grow-only, so pass it through only
                # when it grows the clone's disk.
                disk_size = disk
                if disk is not None and disk <= self.tart.get_config(target)["Disk"]:
                    disk_size = None
                if cpu is not None or memory is not None or disk_size is not None:
                    self._prov_set(target, "configure", "active")
                    self.tart.set_config(target, cpu=cpu, memory=memory, disk_size=disk_size)
                    self._prov_set(target, "configure", "done")
                else:
                    self._prov_set(target, "configure", "skipped")
            except Exception as exc:
                # Do not leave a partial stopped clone behind: a retry would otherwise see
                # it as pre-existing, skip the requested resources, and boot wrong settings.
                self._prov_error(target, str(exc))
                try:
                    self.tart.delete(target)
                except RuntimeError:
                    pass
                raise
            self._res_cache.pop(target, None)
        else:
            self._prov_set(target, "clone", "skipped")
            self._prov_set(target, "configure", "skipped")
        existing_vm = inventory.get(target)
        if existing_vm is None or existing_vm.state != "running":
            # A clone inherits its source's saved-state shape. Existing stopped VMs still use the
            # guarded probe, but generic failures only restore a suspend marker for actual saved
            # state rather than for an ordinary cold launch.
            source_name = f"mfsnap-{from_snapshot}" if from_snapshot else GOLDEN
            source = inventory.get(source_name)
            restoring_saved_state = (
                existing_vm.state == "suspended" if existing_vm is not None
                else source is not None and source.state == "suspended"
            )
            self._resume_or_coldboot(
                target, preserve_suspend_on_failure=restoring_saved_state
            )
        self._prov_set(target, "boot", "active")
        if ttl is not None:
            self._leases.record(target, ttl)
        self._invalidate_fleet(target)

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
        self._boot(self._run_argv(GOLDEN))
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
        reaped = []
        for full in self._leases.expired(now):
            with self._locked_vms(full):
                # Candidate discovery happened before this potentially-contended lock. Renewals
                # and name reuse must win over the stale candidate rather than losing a fresh VM.
                if not self._leases.is_expired(full, now):
                    continue
                live_names = {v.name for v in self.tart.list()}
                if full in live_names:
                    try:
                        self._nuke_unlocked(shortname(full))
                    except RuntimeError:
                        # A transient stop/delete error must not turn a leased VM into a permanent
                        # orphan. Keep the lease so the next sweep retries it.
                        continue
                else:
                    self._leases.drop(full)
                reaped.append(full)
        return reaped

    def list_vms(self) -> list[dict]:
        now = time.monotonic()
        with self._cache_lock:
            if self._fleet_cache is not None and now < self._fleet_cache[0]:
                return [dict(vm) for vm in self._fleet_cache[1]]
        vms = self.tart.list()
        reaped = set(self.reap(existing=vms))
        vms = [v for v in vms if v.name not in reaped]
        live_names = {v.name for v in vms}
        # The desktop API is long-lived while CLI/MCP clients can mutate Tart in separate
        # processes. Drop entries for names that disappeared so an externally recreated VM
        # cannot inherit stale IP, token, health, or resource data.
        for cache in (self._res_cache, self._res_cache_at, self._ip_cache,
                      self._control_tokens, self._control_token_ips, self._health_cache):
            for stale in set(cache) - live_names:
                cache.pop(stale, None)
        # Health-check running VMs concurrently — each check is a network round-trip to
        # the guest, so doing them sequentially made /vms scale with fleet size and stall
        # under screenshot load. Parallel keeps the list responsive.
        running = [v for v in vms if v.state == "running"]
        health: dict[str, bool] = {}
        to_probe: list[VmInfo] = []
        for vm in running:
            cached = self._health_cache.get(vm.name)
            if cached is not None and now < cached[0]:
                health[vm.name] = cached[1]
            else:
                to_probe.append(vm)
        uncached = [v for v in vms if v.name not in self._res_cache
                    or now - self._res_cache_at.get(v.name, 0.0) >= _RESOURCE_CACHE_TTL]
        if to_probe or uncached:
            with ThreadPoolExecutor(max_workers=min(8, len(vms))) as pool:
                if to_probe:
                    probed = dict(
                        pool.map(lambda v: (v.name, self.status(shortname(v.name))), to_probe)
                    )
                    health.update(probed)
                    for full, healthy in probed.items():
                        # Booting/unhealthy guests are retried quickly; healthy guests need
                        # only a five-second liveness check.
                        self._health_cache[full] = (now + (5.0 if healthy else 1.0), healthy)
                for name, res in pool.map(lambda v: (v.name, self._fetch_config(v.name)), uncached):
                    if res is not None:
                        self._res_cache[name] = res
                        self._res_cache_at[name] = now
        suspended = self._leases.suspended()
        expiries = self._leases.expiries()
        result = [{"name": v.name,
                   "state": "suspended" if (v.name in suspended and v.state == "running") else v.state,
                   "source": v.source, "healthy": health.get(v.name, False),
                   **({"lease_expires_at": expiries[v.name]} if v.name in expiries else {}),
                   **self._res_cache.get(v.name, {"cpu": None, "memory_mb": None, "disk_gb": None})}
                  for v in vms]
        # Advance any in-flight create steppers from the state/health just computed, then sweep
        # completed/stale ones. Cheap: reuses `health`, adds no tart/guest calls.
        with self._provision_lock:
            tracked = list(self._provision.keys())
        if tracked:
            states = {v.name: v.state for v in vms}
            for full in tracked:
                self._advance_provision(full, states.get(full) == "running",
                                        bool(health.get(full, False)))
            self._prune_provision(set(states))
        with self._cache_lock:
            self._fleet_cache = (now + 1.0, [dict(vm) for vm in result])
        return result

    def down(self, name: str) -> None:
        full = ensure_mutable(name)
        with self._locked_vms(full):
            self.tart.stop(full)
            self._forget_ip(full)
            self._leases.unsuspend(full)
            self._invalidate_fleet(full)

    def restart(self, name: str) -> None:
        """Stop mf-<name> and boot it again — the way to apply a shared-folder change to a
        running VM (shares only take effect on `tart run`)."""
        ensure_mutable(name)
        full = fullname(name)
        with self._locked_vms(full):
            try:
                self.tart.stop(full)
            except RuntimeError:
                pass
            self._forget_ip(full)
            self._leases.unsuspend(full)
            self._boot(self._run_argv(full))
            self._invalidate_fleet(full)

    def nuke(self, name: str) -> None:
        full = ensure_mutable(name)
        with self._locked_vms(full):
            self._nuke_unlocked(name)

    def _nuke_unlocked(self, name: str) -> None:
        full = ensure_mutable(name)
        try:
            self.tart.stop(full)
        except RuntimeError:
            pass
        self.tart.delete(full)
        self._res_cache.pop(full, None)
        self._res_cache_at.pop(full, None)
        self._forget_ip(full)
        self._leases.unsuspend(full)
        self._leases.drop(full)
        self._shares.drop(full)
        with self._provision_lock:
            self._provision.pop(full, None)
        self._invalidate_fleet(full)

    def ip(self, name: str) -> str:
        full = fullname(name)
        cached = self._ip_cache.get(full)
        now = time.monotonic()
        if cached and now < cached[0]:
            return cached[1]
        ip = self.tart.ip(full)
        if not ip:
            # `tart ip` exits 0 with empty output while the guest network is still coming up.
            # Returning "" would silently build `admin@` / `http://:8000` URLs that fail with
            # a baffling error; raise a clear one instead so callers (and the API 409) say why.
            raise RuntimeError(f"{shortname(full)} has no IP yet — is it running?")
        self._ip_cache[full] = (now + _IP_CACHE_TTL, ip)
        return ip

    def _forget_ip(self, full: str) -> None:
        self._ip_cache.pop(full, None)
        self._control_tokens.pop(full, None)
        self._control_token_ips.pop(full, None)

    def _invalidate_fleet(self, full: str | None = None) -> None:
        with self._cache_lock:
            self._fleet_cache = None
            if full is not None:
                self._health_cache.pop(full, None)

    def _boot(self, argv: list[str]) -> None:
        """Background a `tart run` through the injected spawn and track the child so its
        zombie is reaped when the VM later stops. poll() reaps any that have exited since the
        last boot; injected test spawns return None and are simply not tracked."""
        self._spawned = [p for p in self._spawned if p.poll() is None]
        child = self._spawn(argv)
        if child is not None:
            self._spawned.append(child)

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
        full = fullname(name)
        with self._locked_vms(full):
            self._shares.set(full, normalized)

    def ssh(self, name: str, remote_cmd: str, retries: int = 3, backoff: float = 2.0,
            sleep: Callable[[float], None] = time.sleep) -> str:
        # Right after `up`, the guest is `running` but SSH is not yet answering for ~30s (see
        # README). Retry ONLY connection-level failures (ssh exits 255) — a nonzero exit from
        # the remote command itself is a real result and must surface immediately, not after
        # three slow retries. Re-resolve the IP between tries in case it changed on reboot.
        ensure_mutable(name)
        for attempt in range(retries):
            try:
                return self._run(ssh_cmd(self.ip(name), remote_cmd)).stdout
            except RuntimeError as exc:
                transient = any(s in str(exc).lower() for s in _SSH_TRANSIENT)
                if not transient or attempt + 1 >= retries:
                    raise
                self._forget_ip(fullname(name))
                sleep(backoff)
        raise RuntimeError("unreachable")  # loop either returns or raises

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

    def logs(self, name: str, lines: int = 100, cursor: int | None = None) -> dict:
        # Served by the persistent guest gateway: no SSH process/handshake and subsequent
        # polls transfer only bytes appended after the returned cursor.
        count = min(max(int(lines), 1), 5_000)
        return self._guest_client(name).logs(count, cursor)

    def snapshot(self, name: str, label: str) -> str:
        src = ensure_mutable(name)
        validate_label(label)
        sid = f"mfsnap-{shortname(name)}-{label}"
        with self._locked_vms(src, sid):
            listed = self.tart.list()
            if sid in {v.name for v in listed}:
                raise RuntimeError(f"snapshot {shortname(name)}-{label} already exists")
            source = next((v for v in listed if v.name == src), None)
            source_state = source.state if source is not None else self._state(src)
            was_suspended = src in self._leases.suspended() or source_state == "suspended"
            was_running = source_state == "running" and not was_suspended
            source_has_saved_state = was_suspended
            if was_running:
                try:
                    self.tart.suspend(src)
                    source_has_saved_state = True
                except RuntimeError:
                    self.tart.stop(src)  # clean-disk fallback if the image can't suspend
            try:
                self.tart.clone(src, sid)
            finally:
                # A failed clone must not turn a snapshot attempt into an outage.
                if was_running:
                    self._leases.unsuspend(src)
                    self._resume_or_coldboot(
                        src, preserve_suspend_on_failure=source_has_saved_state
                    )  # resume original
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
        full = f"mfsnap-{snapshot_id}"
        with self._locked_vms(full):
            self.tart.delete(full)

    def computer(self, name: str) -> GuestControl:
        if os.environ.get("MACFLEET_ALLOW_CONTROL") != "1":
            raise RuntimeError(
                "computer-use disabled — set MACFLEET_ALLOW_CONTROL=1 (VM-only)."
            )
        return self._guest_client(name)

    def _guest_client(self, name: str) -> GuestControl:
        full = ensure_mutable(name)
        ip = self.ip(name)
        token = self._control_tokens.get(full)
        if token is None or self._control_token_ips.get(full) != ip:
            token = self.ssh(name, "cat ~/.macfleet-control-token").strip()
            if not token:
                raise RuntimeError(
                    "guest control token unavailable — re-bake the golden image"
                )
            self._control_tokens[full] = token
            self._control_token_ips[full] = ip
        return GuestControl(f"http://{ip}:{SERVER_PORT}", token=token)

    def rename(self, old: str, new: str) -> None:
        old_full = ensure_mutable(old)
        new_full = ensure_mutable(new)
        validate_name(new)
        with self._locked_vms(old_full, new_full):
            self.tart.rename(old_full, new_full)
            self._res_cache.pop(old_full, None)
            self._res_cache_at.pop(old_full, None)
            self._forget_ip(old_full)
            self._leases.rename(old_full, new_full)
            self._shares.rename(old_full, new_full)
            self._invalidate_fleet(old_full)

    def duplicate(self, name: str, new: str) -> None:
        src = ensure_mutable(name)
        dst = ensure_mutable(new)
        validate_name(new)
        with self._locked_vms(src, dst):
            listed = self.tart.list()
            source = next((v for v in listed if v.name == src), None)
            source_state = source.state if source is not None else self._state(src)
            was_suspended = src in self._leases.suspended() or source_state == "suspended"
            was_running = source_state == "running" and not was_suspended
            source_has_saved_state = was_suspended
            if was_running:
                try:
                    self.tart.suspend(src)
                    source_has_saved_state = True
                except RuntimeError:
                    self.tart.stop(src)
            try:
                self.tart.clone(src, dst)
            finally:
                # Always restore a source that this operation suspended/stopped, including
                # when cloning fails.
                if was_running:
                    self._leases.unsuspend(src)
                    self._resume_or_coldboot(
                        src, preserve_suspend_on_failure=source_has_saved_state
                    )
            # Desktop duplicate semantics are "create and boot a copy" for both running and
            # stopped sources; otherwise the optimistic row waits forever for a stopped clone.
            self._resume_or_coldboot(
                dst, preserve_suspend_on_failure=source_has_saved_state
            )
            self._invalidate_fleet(src)
            self._invalidate_fleet(dst)

    def restore(self, name: str, snapshot_id: str) -> None:
        """Restore mf-<name> to a snapshot using a staged clone and rollback-safe name swap.
        The previous VM is retained under a temporary backup name until the replacement is
        installed, then removed. Works when the VM no longer exists (recreate)."""
        target = ensure_mutable(name)
        validate_name(name)
        snap = f"mfsnap-{snapshot_id}"
        with self._locked_vms(target, snap):
            self._restore_unlocked(name, snapshot_id)

    def _restore_unlocked(self, name: str, snapshot_id: str) -> None:
        target = ensure_mutable(name)
        snap = f"mfsnap-{snapshot_id}"
        vms = self.tart.list()
        names = {v.name for v in vms}
        target_was_running = (
            target not in self._leases.suspended()
            and any(v.name == target and v.state == "running" for v in vms)
        )
        if snap not in names:
            raise RuntimeError(f"snapshot {snapshot_id} not found")
        nonce = uuid.uuid4().hex
        staged = f"mftmp-{nonce}"
        backup = f"mfbackup-{nonce}"
        moved_old = False
        staged_exists = False
        try:
            # Validate the entire snapshot copy before touching the current VM.
            self.tart.clone(snap, staged)
            staged_exists = True
            try:
                if target in names:
                    try:
                        self.tart.stop(target)
                    except RuntimeError:
                        pass
                    self.tart.rename(target, backup)
                    moved_old = True
                try:
                    self.tart.rename(staged, target)
                    staged_exists = False
                except Exception:
                    if moved_old:
                        self.tart.rename(backup, target)
                        moved_old = False
                    raise
            except Exception:
                if target_was_running:
                    self._boot(self._run_argv(target))
                raise
        finally:
            if staged_exists:
                try:
                    self.tart.delete(staged)
                except RuntimeError:
                    pass
        if moved_old:
            try:
                self.tart.delete(backup)
            except RuntimeError:
                # The restore succeeded; a stale backup is safer than deleting user data.
                pass
        self._res_cache.pop(target, None)
        self._res_cache_at.pop(target, None)
        self._forget_ip(target)
        self._leases.unsuspend(target)
        snapshot = next(v for v in vms if v.name == snap)
        self._resume_or_coldboot(
            target, preserve_suspend_on_failure=snapshot.state == "suspended"
        )
        self._invalidate_fleet(target)

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
        full = ensure_mutable(name)
        with self._locked_vms(full):
            current = self.resources(name)
            if current["state"] == "running":
                raise RuntimeError("stop the VM before changing resources")
            if disk_size is not None and disk_size <= current["disk_gb"]:
                disk_size = None  # tart set --disk-size is grow-only
            self.tart.set_config(full, cpu=cpu, memory=memory,
                                 disk_size=disk_size, display=display)
            self._res_cache.pop(full, None)
            self._res_cache_at.pop(full, None)
            self._invalidate_fleet(full)

    def connection_info(self, name: str) -> dict:
        ip = self.ip(name)
        return {"ip": ip, "ssh": f"ssh {GUEST_USER}@{ip}",
                "vnc": f"open vnc://{GUEST_USER}@{ip}",
                "guest_server": f"http://{ip}:{SERVER_PORT}", "exec": True}

    def exec(self, name: str, command: str) -> dict:
        ensure_mutable(name)
        proc = self._run_nocheck(["tart", "exec", fullname(name), "/bin/sh", "-lc", command])
        return {"stdout": proc.stdout, "stderr": proc.stderr, "exit_code": proc.returncode}

    def metrics(self, name: str) -> dict:
        return self._guest_client(name).metrics()

    def activity_recent(self, limit: int = 20) -> list[dict]:
        return self.activity.recent(limit)
