from __future__ import annotations

import json
import os
import re
import select
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass

Runner = Callable[[list[str]], "subprocess.CompletedProcess[str]"]

# Hard ceiling on any tart/ssh/scp shell-out. Without it a hung child (`tart exec sleep 999`,
# a wedged guest, an interactive prompt on stdin) blocks its caller forever; under the API
# that permanently consumes a FastAPI threadpool worker, and a handful wedge the whole engine.
# Generous so legitimately slow ops (memory-heavy `tart suspend`, a long `exec` build) aren't
# killed, but bounded so a true hang always releases. subprocess.run kills the child on expiry.
SUBPROCESS_TIMEOUT = 300.0

# Cap on captured stdout for the arbitrary-command path (`tart exec`). A guest command like
# `cat /dev/zero` or `yes` produces output faster than the timeout can stop it, and
# subprocess.run buffers it all into engine memory — an OOM. _run_nocheck reads with a byte
# ceiling and kills the child once it is hit; the metadata path (`_run`) has bounded output.
MAX_OUTPUT_BYTES = 16 * 1024 * 1024


def _run(argv: list[str], timeout: float = SUBPROCESS_TIMEOUT) -> "subprocess.CompletedProcess[str]":
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"{' '.join(argv)} timed out after {timeout:.0f}s") from exc
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(argv)} failed: {proc.stderr.strip()}")
    return proc


def _run_nocheck(argv: list[str], timeout: float = SUBPROCESS_TIMEOUT,
                 max_bytes: int = MAX_OUTPUT_BYTES) -> "subprocess.CompletedProcess[str]":
    # Like _run but never raises on a nonzero exit — used for `tart exec`, where a nonzero exit
    # is the guest command's result, not a tart failure. Reads via Popen + select so it can BOTH
    # bound runtime (a hang can't pin a worker) and cap captured stdout (a firehose can't OOM the
    # engine). A timeout is a genuine failure and raises RuntimeError, matching _run.
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out = bytearray()
    err = bytearray()
    bufs = {proc.stdout.fileno(): out, proc.stderr.fileno(): err}  # type: ignore[union-attr]
    open_fds = set(bufs)
    deadline = time.monotonic() + timeout
    try:
        while open_fds:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                proc.kill()
                raise subprocess.TimeoutExpired(argv, timeout)
            ready, _, _ = select.select(list(open_fds), [], [], remaining)
            for fd in ready:
                chunk = os.read(fd, 65536)
                if not chunk:
                    open_fds.discard(fd)
                    continue
                buf = bufs[fd]
                if buf is out and len(out) >= max_bytes:
                    # stdout ceiling hit — stop and kill rather than drain (and so wait out) a
                    # firehose like `yes`. The captured prefix is returned; exit is the kill.
                    proc.kill()
                    open_fds.clear()
                    break
                buf.extend(chunk)
        proc.wait()
    except subprocess.TimeoutExpired as exc:
        proc.wait()
        raise RuntimeError(f"{' '.join(argv)} timed out after {timeout:.0f}s") from exc
    finally:
        proc.stdout.close()  # type: ignore[union-attr]
        proc.stderr.close()  # type: ignore[union-attr]
    return subprocess.CompletedProcess(
        argv, proc.returncode, out.decode(errors="replace"), err.decode(errors="replace"))


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
