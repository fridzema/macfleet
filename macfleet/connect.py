from __future__ import annotations

import os
import subprocess
import urllib.request
from typing import Any

from macfleet.vm import Runner, Tart, _run, fullname

GUEST_USER = "admin"
SERVER_PORT = 8000
SSH_OPTS = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
]


def ssh_cmd(ip: str, remote_cmd: str) -> list[str]:
    return ["ssh", *SSH_OPTS, f"{GUEST_USER}@{ip}", remote_cmd]


def scp_push_cmd(ip: str, local: str, remote: str) -> list[str]:
    return ["scp", *SSH_OPTS, local, f"{GUEST_USER}@{ip}:{remote}"]


def scp_pull_cmd(ip: str, remote: str, local: str) -> list[str]:
    return ["scp", *SSH_OPTS, f"{GUEST_USER}@{ip}:{remote}", local]


class Fleet:
    def __init__(self, tart: Tart | None = None, run: Runner = _run) -> None:
        self.tart = tart or Tart(run=run)
        self._run = run

    def up(self, name: str) -> None:
        target = fullname(name)
        existing = {v.name for v in self.tart.list()}
        if target not in existing:
            self.tart.clone("mf-golden", target)
        # background `tart run` so it doesn't block the caller
        subprocess.Popen(["tart", "run", target, "--no-graphics"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

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
        try:
            with urllib.request.urlopen(
                f"http://{self.ip(name)}:{SERVER_PORT}/status", timeout=4
            ) as resp:
                return b"ok" in resp.read()
        except Exception:
            return False

    def computer(self, name: str) -> Any:
        if os.environ.get("MACFLEET_ALLOW_CONTROL") != "1":
            raise RuntimeError(
                "computer-use disabled — set MACFLEET_ALLOW_CONTROL=1 (VM-only)."
            )
        from computer import Computer  # lazy: only when [control] extra installed

        return Computer(os_type="macos", host=self.ip(name), port=SERVER_PORT)
