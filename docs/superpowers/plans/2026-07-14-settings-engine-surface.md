# Settings Engine Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the engine a config file, a doctor, a data-reset operation, and a captured log — the surface the Settings page and tray menu will consume (plan 1 of 3).

**Architecture:** Three new engine modules. `macfleet/config.py` is a flock-guarded JSON store mirroring `leases.py`/`shares.py`, owning the preset table that currently lives in the frontend. `macfleet/doctor.py` is a pure check table run on demand. Reset lives on `Fleet` because it needs `tart` and the existing per-VM locks. Three FastAPI endpoints expose them; the Tauri host separately starts capturing the sidecar's stdout to a file.

**Tech Stack:** Python 3.12+, Typer, FastAPI + Pydantic, pytest; Rust (Tauri 2) for the log capture.

Spec: `docs/superpowers/specs/2026-07-14-settings-doctor-and-tray-menu-design.md`

## Global Constraints

- Python: `from __future__ import annotations` at the top of every new module, matching every existing module.
- Engine style: modules are small and single-responsibility (`leases.py`, `shares.py`, `activity.py` are the reference). Follow their exact shape for load/save/lock.
- A missing or corrupt state file **reads as defaults, never raises** — established by `leases.py` and `shares.py`.
- Writes are atomic: `tempfile.mkstemp` + `os.replace`, guarded by `state_lock` from `macfleet/_lock.py`.
- `RuntimeError` is the engine's user-facing error type. `api.py` maps it to **HTTP 409** via a registered exception handler. Do not raise `HTTPException` from engine code.
- `mf-golden` is protected by `ensure_mutable()` (`macfleet/vm.py:103`). Only `reset_data(scope="all")` may bypass it, and only via the dedicated helper in Task 6.
- No new env gate. `MACFLEET_ALLOW_CONTROL` guards computer-use only; reset relies on the per-run API token (`_guard`, applied as a global FastAPI dependency).
- Tests: pytest, `tmp_path` for filesystem state, fake objects over mocks (see `tests/test_api.py:FakeFleet`).
- Lint: `make lint-engine` (ruff). Line length and import order follow the existing config in `pyproject.toml`.
- Presets are **cpu + memory only, never disk**: `tart set --disk-size` is grow-only and `mf-golden` ships an ~80GB disk (`connect.py:526`).
- Preset memory is stored in **GB** (`memory_gb`) but `Fleet.create` takes **MB** (`memory`). Convert at the boundary, once, in `Fleet.preset_resources`.

---

### Task 1: Config store (`macfleet/config.py`)

**Files:**
- Create: `macfleet/config.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Consumes: `macfleet._lock.state_lock`
- Produces:
  - `PRESETS: dict[str, dict[str, int]]` — keys `light`/`standard`/`heavy`, each `{"cpu": int, "memory_gb": int}`
  - `DEFAULT_PRESET: str` = `"standard"`
  - `default_config_path() -> str`
  - `validate_preset(name: str) -> str` — raises `RuntimeError` on unknown
  - `class Config(path: str)` with `.path` property, `.default_preset() -> str`, `.set_default_preset(name: str) -> None`, `.read() -> dict`, `.reset() -> None`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_config.py`:

```python
import json
import threading

import pytest

from macfleet.config import DEFAULT_PRESET, PRESETS, Config, validate_preset


def test_missing_file_reads_default(tmp_path):
    assert Config(str(tmp_path / "config.json")).default_preset() == DEFAULT_PRESET


def test_corrupt_file_reads_default(tmp_path):
    p = tmp_path / "config.json"
    p.write_text("{not json")
    assert Config(str(p)).default_preset() == DEFAULT_PRESET


def test_unknown_preset_on_disk_reads_default(tmp_path):
    # A hand-edited config must never make the engine unstartable.
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"default_preset": "gigantic"}))
    assert Config(str(p)).default_preset() == DEFAULT_PRESET


def test_set_and_read_roundtrip(tmp_path):
    c = Config(str(tmp_path / "config.json"))
    c.set_default_preset("heavy")
    assert c.default_preset() == "heavy"
    assert Config(str(tmp_path / "config.json")).default_preset() == "heavy"


def test_set_unknown_preset_raises(tmp_path):
    c = Config(str(tmp_path / "config.json"))
    with pytest.raises(RuntimeError, match="unknown preset"):
        c.set_default_preset("gigantic")


def test_read_returns_default_and_table(tmp_path):
    c = Config(str(tmp_path / "config.json"))
    c.set_default_preset("light")
    assert c.read() == {"default_preset": "light", "presets": PRESETS}


def test_reset_drops_file(tmp_path):
    p = tmp_path / "config.json"
    c = Config(str(p))
    c.set_default_preset("heavy")
    c.reset()
    assert not p.exists()
    assert c.default_preset() == DEFAULT_PRESET


def test_reset_missing_file_is_noop(tmp_path):
    Config(str(tmp_path / "config.json")).reset()


def test_validate_preset_lists_valid_names():
    with pytest.raises(RuntimeError, match="light, standard, heavy|heavy, light, standard"):
        validate_preset("nope")


def test_presets_have_cpu_and_memory_only():
    # Disk is deliberately absent: `tart set --disk-size` is grow-only.
    for p in PRESETS.values():
        assert set(p) == {"cpu", "memory_gb"}


def test_concurrent_writes_do_not_lose_updates(tmp_path):
    # Mirrors tests/test_leases.py: without state_lock, interleaved
    # load-modify-save cycles drop each other's writes.
    c = Config(str(tmp_path / "config.json"))
    start = threading.Barrier(8)

    def worker():
        start.wait()
        c.set_default_preset("heavy")

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert c.default_preset() == "heavy"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_config.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'macfleet.config'`

- [ ] **Step 3: Write the implementation**

