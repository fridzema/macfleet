from __future__ import annotations

import json
import os
import tempfile

from macfleet._lock import state_lock

# cpu / RAM (GB). No disk: `tart set --disk-size` is grow-only and mf-golden already ships
# an ~80GB base disk, so a preset disk size would ask tart to shrink it and fail the clone.
# Engine-owned so the CLI, the API, and the desktop cannot disagree about what "standard" is.
PRESETS: dict[str, dict[str, int]] = {
    "light": {"cpu": 2, "memory_gb": 4},
    "standard": {"cpu": 4, "memory_gb": 8},
    "heavy": {"cpu": 8, "memory_gb": 16},
}
DEFAULT_PRESET = "standard"


def default_config_path() -> str:
    return os.path.expanduser("~/.macfleet/config.json")


def validate_preset(name: str) -> str:
    if name not in PRESETS:
        raise RuntimeError(f"unknown preset {name!r}: choose one of {', '.join(PRESETS)}")
    return name


class Config:
    """macfleet's user preferences, persisted as JSON. A missing, corrupt, or hand-edited
    file reads as defaults rather than raising — a bad config must never make the engine
    unstartable. Writes are atomic (temp file + rename), matching leases.py."""

    def __init__(self, path: str) -> None:
        self._path = path

    @property
    def path(self) -> str:
        return self._path

    def _load(self) -> dict:
        try:
            with open(self._path) as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

    def _save(self, doc: dict) -> None:
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

    def default_preset(self) -> str:
        value = self._load().get("default_preset")
        return value if value in PRESETS else DEFAULT_PRESET

    def set_default_preset(self, name: str) -> None:
        validate_preset(name)
        with state_lock(self._path):
            doc = self._load()
            doc["default_preset"] = name
            self._save(doc)

    def read(self) -> dict:
        """The whole config as the API serves it: the chosen default plus the table it
        indexes into, so a client never needs its own copy of the presets."""
        return {"default_preset": self.default_preset(), "presets": PRESETS}

    def reset(self) -> None:
        """Drop the file entirely — reads fall back to defaults."""
        with state_lock(self._path):
            try:
                os.unlink(self._path)
            except FileNotFoundError:
                pass
