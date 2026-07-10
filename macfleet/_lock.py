from __future__ import annotations

import contextlib
import fcntl
import os
from collections.abc import Iterator


@contextlib.contextmanager
def state_lock(path: str) -> Iterator[None]:
    """Exclusive advisory lock on `<path>.lock`, held across a read-modify-write of a JSON
    state file. flock is tied to the open file description, so it serializes contenders both
    within one process (the API's request threadpool + its background reap loop) and across
    processes (the MCP writer vs the API vs the CLI). Without it, two `load -> modify -> save`
    cycles interleave and the later `os.replace` silently drops the other's change — a lost
    lease leaks a VM past its TTL, a lost `suspended` entry mis-renders a VM's state. The
    atomic temp-file rename in each `_save` prevents torn *reads*; this prevents lost *writes*.
    Best-effort: if the lock file can't be created, run unlocked rather than block a fleet op."""
    lockpath = f"{path}.lock"
    d = os.path.dirname(lockpath)
    try:
        if d:
            os.makedirs(d, exist_ok=True)
        fd = os.open(lockpath, os.O_CREAT | os.O_RDWR, 0o600)
    except OSError:
        yield
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