Create `macfleet/config.py`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_config.py -q`
Expected: PASS (11 passed)

- [ ] **Step 5: Lint**

Run: `make lint-engine`
Expected: no findings in `macfleet/config.py`

- [ ] **Step 6: Commit**

```bash
git add macfleet/config.py tests/test_config.py
git commit -m "feat(engine): add config store with engine-owned size presets"
```

---

### Task 2: Wire Config into Fleet + `up --preset`

**Files:**
- Modify: `macfleet/connect.py` (imports; `Fleet.__init__` ~line 191; `Fleet.up` ~line 593)
- Modify: `macfleet/cli.py:15-19` (`up`)
- Test: `tests/test_connect.py`, `tests/test_cli.py:7-20`

**Interfaces:**
- Consumes: `macfleet.config.Config`, `PRESETS`, `validate_preset`, `default_config_path` (Task 1)
- Produces:
  - `Fleet.config: Config` — public attribute, like the existing `Fleet.activity`
  - `Fleet.preset_resources(preset: str | None = None) -> dict` — returns `{"cpu": int, "memory": int}` with memory in **MB**
  - `Fleet.up(name: str, preset: str | None = None) -> None`
  - `Fleet.__init__(..., config: Config | None = None)`

- [ ] **Step 1: Write the failing tests**

`tests/test_connect.py` already imports `pytest`, `Fleet`, `Leases`, `Shares`, and
`VmInfo` at the top. Add one more import there:

```python
from macfleet.config import Config
```

Then append to `tests/test_connect.py`:

```python
def _preset_fleet(tmp_path, default):
    cfg = Config(str(tmp_path / "config.json"))
    cfg.set_default_preset(default)
    return Fleet(tart=object(), config=cfg)


def test_preset_resources_uses_configured_default(tmp_path):
    assert _preset_fleet(tmp_path, "heavy").preset_resources() == {"cpu": 8, "memory": 16384}


def test_preset_resources_explicit_overrides_default(tmp_path):
    fleet = _preset_fleet(tmp_path, "heavy")
    assert fleet.preset_resources("light") == {"cpu": 2, "memory": 4096}


def test_preset_resources_converts_gb_to_mb(tmp_path):
    # The table stores GB for humans; create() takes MB. Convert once, at this boundary.
    assert _preset_fleet(tmp_path, "standard").preset_resources()["memory"] == 8192


def test_preset_resources_rejects_unknown(tmp_path):
    with pytest.raises(RuntimeError, match="unknown preset"):
        _preset_fleet(tmp_path, "standard").preset_resources("gigantic")


def test_up_applies_configured_preset(tmp_path, monkeypatch):
    fleet = _preset_fleet(tmp_path, "light")
    calls = []
    monkeypatch.setattr(fleet, "create", lambda name, **kw: calls.append((name, kw)))
    fleet.up("web")
    assert calls == [("web", {"cpu": 2, "memory": 4096})]


def test_up_explicit_preset_wins(tmp_path, monkeypatch):
    fleet = _preset_fleet(tmp_path, "light")
    calls = []
    monkeypatch.setattr(fleet, "create", lambda name, **kw: calls.append((name, kw)))
    fleet.up("web", preset="heavy")
    assert calls == [("web", {"cpu": 8, "memory": 16384})]
```

Replace the `FakeFleet` and `test_up_invokes_fleet` at `tests/test_cli.py:7-20` with:

```python
class FakeFleet:
    def __init__(self):
        self.calls = []

    def up(self, name, preset=None): self.calls.append(("up", name, preset))
    def nuke(self, name): self.calls.append(("nuke", name))


def test_up_invokes_fleet(monkeypatch):
    fake = FakeFleet()
    monkeypatch.setattr(cli, "_fleet", lambda: fake)
    result = runner.invoke(cli.app, ["up", "web"])
    assert result.exit_code == 0
    assert ("up", "web", None) in fake.calls


def test_up_passes_preset_flag(monkeypatch):
    fake = FakeFleet()
    monkeypatch.setattr(cli, "_fleet", lambda: fake)
    result = runner.invoke(cli.app, ["up", "web", "--preset", "heavy"])
    assert result.exit_code == 0
    assert ("up", "web", "heavy") in fake.calls
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_connect.py -q -k preset && uv run pytest tests/test_cli.py -q -k up`
Expected: FAIL — `TypeError: Fleet.__init__() got an unexpected keyword argument 'config'`

- [ ] **Step 3: Add the Config import and constructor parameter**

In `macfleet/connect.py`, add to the imports:

```python
from macfleet.config import PRESETS, Config, default_config_path, validate_preset
```

In `Fleet.__init__`, add the parameter after `activity` and before `shares`:

```python
                 config: Config | None = None,
```

and in the body, next to the other stores:

```python
        self.config = config or Config(default_config_path())
```

- [ ] **Step 4: Add `preset_resources` and rewrite `up`**

Replace `Fleet.up` (`macfleet/connect.py:593-594`):

```python
    def preset_resources(self, preset: str | None = None) -> dict:
        """Resolve a preset name (or the configured default) to create() kwargs. The table
        stores RAM in GB for humans; create() takes MB — convert here, once, so no caller
        has to know."""
        name = validate_preset(preset) if preset else self.config.default_preset()
        p = PRESETS[name]
        return {"cpu": p["cpu"], "memory": p["memory_gb"] * 1024}

    def up(self, name: str, preset: str | None = None) -> None:
        self.create(name, **self.preset_resources(preset))
```

- [ ] **Step 5: Update the CLI**

Replace `macfleet/cli.py:15-19`:

```python
@app.command()
def up(name: str,
       preset: str | None = typer.Option(
           None, "--preset", help="light | standard | heavy (default: configured)")) -> None:
    """Clone mf-golden -> mf-<name> and boot it."""
    _fleet().up(name, preset=preset)
    typer.echo(f"up: mf-{name}")
```

- [ ] **Step 6: Run the tests**

Run: `uv run pytest tests/test_connect.py tests/test_cli.py -q`
Expected: PASS

- [ ] **Step 7: Run the whole engine suite (this changed a public signature)**

Run: `make test-engine`
Expected: PASS. If a test constructs `Fleet()` and asserts on `up`, update it to the new signature.

- [ ] **Step 8: Commit**

```bash
git add macfleet/connect.py macfleet/cli.py tests/test_connect.py tests/test_cli.py
git commit -m "feat(engine): resolve create size from configured preset"
```

---

### Task 3: Config endpoints (`GET`/`PUT /config`)

**Files:**
- Modify: `macfleet/api.py` (request models ~line 80; routes after `list_vms` ~line 137)
- Test: `tests/test_api.py`

**Interfaces:**
- Consumes: `Fleet.config` (Task 2)
- Produces: `GET /config -> {"default_preset": str, "presets": dict}`; `PUT /config` body `{"default_preset": str}` -> same shape

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api.py`:

