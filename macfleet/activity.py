from __future__ import annotations

import json
import os
import tempfile
import time
from collections.abc import Callable


def default_activity_path() -> str:
    return os.path.expanduser("~/.macfleet/activity.jsonl")


class Activity:
    """Append-only, ring-buffered agent-activity log (JSONL). Shared across the MCP
    (writer) and the API (reader). Missing/corrupt file reads as empty; atomic writes."""

    def __init__(self, path: str, clock: Callable[[], float] = time.time, cap: int = 200) -> None:
        self._path = path
        self._clock = clock
        self._cap = cap

    def _load(self) -> list[dict]:
        out: list[dict] = []
        try:
            with open(self._path) as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        except (FileNotFoundError, OSError):
            return []
        return out

    def record(self, who: str, action: str, target: str) -> None:
        entries = self._load()
        entries.append({"who": who, "action": action, "target": target, "ts": self._clock()})
        entries = entries[-self._cap:]
        d = os.path.dirname(self._path)
        if d:
            os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d or ".")
        try:
            with os.fdopen(fd, "w") as fh:
                for e in entries:
                    fh.write(json.dumps(e) + "\n")
            os.replace(tmp, self._path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def recent(self, limit: int = 20) -> list[dict]:
        return list(reversed(self._load()))[:limit]
