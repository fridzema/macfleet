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


def fullname(name: str) -> str:
    return name if name.startswith("mf-") else f"mf-{name}"


def shortname(name: str) -> str:
    return name[len("mf-"):] if name.startswith("mf-") else name


@dataclass(frozen=True)
class VmInfo:
    name: str
    state: str
    source: str


class Tart:
    def __init__(self, run: Runner = _run) -> None:
        self._run = run

    def list(self) -> list[VmInfo]:
        out = self._run(["tart", "list", "--format", "json"]).stdout
        return [VmInfo(v["Name"], v["State"], v.get("Source", "")) for v in json.loads(out)]

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