```python
class FakeConfig:
    def __init__(self, preset="standard"):
        self.preset = preset

    def default_preset(self):
        return self.preset

    def set_default_preset(self, name):
        if name not in ("light", "standard", "heavy"):
            raise RuntimeError(f"unknown preset {name!r}: choose one of light, standard, heavy")
        self.preset = name

    def read(self):
        return {"default_preset": self.preset,
                "presets": {"light": {"cpu": 2, "memory_gb": 4},
                            "standard": {"cpu": 4, "memory_gb": 8},
                            "heavy": {"cpu": 8, "memory_gb": 16}}}


def test_get_config_returns_default_and_presets():
    fake = FakeFleet()
    fake.config = FakeConfig()
    client = TestClient(build_app(fake))
    body = client.get("/config").json()
    assert body["default_preset"] == "standard"
    assert body["presets"]["heavy"] == {"cpu": 8, "memory_gb": 16}


def test_put_config_sets_default_preset():
    fake = FakeFleet()
    fake.config = FakeConfig()
    client = TestClient(build_app(fake))
    body = client.put("/config", json={"default_preset": "heavy"}).json()
    assert body["default_preset"] == "heavy"
    assert fake.config.preset == "heavy"


def test_put_config_unknown_preset_is_409():
    # RuntimeError -> 409 via the registered handler, so CORS headers survive.
    fake = FakeFleet()
    fake.config = FakeConfig()
    client = TestClient(build_app(fake))
    r = client.put("/config", json={"default_preset": "gigantic"})
    assert r.status_code == 409
    assert "unknown preset" in r.json()["detail"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api.py -q -k config`
Expected: FAIL — 404, the routes do not exist

- [ ] **Step 3: Add the request model**

In `macfleet/api.py`, after `class ExecRequest` (~line 78):

```python
class ConfigRequest(BaseModel):
    default_preset: str = Field(min_length=1, max_length=64)
```

- [ ] **Step 4: Add the routes**

In `build_app`, after the `list_vms` route:

```python
    @api.get("/config")
    def get_config() -> dict:
        return fleet.config.read()

    @api.put("/config")
    def put_config(req: ConfigRequest) -> dict:
        # An unknown preset raises RuntimeError -> 409 via the handler above.
        fleet.config.set_default_preset(req.default_preset)
        return fleet.config.read()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_api.py -q -k config`
Expected: PASS (3 passed)

- [ ] **Step 6: Commit**

```bash
git add macfleet/api.py tests/test_api.py
git commit -m "feat(api): expose GET/PUT /config"
```

---

### Task 4: Doctor checks (`macfleet/doctor.py`)

**Files:**
- Create: `macfleet/doctor.py`
- Test: `tests/test_doctor.py`

**Interfaces:**
- Consumes: `macfleet.vm.GOLDEN`, `macfleet.vm.shortname`, `Fleet.tart.list()`, `Fleet.leases`, `Fleet.computer(name)`
- Produces:
  - `run_checks(fleet) -> list[dict]` — each dict is `{"id": str, "label": str, "status": "ok"|"warn"|"fail"|"skip", "detail": str, "fix": str | None}`
  - `CHECKS: tuple[tuple[str, str, Callable], ...]`
  - `LOW_DISK_GB: float`

Note: this task also adds a public `Fleet.leases` property, because `_stale_leases` needs the lease table and `Fleet._leases` is private.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_doctor.py`:

```python
import pytest

from macfleet.doctor import run_checks
from macfleet.vm import VmInfo


class FakeLeases:
    def __init__(self, expiries=None):
        self._expiries = expiries or {}

    def expiries(self):
        return dict(self._expiries)


class FakeComputer:
    def __init__(self, data=b"PNG"):
        self._data = data

    def screenshot(self):
        return self._data


class FakeFleet:
    def __init__(self, vms=(), expiries=None, computer_obj=None, computer_error=None):
        self.tart = self
        self._vms = list(vms)
        self.leases = FakeLeases(expiries)
        self._computer_obj = computer_obj or FakeComputer()
        self._computer_error = computer_error

    def list(self):
        return self._vms

    def computer(self, name):
        if self._computer_error is not None:
            raise self._computer_error
        return self._computer_obj


def by_id(checks):
    return {c["id"]: c for c in checks}


def test_every_check_reports_a_known_shape():
    checks = run_checks(FakeFleet())
    assert checks
    for c in checks:
        assert set(c) == {"id", "label", "status", "detail", "fix"}
        assert c["status"] in ("ok", "warn", "fail", "skip")


def test_arch_ok_on_apple_silicon(monkeypatch):
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    assert by_id(run_checks(FakeFleet()))["arch"]["status"] == "ok"


def test_arch_fails_on_intel(monkeypatch):
    monkeypatch.setattr("platform.machine", lambda: "x86_64")
    c = by_id(run_checks(FakeFleet()))["arch"]
    assert c["status"] == "fail"
    assert "Apple silicon" in c["detail"]


def test_tart_fails_when_not_on_path(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: None)
    c = by_id(run_checks(FakeFleet()))["tart"]
    assert c["status"] == "fail"
    assert c["fix"]


def test_tart_ok_when_present(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: "/opt/homebrew/bin/tart")
    c = by_id(run_checks(FakeFleet()))["tart"]
    assert c["status"] == "ok"
    assert "/opt/homebrew/bin/tart" in c["detail"]


def test_golden_fails_when_absent():
    c = by_id(run_checks(FakeFleet()))["golden"]
    assert c["status"] == "fail"
    assert c["fix"] == "macfleet bake"


def test_golden_ok_when_present():
    fleet = FakeFleet(vms=[VmInfo("mf-golden", "suspended", "local")])
    assert by_id(run_checks(fleet))["golden"]["status"] == "ok"


def test_golden_warm_ok_when_suspended():
    fleet = FakeFleet(vms=[VmInfo("mf-golden", "suspended", "local")])
    assert by_id(run_checks(fleet))["golden_warm"]["status"] == "ok"


