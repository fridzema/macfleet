from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from dataclasses import dataclass

Runner = Callable[[list[str]], "subprocess.CompletedProcess[str]"]


def _run(argv: list[str]) -> "subprocess.CompletedProcess[str]":
    proc = subprocess.run(argv, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(argv)} failed: {proc.stderr.strip()}")
    return proc


def _run_nocheck(argv: list[str]) -> "subprocess.CompletedProcess[str]":
    # Like _run but never raises — used for `tart exec`, where a nonzero exit is the
    # guest command's result, not a tart failure.
    return subprocess.run(argv, capture_output=True, text=True, check=False)


def fullname(name: str) -> str:
    return name if name.startswith("mf-") else f"mf-{name}"


def shortname(name: str) -> str:
    return name[len("mf-"):] if name.startswith("mf-") else name


@dataclass(frozen=True)
class VmInfo:
    name: str
    state: str
    source: str
    size: float = 0.0


class Tart:
    def __init__(self, run: Runner = _run) -> None:
        self._run = run

    def list(self) -> list[VmInfo]:
        out = self._run(["tart", "list", "--format", "json"]).stdout
        return [
            VmInfo(v["Name"], v["State"], v.get("Source", ""), float(v.get("Size", 0) or 0))
            for v in json.loads(out)
        ]

    def clone(self, src: str, dst: str) -> None:
        self._run(["tart", "clone", src, dst])

    def start(self, name: str) -> None:
        # `tart run` blocks; callers background it (see connect.start_vm).
        self._run(["tart", "run", name, "--no-graphics"])

    def ip(self, name: str) -> str:
        return self._run(["tart", "ip", name]).stdout.strip()

    def stop(self, name: str) -> None:
        self._run(["tart", "stop", name])

    def delete(self, name: str) -> None:
        self._run(["tart", "delete", name])

    def suspend(self, name: str) -> None:
        self._run(["tart", "suspend", name])

    def rename(self, old: str, new: str) -> None:
        self._run(["tart", "rename", old, new])

    def get_config(self, name: str) -> dict:
        return json.loads(self._run(["tart", "get", name, "--format", "json"]).stdout)

    def set_config(self, name: str, *, cpu: int | None = None, memory: int | None = None,
                   disk_size: int | None = None, display: str | None = None) -> None:
        argv = ["tart", "set", name]
        for value, flag in ((cpu, "--cpu"), (memory, "--memory"),
                            (disk_size, "--disk-size"), (display, "--display")):
            if value is not None:
                argv += [flag, str(value)]
        self._run(argv)
