from __future__ import annotations

import json
import os
import tempfile
import time
from collections.abc import Callable


def default_state_path() -> str:
    return os.path.expanduser("~/.macfleet/state.json")


class Leases:
    """TTL leases for fleet VMs, persisted as JSON. A missing or corrupt file reads as
    empty. Writes are atomic (temp file + rename)."""

    def __init__(self, path: str, clock: Callable[[], float] = time.time) -> None:
        self._path = path
        self._clock = clock

    def _load(self) -> dict:
        try:
            with open(self._path) as fh:
                data = json.load(fh)
            return data.get("leases", {}) if isinstance(data, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

    def _save(self, leases: dict) -> None:
        d = os.path.dirname(self._path)
        if d:
            os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d or ".")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump({"leases": leases}, fh)
            os.replace(tmp, self._path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def record(self, name: str, ttl: float, source: str = "api") -> None:
        leases = self._load()
        now = self._clock()
        leases[name] = {"expires_at": now + ttl, "created_at": now, "source": source}
        self._save(leases)

    def expired(self, now: float) -> list[str]:
        result = []
        for n, lease in self._load().items():
            expires_at = lease.get("expires_at")
            if expires_at is not None and expires_at < now:
                result.append(n)
        return result

    def drop(self, name: str) -> None:
        leases = self._load()
        if leases.pop(name, None) is not None:
            self._save(leases)

    def rename(self, old: str, new: str) -> None:
        leases = self._load()
        if old in leases:
            leases[new] = leases.pop(old)
            self._save(leases)