def test_golden_warm_warns_when_merely_stopped():
    fleet = FakeFleet(vms=[VmInfo("mf-golden", "stopped", "local")])
    c = by_id(run_checks(fleet))["golden_warm"]
    assert c["status"] == "warn"
    assert c["fix"] == "macfleet warm"


def test_golden_warm_skips_when_golden_absent():
    assert by_id(run_checks(FakeFleet()))["golden_warm"]["status"] == "skip"


def test_tcc_skips_with_no_running_vm():
    fleet = FakeFleet(vms=[VmInfo("mf-web", "stopped", "local")])
    assert by_id(run_checks(fleet))["tcc_screenshot"]["status"] == "skip"


def test_tcc_ok_when_screenshot_returns_bytes():
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local")])
    c = by_id(run_checks(fleet))["tcc_screenshot"]
    assert c["status"] == "ok"


def test_tcc_fails_on_empty_screenshot():
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local")],
                      computer_obj=FakeComputer(data=b""))
    c = by_id(run_checks(fleet))["tcc_screenshot"]
    assert c["status"] == "fail"
    assert "re-bake" in c["fix"]


def test_tcc_never_targets_golden():
    # golden is running but is not a fleet VM; there is nothing else to test against.
    fleet = FakeFleet(vms=[VmInfo("mf-golden", "running", "local")])
    assert by_id(run_checks(fleet))["tcc_screenshot"]["status"] == "skip"


def test_a_raising_check_becomes_a_fail_not_a_crash():
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local")],
                      computer_error=RuntimeError("computer-use disabled"))
    c = by_id(run_checks(fleet))["tcc_screenshot"]
    assert c["status"] == "fail"
    assert "computer-use disabled" in c["detail"]


def test_orphans_ok_when_none():
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local")])
    assert by_id(run_checks(fleet))["orphans"]["status"] == "ok"


def test_orphans_warns_and_names_leaks():
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local"),
                           VmInfo("mfbackup-abc", "stopped", "local"),
                           VmInfo("mftmp-def", "stopped", "local")])
    c = by_id(run_checks(fleet))["orphans"]
    assert c["status"] == "warn"
    assert "mfbackup-abc" in c["detail"]
    assert "mftmp-def" in c["detail"]


def test_stale_leases_ok_when_all_live():
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local")],
                      expiries={"mf-web": 123.0})
    assert by_id(run_checks(fleet))["stale_leases"]["status"] == "ok"


def test_stale_leases_warns_for_vanished_vm():
    fleet = FakeFleet(vms=[], expiries={"mf-gone": 123.0})
    c = by_id(run_checks(fleet))["stale_leases"]
    assert c["status"] == "warn"
    assert "mf-gone" in c["detail"]
    assert c["fix"] is None  # doctor diagnoses; it does not repair


def test_disk_warns_when_low(monkeypatch):
    import macfleet.doctor as doctor

    class St:
        f_bavail = 1
        f_frsize = 1_000_000_000  # 1GB free
    monkeypatch.setattr(doctor.os, "statvfs", lambda _: St())
    c = by_id(run_checks(FakeFleet()))["disk"]
    assert c["status"] == "warn"


def test_disk_ok_when_plentiful(monkeypatch):
    import macfleet.doctor as doctor

    class St:
        f_bavail = 500
        f_frsize = 1_000_000_000  # 500GB free
    monkeypatch.setattr(doctor.os, "statvfs", lambda _: St())
    assert by_id(run_checks(FakeFleet()))["disk"]["status"] == "ok"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_doctor.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'macfleet.doctor'`

- [ ] **Step 3: Add the public `leases` property to Fleet**

In `macfleet/connect.py`, inside `class Fleet`, next to the other small accessors:

```python
    @property
    def leases(self) -> Leases:
        """Read access for callers outside a fleet operation (doctor). Mutation still goes
        through the Fleet methods that hold the per-VM lock."""
        return self._leases
```

- [ ] **Step 4: Write the doctor module**

Create `macfleet/doctor.py`:

```python
from __future__ import annotations

import os
import platform
import shutil
from collections.abc import Callable
from typing import Any

from macfleet.vm import GOLDEN, shortname

# Warn below this much free space. A single VM's disk is tens of GB, so "a few GB free"
# means the next create fails halfway through a clone.
LOW_DISK_GB = 20.0

# tart's temporary/backup clones. `restore` deliberately leaves a backup behind rather than
# delete user data (connect.py:1014), so these accumulate silently.
_ORPHAN_PREFIXES = ("mfbackup-", "mftmp-")

# (status, detail, fix) — `fix` is a human-readable hint, not an executable action.
CheckResult = tuple[str, str, "str | None"]


def _arch(_fleet: Any) -> CheckResult:
    machine = platform.machine()
    if machine == "arm64":
        return "ok", machine, None
    return "fail", f"{machine} — macfleet needs Apple silicon (Virtualization.framework)", None


def _tart(_fleet: Any) -> CheckResult:
    path = shutil.which("tart")
    if path is None:
        return "fail", "not found on PATH", "brew install cirruslabs/cli/tart"
    return "ok", path, None


def _golden(fleet: Any) -> CheckResult:
    if any(v.name == GOLDEN for v in fleet.tart.list()):
        return "ok", f"{GOLDEN} present", None
    return "fail", f"{GOLDEN} not found", "macfleet bake"


def _golden_warm(fleet: Any) -> CheckResult:
    for v in fleet.tart.list():
        if v.name == GOLDEN:
            if v.state == "suspended":
                return "ok", "suspended — new VMs resume in ~2s", None
            return "warn", f"state is {v.state!r} — new VMs will cold-boot (~30-60s)", "macfleet warm"
    return "skip", f"{GOLDEN} not present", "macfleet bake"


def _tcc_screenshot(fleet: Any) -> CheckResult:
    """The documented golden-image trap: without Screen Recording granted at bake time,
    every screenshot comes back empty. Only testable against a live fleet VM — never
    golden, which is the clone source and must not be driven."""
    running = [v for v in fleet.tart.list()
               if v.state == "running" and v.name.startswith("mf-") and v.name != GOLDEN]
    if not running:
        return "skip", "no running VM to test against", None
    name = shortname(running[0].name)
    data = fleet.computer(name).screenshot()
    if data:
        return "ok", f"captured {len(data)} bytes from {name}", None
    return "fail", f"{name} returned an empty screenshot", "re-bake golden — TCC not granted"


