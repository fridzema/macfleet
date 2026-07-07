from __future__ import annotations

import base64
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from macfleet.leases import Leases, default_state_path
from macfleet.vm import Runner, Tart, _run, _run_nocheck, fullname, shortname

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
                 clock: Callable[[], float] = time.time) -> None:
        self.tart = tart or Tart(run=run)
        self._run = run
        self._spawn = spawn
        self._run_nocheck = run_nocheck
        self._leases = leases or Leases(default_state_path())
        self._clock = clock

    def _state(self, full: str) -> str:
        return self.tart.get_config(full)["State"]

    def suspend(self, name: str) -> None:
        self.tart.suspend(fullname(name))

    def resume(self, name: str) -> None:
        self._spawn(["tart", "run", fullname(name), "--no-graphics"])

    def create(self, name: str, from_snapshot: str | None = None,
               ttl: float | None = None) -> None:
        self.reap()
        target = fullname(name)
        if target not in {v.name for v in self.tart.list()}:
            src = f"mfsnap-{from_snapshot}" if from_snapshot else "mf-golden"
            self.tart.clone(src, target)
        # background `tart run` so it doesn't block the caller
        self._spawn(["tart", "run", target, "--no-graphics"])
        if ttl is not None:
            self._leases.record(target, ttl)

    def up(self, name: str) -> None:
        self.create(name)

    def reap(self) -> list[str]:
        now = self._clock()
        existing = {v.name for v in self.tart.list()}
        reaped = []
        for full in self._leases.expired(now):
            if full in existing:
                try:
                    self.nuke(shortname(full))
                except RuntimeError:
                    pass
            self._leases.drop(full)
            reaped.append(full)
        return reaped

    def down(self, name: str) -> None:
        self.tart.stop(fullname(name))

    def nuke(self, name: str) -> None:
        try:
            self.tart.stop(fullname(name))
        except RuntimeError:
            pass
        self.tart.delete(fullname(name))

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
