from __future__ import annotations

import json
import re
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


GOLDEN = "mf-golden"

# VM names must be safe as a URL path segment and a tart argument. Labels additionally
# forbid '-' so the `mfsnap-<vm>-<label>` scheme parses unambiguously even when the VM
# name itself contains hyphens (see Fleet.snapshots, which splits on the last '-').
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._]{0,63}$")


def ensure_mutable(name: str) -> str:
    """Resolve `name` to its full mf- form and reject the protected golden template.
    Golden is the read-only clone source for every VM; deleting, renaming, or otherwise
    mutating it would break all future creates, so no fleet op may target it."""
    full = fullname(name)
    if full == GOLDEN:
        raise RuntimeError(f"{GOLDEN} is the protected template and cannot be modified or deleted")
    return full


def validate_name(name: str) -> str:
    """Reject VM names not usable as a URL path segment / tart argument. Accepts the short
    or mf- form; validates (and returns) the short form. Applied when a name is created."""
    short = shortname(name)
    if not _NAME_RE.fullmatch(short):
        raise RuntimeError(
            f"invalid VM name {short!r}: use letters, digits, '.', '_', '-' (max 64 chars)"
        )
    return short


def validate_label(label: str) -> str:
    """Reject snapshot labels containing anything but letters, digits, '.', '_' (notably no
    '-'), keeping the snapshot id delimiter unambiguous."""
    if not _LABEL_RE.fullmatch(label):
        raise RuntimeError(
            f"invalid snapshot label {label!r}: use letters, digits, '.', '_' (max 64 chars)"
        )
    return label


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