def _orphans(fleet: Any) -> CheckResult:
    leaked = sorted(v.name for v in fleet.tart.list() if v.name.startswith(_ORPHAN_PREFIXES))
    if not leaked:
        return "ok", "none", None
    return ("warn", f"{len(leaked)} leaked: {', '.join(leaked)}",
            "Settings → Data → Remove all VMs & data")


def _stale_leases(fleet: Any) -> CheckResult:
    live = {v.name for v in fleet.tart.list()}
    stale = sorted(n for n in fleet.leases.expiries() if n not in live)
    if not stale:
        return "ok", "none", None
    # No fix hint: reap() only drops *expired* leases, and these are cleared by a data reset.
    return "warn", f"{len(stale)} for VMs tart no longer has: {', '.join(stale)}", None


def _disk(_fleet: Any) -> CheckResult:
    target = os.path.expanduser("~/.tart")
    if not os.path.exists(target):
        target = os.path.expanduser("~")
    st = os.statvfs(target)
    free_gb = st.f_bavail * st.f_frsize / 1e9
    if free_gb < LOW_DISK_GB:
        return "warn", f"{free_gb:.0f}GB free — a VM disk is tens of GB", None
    return "ok", f"{free_gb:.0f}GB free", None


CHECKS: tuple[tuple[str, str, Callable[[Any], CheckResult]], ...] = (
    ("arch", "Apple silicon", _arch),
    ("tart", "tart installed", _tart),
    ("golden", "Golden image present", _golden),
    ("golden_warm", "Golden image warm", _golden_warm),
    ("tcc_screenshot", "Screen recording permission", _tcc_screenshot),
    ("orphans", "No leaked temporary VMs", _orphans),
    ("stale_leases", "No stale leases", _stale_leases),
    ("disk", "Disk space", _disk),
)


def run_checks(fleet: Any) -> list[dict]:
    """Run every check, in order. A check that raises becomes a `fail` row rather than
    failing the whole report — a broken check must not leave the user with no diagnosis at
    exactly the moment they came looking for one."""
    results = []
    for check_id, label, fn in CHECKS:
        try:
            status, detail, fix = fn(fleet)
        except Exception as exc:  # noqa: BLE001 — a check's failure IS a finding
            status, detail, fix = "fail", str(exc), None
        results.append({"id": check_id, "label": label, "status": status,
                        "detail": detail, "fix": fix})
    return results
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_doctor.py -q`
Expected: PASS (21 passed)

- [ ] **Step 6: Lint**

Run: `make lint-engine`
Expected: no findings. If ruff rejects the bare `except Exception`, keep the `# noqa: BLE001` comment.

- [ ] **Step 7: Commit**

```bash
git add macfleet/doctor.py macfleet/connect.py tests/test_doctor.py
git commit -m "feat(engine): add doctor diagnostics"
```

---

### Task 5: Doctor endpoint (`GET /doctor`)

**Files:**
- Modify: `macfleet/api.py` (import; route after the config routes)
- Test: `tests/test_api.py`

