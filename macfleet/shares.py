from __future__ import annotations

import json
import os
import tempfile


def default_shares_path() -> str:
    return os.path.expanduser("~/.macfleet/shares.json")


class Shares:
    """Per-VM host->guest folder shares, persisted as JSON keyed by full VM name. Each
    share is {tag, host_path, read_only}. A missing or corrupt file reads as empty; writes
    are atomic (temp file + rename), matching leases.py."""

    def __init__(self, path: str) -> None:
        self._path = path

    def _load(self) -> dict[str, list[dict]]:
        try:
            with open(self._path) as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

    def _save(self, doc: dict[str, list[dict]]) -> None:
        d = os.path.dirname(self._path)
        if d:
            os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d or ".")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(doc, fh)
            os.replace(tmp, self._path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def get(self, name: str) -> list[dict]:
        return self._load().get(name, [])

    def set(self, name: str, shares: list[dict]) -> None:
        doc = self._load()
        if shares:
            doc[name] = shares
        else:
            doc.pop(name, None)
        self._save(doc)

    def drop(self, name: str) -> None:
        doc = self._load()
        if doc.pop(name, None) is not None:
            self._save(doc)

    def rename(self, old: str, new: str) -> None:
        doc = self._load()
        if old in doc:
            doc[new] = doc.pop(old)
            self._save(doc)
