from __future__ import annotations

import json
import os
import tempfile
import time
from collections.abc import Callable

from macfleet._lock import state_lock


def default_state_path() -> str:
    return os.path.expanduser("~/.macfleet/state.json")


class Leases:
    """TTL leases for fleet VMs, persisted as JSON. A missing or corrupt file reads as
    empty. Writes are atomic (temp file + rename)."""

    def __init__(self, path: str, clock: Callable[[], float] = time.time) -> None:
        self._path = path
        self._clock = clock

    def _load_doc(self) -> dict:
        try:
            with open(self._path) as fh:
                data = json.load(fh)
            if not isinstance(data, dict):
                data = {}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            data = {}
        data.setdefault("leases", {})
        data.setdefault("suspended", [])
        return data

    def _save_doc(self, doc: dict) -> None:
        d = os.path.dirname(self._path)
        if d:
            os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d or ".")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump({"leases": doc["leases"], "suspended": doc["suspended"]}, fh)
            os.replace(tmp, self._path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def record(self, name: str, ttl: float, source: str = "api") -> None:
        with state_lock(self._path):
            doc = self._load_doc()
            now = self._clock()
            doc["leases"][name] = {"expires_at": now + ttl, "created_at": now, "source": source}
            self._save_doc(doc)

    def expired(self, now: float) -> list[str]:
        result = []
        for n, lease in self._load_doc()["leases"].items():
            expires_at = lease.get("expires_at")
            if expires_at is not None and expires_at < now:
                result.append(n)
        return result

    def drop(self, name: str) -> None:
        with state_lock(self._path):
            doc = self._load_doc()
            if doc["leases"].pop(name, None) is not None:
                self._save_doc(doc)

    def rename(self, old: str, new: str) -> None:
        with state_lock(self._path):
            doc = self._load_doc()
            changed = False
            if old in doc["leases"]:
                doc["leases"][new] = doc["leases"].pop(old)
                changed = True
            if old in doc["suspended"]:
                doc["suspended"] = [new if x == old else x for x in doc["suspended"]]
                changed = True
            if changed:
                self._save_doc(doc)

    def suspend(self, name: str) -> None:
        with state_lock(self._path):
            doc = self._load_doc()
            if name not in doc["suspended"]:
                doc["suspended"].append(name)
                self._save_doc(doc)

    def unsuspend(self, name: str) -> None:
        with state_lock(self._path):
            doc = self._load_doc()
            if name in doc["suspended"]:
                doc["suspended"].remove(name)
                self._save_doc(doc)

    def suspended(self) -> set[str]:
        return set(self._load_doc()["suspended"])