**Interfaces:**
- Consumes: `macfleet.doctor.run_checks` (Task 4)
- Produces: `GET /doctor -> {"checks": [...]}`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_api.py`:

```python
def test_doctor_returns_checks(monkeypatch):
    import macfleet.api as api_mod
    monkeypatch.setattr(api_mod, "run_checks", lambda _fleet: [
        {"id": "arch", "label": "Apple silicon", "status": "ok", "detail": "arm64", "fix": None},
    ])
    client = TestClient(build_app(FakeFleet()))
    body = client.get("/doctor").json()
    assert body == {"checks": [{"id": "arch", "label": "Apple silicon",
                                "status": "ok", "detail": "arm64", "fix": None}]}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_api.py -q -k doctor`
Expected: FAIL — `AttributeError: module 'macfleet.api' has no attribute 'run_checks'`

- [ ] **Step 3: Add the import and route**

In `macfleet/api.py`, add to the imports:

```python
from macfleet.doctor import run_checks
```

In `build_app`, after the config routes:

```python
    @api.get("/doctor")
    def doctor() -> dict:
        # Shells out to tart, so keep it off the event loop.
        return {"checks": run_checks(fleet)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_api.py -q -k doctor`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add macfleet/api.py tests/test_api.py
git commit -m "feat(api): expose GET /doctor"
```

---

### Task 6: Data reset (`Fleet.reset_data`)

**Files:**
- Modify: `macfleet/connect.py` (module constants; new methods near `nuke` ~line 708)
- Test: `tests/test_connect.py`

**Interfaces:**
- Consumes: `Fleet.config` (Task 2), `Fleet._locked_vms`, `Fleet._leases`, `Fleet._shares`
- Produces: `Fleet.reset_data(scope: str = "fleet") -> dict` returning `{"deleted": list[str], "failed": list[dict], "removed_paths": list[str]}`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_connect.py`:

```python
class ResetTart:
    """Records stop/delete and serves a fixed inventory."""

    def __init__(self, vms):
        self._vms = list(vms)
        self.stopped = []
        self.deleted = []
        self.delete_error = None

    def list(self):
        return list(self._vms)

    def stop(self, name):
        self.stopped.append(name)

    def delete(self, name):
        if self.delete_error is not None and name == self.delete_error[0]:
            raise RuntimeError(self.delete_error[1])
        self.deleted.append(name)
        self._vms = [v for v in self._vms if v.name != name]


def _reset_fleet(tmp_path, vms):
    # Config/Leases/Shares are imported at the top of this file (see Task 2).
    tart = ResetTart(vms)
    fleet = Fleet(
        tart=tart,
        leases=Leases(str(tmp_path / "state.json")),
        shares=Shares(str(tmp_path / "shares.json")),
        config=Config(str(tmp_path / "config.json")),
        operation_lock_dir=str(tmp_path),
    )
    return fleet, tart


def test_reset_fleet_deletes_vms_and_snapshots_but_keeps_golden(tmp_path):
    fleet, tart = _reset_fleet(tmp_path, [
        VmInfo("mf-golden", "suspended", "local"),
        VmInfo("mf-web", "running", "local"),
        VmInfo("mfsnap-web-v1", "stopped", "local"),
        VmInfo("mfbackup-abc", "stopped", "local"),
        VmInfo("mftmp-def", "stopped", "local"),
    ])
    result = fleet.reset_data("fleet")
    assert set(result["deleted"]) == {"mf-web", "mfsnap-web-v1", "mfbackup-abc", "mftmp-def"}
    assert "mf-golden" not in tart.deleted
    assert result["failed"] == []


def test_reset_all_deletes_golden_too(tmp_path):
    fleet, tart = _reset_fleet(tmp_path, [
        VmInfo("mf-golden", "suspended", "local"),
        VmInfo("mf-web", "running", "local"),
    ])
    result = fleet.reset_data("all")
    assert set(result["deleted"]) == {"mf-golden", "mf-web"}
    assert "mf-golden" in tart.deleted


def test_reset_never_touches_foreign_vms(tmp_path):
    fleet, tart = _reset_fleet(tmp_path, [
        VmInfo("mf-web", "running", "local"),
        VmInfo("ubuntu-ci", "running", "local"),
        VmInfo("sonoma-base", "stopped", "local"),
    ])
    result = fleet.reset_data("all")
    assert result["deleted"] == ["mf-web"]
    assert tart.deleted == ["mf-web"]


def test_reset_removes_state_files_but_keeps_engine_log(tmp_path):
    fleet, _ = _reset_fleet(tmp_path, [])
    (tmp_path / "state.json").write_text("{}")
    (tmp_path / "shares.json").write_text("{}")
    (tmp_path / "activity.jsonl").write_text("")
    (tmp_path / "engine.log").write_text("boot output")
    fleet.reset_data("fleet")
    assert not (tmp_path / "state.json").exists()
    assert not (tmp_path / "shares.json").exists()
    assert not (tmp_path / "activity.jsonl").exists()
    # The running process is writing this; deleting it is how you lose the boot diagnosis.
    assert (tmp_path / "engine.log").read_text() == "boot output"


def test_reset_fleet_keeps_config_but_reset_all_clears_it(tmp_path):
    fleet, _ = _reset_fleet(tmp_path, [])
    fleet.config.set_default_preset("heavy")
    fleet.reset_data("fleet")
    assert fleet.config.default_preset() == "heavy"
    fleet.reset_data("all")
    assert fleet.config.default_preset() == "standard"


def test_reset_leaves_operations_dir_alone(tmp_path):
    # Zero-byte flock files. Unlinking one another process holds does not break its lock —
    # it makes the next opener create a different file and silently lose mutual exclusion.
    fleet, _ = _reset_fleet(tmp_path, [])
    ops = tmp_path / "operations"
    ops.mkdir(exist_ok=True)
    (ops / "deadbeef.lock").write_text("")
    fleet.reset_data("all")
    assert (ops / "deadbeef.lock").exists()


def test_reset_reports_failures_without_aborting(tmp_path):
    fleet, tart = _reset_fleet(tmp_path, [
        VmInfo("mf-a", "running", "local"),
        VmInfo("mf-b", "running", "local"),
    ])
    tart.delete_error = ("mf-a", "tart delete failed: busy")
    result = fleet.reset_data("fleet")
    assert result["deleted"] == ["mf-b"]
    assert result["failed"] == [{"name": "mf-a", "error": "tart delete failed: busy"}]


def test_reset_rejects_unknown_scope(tmp_path):
    fleet, _ = _reset_fleet(tmp_path, [])
    with pytest.raises(RuntimeError, match="unknown reset scope"):
        fleet.reset_data("everything")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_connect.py -q -k reset`
Expected: FAIL — `AttributeError: 'Fleet' object has no attribute 'reset_data'`

- [ ] **Step 3: Add module constants**

In `macfleet/connect.py`, near the other module constants:

```python
# Everything macfleet owns in tart's store. Anything without one of these prefixes belongs
# to the user and must never be touched by a reset.
_RESET_PREFIXES = ("mf-", "mfsnap-", "mfbackup-", "mftmp-")
# Removed by name, not `rm -rf ~/.macfleet`: a blanket wipe would take engine.log out from
# under the running process and silently take config.json with it. `operations/` is
# deliberately absent — see reset_data.
_RESET_STATE_FILES = ("state.json", "shares.json", "activity.jsonl")
```

- [ ] **Step 4: Write the implementation**

In `macfleet/connect.py`, after `nuke`/`_nuke_unlocked`:

```python
    def reset_data(self, scope: str = "fleet") -> dict:
        """Delete everything macfleet owns. `scope="fleet"` keeps mf-golden (a re-bake is
        expensive and it is the clone source for every future create); `scope="all"` takes
        golden too and resets settings to defaults.

        A VM that refuses to delete is reported, not silently skipped, and does not abort
        the rest of the sweep."""
        if scope not in ("fleet", "all"):
            raise RuntimeError(f"unknown reset scope {scope!r}: choose 'fleet' or 'all'")
        deleted: list[str] = []
        failed: list[dict] = []
        for v in self.tart.list():
            if not v.name.startswith(_RESET_PREFIXES):
                continue
            if v.name == GOLDEN and scope != "all":
                continue
            try:
                self._reset_delete(v.name)
                deleted.append(v.name)
            except RuntimeError as exc:
                failed.append({"name": v.name, "error": str(exc)})
        return {"deleted": deleted, "failed": failed,
                "removed_paths": self._reset_state_files(scope)}

    def _reset_delete(self, full: str) -> None:
        """Delete one VM by its FULL name, bypassing ensure_mutable so `scope="all"` can
        take golden. Every other caller must go through nuke()."""
        with self._locked_vms(full):
            try:
                self.tart.stop(full)
            except RuntimeError:
                pass  # already stopped
            self.tart.delete(full)
            self._res_cache.pop(full, None)
            self._res_cache_at.pop(full, None)
            self._forget_ip(full)
            self._leases.unsuspend(full)
            self._leases.drop(full)
            self._shares.drop(full)
            with self._provision_lock:
                self._provision.pop(full, None)
            self._invalidate_fleet(full)

    def _reset_state_files(self, scope: str) -> list[str]:
        removed = []
        storage = self._leases.storage_dir
        for fname in _RESET_STATE_FILES:
            path = os.path.join(storage, fname)
            try:
                os.unlink(path)
                removed.append(path)
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise RuntimeError(f"could not remove {path}: {exc}") from exc
        if scope == "all":
            self.config.reset()
            removed.append(self.config.path)
        return removed
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_connect.py -q -k reset`
Expected: PASS (8 passed)

- [ ] **Step 6: Run the full engine suite**

Run: `make test-engine`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add macfleet/connect.py tests/test_connect.py
git commit -m "feat(engine): add two-tier data reset"
```

---

### Task 7: Reset endpoint + CLI

**Files:**
- Modify: `macfleet/api.py` (import `Literal`; request model; route)
- Modify: `macfleet/cli.py` (new `reset` command)
- Test: `tests/test_api.py`, `tests/test_cli.py`

**Interfaces:**
- Consumes: `Fleet.reset_data` (Task 6)
- Produces: `POST /data/reset` body `{"scope": "fleet"|"all"}` -> `{"deleted": [...], "failed": [...], "removed_paths": [...]}`; CLI `macfleet reset [--all]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api.py`:

```python
def test_reset_defaults_to_fleet_scope():
    fake = FakeFleet()
    seen = []
    fake.reset_data = lambda scope: seen.append(scope) or {
        "deleted": ["mf-a"], "failed": [], "removed_paths": []}
    client = TestClient(build_app(fake))
    body = client.post("/data/reset", json={}).json()
    assert seen == ["fleet"]
    assert body["deleted"] == ["mf-a"]


def test_reset_accepts_all_scope():
    fake = FakeFleet()
    seen = []
    fake.reset_data = lambda scope: seen.append(scope) or {
        "deleted": [], "failed": [], "removed_paths": []}
    client = TestClient(build_app(fake))
    client.post("/data/reset", json={"scope": "all"})
    assert seen == ["all"]


def test_reset_rejects_unknown_scope_as_422():
    # Literal typing means pydantic rejects it before the engine is ever called.
    client = TestClient(build_app(FakeFleet()))
    assert client.post("/data/reset", json={"scope": "everything"}).status_code == 422
```

Append to `tests/test_cli.py` (and add `reset_data` to that file's `FakeFleet`):

```python
    def reset_data(self, scope):
        self.calls.append(("reset_data", scope))
        return {"deleted": ["mf-a"], "failed": [], "removed_paths": ["/x/state.json"]}
```

```python
def test_reset_aborts_without_confirmation(monkeypatch):
    fake = FakeFleet()
    monkeypatch.setattr(cli, "_fleet", lambda: fake)
    result = runner.invoke(cli.app, ["reset"], input="n\n")
    assert result.exit_code != 0
    assert fake.calls == []


def test_reset_fleet_scope_on_confirm(monkeypatch):
    fake = FakeFleet()
    monkeypatch.setattr(cli, "_fleet", lambda: fake)
    result = runner.invoke(cli.app, ["reset"], input="y\n")
    assert result.exit_code == 0
    assert ("reset_data", "fleet") in fake.calls
    assert "deleted mf-a" in result.output


def test_reset_all_scope(monkeypatch):
    fake = FakeFleet()
    monkeypatch.setattr(cli, "_fleet", lambda: fake)
    result = runner.invoke(cli.app, ["reset", "--all"], input="y\n")
    assert result.exit_code == 0
    assert ("reset_data", "all") in fake.calls


def test_reset_exits_nonzero_when_a_vm_fails(monkeypatch):
    fake = FakeFleet()
    fake.reset_data = lambda scope: {
        "deleted": [], "failed": [{"name": "mf-a", "error": "busy"}], "removed_paths": []}
    monkeypatch.setattr(cli, "_fleet", lambda: fake)
    result = runner.invoke(cli.app, ["reset"], input="y\n")
    assert result.exit_code == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api.py tests/test_cli.py -q -k reset`
Expected: FAIL — 404 for the endpoint, "No such command 'reset'" for the CLI

- [ ] **Step 3: Add the endpoint**

In `macfleet/api.py`, add `Literal` to the typing import:

```python
from typing import Literal
```

Add the request model after `ConfigRequest`:

```python
class ResetRequest(BaseModel):
    # Literal, not str: an unknown scope is rejected by pydantic (422) before any VM is
    # touched, rather than after the sweep has started.
    scope: Literal["fleet", "all"] = "fleet"
```

Add the route after `/doctor`:

```python
    @api.post("/data/reset")
    def reset_data(req: ResetRequest) -> dict:
        return fleet.reset_data(req.scope)
```

- [ ] **Step 4: Add the CLI command**

In `macfleet/cli.py`, after `nuke`:

```python
@app.command()
def reset(everything: bool = typer.Option(
        False, "--all", help="also delete mf-golden and reset settings to defaults")) -> None:
    """Delete every fleet VM, snapshot, and macfleet state file."""
    scope = "all" if everything else "fleet"
    what = ("every fleet VM, snapshot, macfleet state file, mf-golden itself, and your "
            "settings — golden needs a full re-bake afterwards"
            if everything else
            "every fleet VM, snapshot, and macfleet state file (mf-golden is kept)")
    typer.confirm(f"This permanently deletes {what}. Continue?", abort=True)
    result = _fleet().reset_data(scope)
    for name in result["deleted"]:
        typer.echo(f"deleted {name}")
    for path in result["removed_paths"]:
        typer.echo(f"removed {path}")
    for failure in result["failed"]:
        typer.echo(f"FAILED {failure['name']}: {failure['error']}", err=True)
    if result["failed"]:
        raise typer.Exit(1)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_api.py tests/test_cli.py -q -k reset`
Expected: PASS (7 passed)

- [ ] **Step 6: Lint**

Run: `make lint-engine`
Expected: no findings

- [ ] **Step 7: Commit**

```bash
git add macfleet/api.py macfleet/cli.py tests/test_api.py tests/test_cli.py
git commit -m "feat(api): expose POST /data/reset and macfleet reset"
```

---

### Task 8: Capture the engine sidecar's log (Rust)

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs` (new helper; the `cmd` builder ~line 122-136)
- Test: `desktop/src-tauri/src/lib.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `~/.macfleet/engine.log` (current run) and `~/.macfleet/engine.log.1` (previous run). Plan 2's Settings page reads these directly via `tauri-plugin-fs`.

- [ ] **Step 1: Write the failing test**

In `desktop/src-tauri/src/lib.rs`, add (or extend) the test module at the bottom of the file:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_log_rotates_previous_run() {
        let dir = std::env::temp_dir().join(format!("mf-log-{}", uuid::Uuid::new_v4()));
        engine_log_at(&dir).expect("first run");
        std::fs::write(dir.join("engine.log"), b"first run output").unwrap();

        engine_log_at(&dir).expect("second run");

        assert_eq!(
            std::fs::read_to_string(dir.join("engine.log.1")).unwrap(),
            "first run output"
        );
        assert_eq!(std::fs::read_to_string(dir.join("engine.log")).unwrap(), "");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn engine_log_creates_missing_dir() {
        let dir = std::env::temp_dir().join(format!("mf-log-{}", uuid::Uuid::new_v4()));
        engine_log_at(&dir).expect("creates dir");
        assert!(dir.join("engine.log").is_file());
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && make rust-test`
Expected: FAIL — `cannot find function 'engine_log_at' in this scope`

- [ ] **Step 3: Write the helper**

In `desktop/src-tauri/src/lib.rs`, near `engine_dir()`:

```rust
/// Redirect targets for the engine sidecar's stdout/stderr.
///
/// The sidecar inherits our stdio by default, which sends the engine's output nowhere. That
/// output is the only record of *why* the engine failed to start — the readiness probe below
/// reports the symptom ("did not become ready in 30s"), never the cause. Rotate one
/// generation per launch: bounds the file without a reader thread or size accounting, and
/// keeps the previous run around for a crash-and-relaunch.
///
/// Deliberately in ~/.macfleet rather than the Tauri log dir: the Settings page reads it
/// through the fs plugin, so it must sit under a path the capability can scope to, next to
/// the engine's other state.
fn engine_log_at(dir: &std::path::Path) -> std::io::Result<(Stdio, Stdio)> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("engine.log");
    let _ = std::fs::rename(&path, dir.join("engine.log.1"));
    let file = std::fs::File::create(&path)?;
    let err = file.try_clone()?;
    Ok((Stdio::from(file), Stdio::from(err)))
}

fn engine_log() -> std::io::Result<(Stdio, Stdio)> {
    let home = std::env::var("HOME").unwrap_or_default();
    engine_log_at(&std::path::PathBuf::from(home).join(".macfleet"))
}
```

Add `use std::process::Stdio;` to the imports if not already present.

- [ ] **Step 4: Wire it into the spawn**

In `lib.rs`, immediately after the `.env("MACFLEET_SUSPEND_VMS_ON_EXIT", "1");` line and before the `#[cfg(unix)]` process-group block:

```rust
            // Never fail the launch over logging: a read-only HOME must not stop the engine.
            match engine_log() {
                Ok((out, err)) => {
                    cmd.stdout(out).stderr(err);
                }
                Err(e) => log::warn!("engine log capture disabled: {e}"),
            }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd desktop && make rust-test`
Expected: PASS

- [ ] **Step 6: Lint + format**

Run: `cd desktop && make rust-lint && make rust-format`
Expected: no clippy findings (the crate is `pedantic = warn`)

- [ ] **Step 7: Verify by hand — this is the whole point of the task**

Run: `make dev`, wait for the app window, then:

Run: `head -5 ~/.macfleet/engine.log`
Expected: uvicorn startup lines (e.g. `Uvicorn running on http://127.0.0.1:<port>`)

Quit the app, relaunch it, then:

Run: `ls -la ~/.macfleet/engine.log*`
Expected: both `engine.log` and `engine.log.1` present

- [ ] **Step 8: Commit**

```bash
git add desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): capture engine sidecar output to ~/.macfleet/engine.log"
```

---

### Task 9: Document the new surface

**Files:**
- Modify: `README.md` (the CLI command list ~line 101-120; env/gates section)

**Interfaces:**
- Consumes: everything above
- Produces: nothing code-facing

- [ ] **Step 1: Update the README**

Add to the CLI command list, matching the surrounding style:

- `macfleet up <name> [--preset light|standard|heavy]` — the preset defaults to the one configured in `~/.macfleet/config.json` (`standard` out of the box). Presets set cpu + RAM only; disk is grow-only so it is deliberately not a preset field.
- `macfleet reset [--all]` — delete every fleet VM, snapshot, and state file. Keeps `mf-golden` unless `--all` is passed, which also resets settings and forces a re-bake.

Add a short "Files" note documenting `~/.macfleet/`:

- `config.json` — settings (`default_preset`)
- `state.json` — TTL leases + suspended set
- `shares.json` — per-VM shared folders
- `activity.jsonl` — agent activity ring buffer
- `engine.log`, `engine.log.1` — the desktop app's engine sidecar output, current and previous run
- `operations/` — per-VM flock files

Note that the API additionally serves `GET/PUT /config`, `GET /doctor`, and `POST /data/reset`.

- [ ] **Step 2: Verify the whole suite is green**

Run: `make test-engine && make lint-engine`
Expected: PASS, no findings

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document config, doctor, and reset"
```

---

## Verification

After every task, `make test-engine` must pass. At the end of the plan, verify the new surface end to end against a real engine rather than trusting the unit tests:

```bash
uv run macfleet serve --port 8765 &
curl -s localhost:8765/config | python3 -m json.tool
curl -s -X PUT localhost:8765/config -H 'content-type: application/json' \
  -d '{"default_preset":"heavy"}' | python3 -m json.tool
curl -s localhost:8765/doctor | python3 -m json.tool
```

Expected: `/config` reports `standard` then `heavy`; `~/.macfleet/config.json` exists and contains `{"default_preset": "heavy"}`; `/doctor` returns eight checks whose statuses match reality on this machine (`arch` ok, `tart` ok, `golden` ok/fail depending on whether it is baked).

Do **not** verify `POST /data/reset` against a real fleet you care about. Test it with `--all` only on a machine whose golden you are willing to re-bake.
