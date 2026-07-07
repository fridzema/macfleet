# VM Management + MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stateful snapshots, suspend/resume, rename, duplicate, resource config, connection-info, in-guest exec, and TTL leases to the macfleet engine + HTTP API, and expose the full provision-and-drive loop through an in-process stdio MCP server.

**Architecture:** All logic lives in `Fleet` (engine); the HTTP API and MCP server are thin adapters over it. The MCP imports `macfleet` and calls `Fleet` in-process. Leases live in `~/.macfleet/state.json` and are swept lazily on every `list`/`create` (no daemon).

**Tech Stack:** Python 3.12, `tart` CLI, FastAPI, `mcp` (MCP Python SDK / FastMCP), pytest, ruff, uv.

## Global Constraints

- Python `>=3.12`; `from __future__ import annotations` at the top of every module.
- Strict typing; follow existing patterns in `macfleet/` (injected `Runner` callables for testability, `RuntimeError` on failure via `_run`).
- Fleet VMs are named `mf-<name>`; snapshots `mfsnap-<vm>-<label>`; golden template `mf-golden`. Use `fullname`/`shortname` from `macfleet/vm.py`.
- All new engine failures raise `RuntimeError`; the API's existing app-level handler maps them to HTTP 409 with CORS headers intact.
- Computer-use (`screenshot/click/type/key`) stays gated behind `MACFLEET_ALLOW_CONTROL=1` in engine, API, and MCP.
- Tests use pytest (not unittest), inject fakes, and never touch real `tart`, SSH, network, wall-clock time, or the real home directory.
- `mcp` is an optional `[mcp]` extra; base install and the desktop sidecar must not require it.
- `up` is kept and delegates to `create`; no deprecation.
- Commit after every task with a Conventional Commit message.

---

## File structure

- `macfleet/vm.py` (modify) — add `Tart.suspend/rename/set_config/get_config`; add `size` to `VmInfo`; add module `_run_nocheck`.
- `macfleet/leases.py` (create) — `Leases` store: record/expired/drop/rename over `~/.macfleet/state.json`, injected clock + path.
- `macfleet/connect.py` (modify) — new `Fleet` methods (suspend, resume, create, snapshot, snapshots, delete_snapshot, rename, duplicate, resources, set_resources, connection_info, exec, reap); wire the lease store + a non-checking runner.
- `macfleet/api.py` (modify) — new endpoints.
- `macfleet/mcp.py` (create) — MCP tool functions + FastMCP `build_server` + `main`.
- `macfleet/cli.py` (modify) — CLI commands for the new ops (used by L2/L3 manual tests).
- `pyproject.toml` (modify) — `[mcp]` extra + `macfleet-mcp` script.
- `README.md` (modify) — MCP registration + verification-ladder additions.
- `tests/test_vm.py`, `tests/test_leases.py` (create), `tests/test_connect.py`, `tests/test_api.py`, `tests/test_mcp.py` (create) — coverage per task.

---

## Task 1: Tart low-level commands

**Files:**
- Modify: `macfleet/vm.py`
- Test: `tests/test_vm.py`

**Interfaces:**
- Consumes: existing `Runner`, `_run`, `Tart`, `VmInfo`.
- Produces: `VmInfo(name, state, source, size=0.0)`; `_run_nocheck(argv) -> CompletedProcess`; `Tart.suspend(name)`, `Tart.rename(old, new)`, `Tart.set_config(name, *, cpu=None, memory=None, disk_size=None, display=None)`, `Tart.get_config(name) -> dict`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_vm.py  (append)
import subprocess
from macfleet.vm import Tart, VmInfo, _run_nocheck


def _capture():
    calls = []

    def run(argv):
        calls.append(argv)
        if argv[:2] == ["tart", "get"]:
            return subprocess.CompletedProcess(argv, 0, '{"CPU":4,"Memory":8192,"Disk":50,"Display":"1024x768","State":"stopped"}', "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    return calls, run


def test_suspend_and_rename_argv():
    calls, run = _capture()
    t = Tart(run=run)
    t.suspend("mf-a")
    t.rename("mf-a", "mf-b")
    assert ["tart", "suspend", "mf-a"] in calls
    assert ["tart", "rename", "mf-a", "mf-b"] in calls


def test_set_config_only_passes_given_flags():
    calls, run = _capture()
    Tart(run=run).set_config("mf-a", cpu=6, disk_size=80)
    assert calls[-1] == ["tart", "set", "mf-a", "--cpu", "6", "--disk-size", "80"]


def test_get_config_parses_json():
    _, run = _capture()
    cfg = Tart(run=run).get_config("mf-a")
    assert cfg["CPU"] == 4 and cfg["Memory"] == 8192 and cfg["State"] == "stopped"


def test_list_includes_size():
    def run(argv):
        return subprocess.CompletedProcess(argv, 0, '[{"Name":"mf-a","State":"running","Source":"local","Size":"12.5"}]', "")
    assert Tart(run=run).list()[0].size == 12.5


def test_run_nocheck_returns_nonzero_without_raising():
    # patch subprocess.run indirectly by calling a command that exits 1
    proc = _run_nocheck(["sh", "-c", "printf out; exit 3"])
    assert proc.returncode == 3 and proc.stdout == "out"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_vm.py -q`
Expected: FAIL (`AttributeError`/`ImportError` — `suspend`, `set_config`, `get_config`, `_run_nocheck`, `size` not defined).

- [ ] **Step 3: Implement in `macfleet/vm.py`**

Add the module function after `_run`:

```python
def _run_nocheck(argv: list[str]) -> "subprocess.CompletedProcess[str]":
    # Like _run but never raises — used for `tart exec`, where a nonzero exit is the
    # guest command's result, not a tart failure.
    return subprocess.run(argv, capture_output=True, text=True, check=False)
```

Change `VmInfo` to carry size (default keeps existing 3-arg construction working):

```python
@dataclass(frozen=True)
class VmInfo:
    name: str
    state: str
    source: str
    size: float = 0.0
```

Update `Tart.list` to populate size:

```python
    def list(self) -> list[VmInfo]:
        out = self._run(["tart", "list", "--format", "json"]).stdout
        return [
            VmInfo(v["Name"], v["State"], v.get("Source", ""), float(v.get("Size", 0) or 0))
            for v in json.loads(out)
        ]
```

Add the new `Tart` methods:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_vm.py -q` — Expected: PASS. Then `uv run ruff check macfleet/vm.py tests/test_vm.py` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add macfleet/vm.py tests/test_vm.py
git commit -m "feat(engine): add tart suspend/rename/get/set + VmInfo size + nocheck runner"
```

---

## Task 2: Lease store

**Files:**
- Create: `macfleet/leases.py`
- Test: `tests/test_leases.py`

**Interfaces:**
- Produces: `default_state_path() -> str`; `Leases(path: str, clock: Callable[[], float] = time.time)` with `record(name: str, ttl: float, source: str = "api")`, `expired(now: float) -> list[str]`, `drop(name: str)`, `rename(old: str, new: str)`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_leases.py
from macfleet.leases import Leases


def _leases(tmp_path):
    clock = {"t": 1000.0}
    lease = Leases(str(tmp_path / "state.json"), clock=lambda: clock["t"])
    return lease, clock


def test_record_then_expired(tmp_path):
    lease, clock = _leases(tmp_path)
    lease.record("mf-a", ttl=60)
    assert lease.expired(clock["t"]) == []
    clock["t"] = 1000 + 61
    assert lease.expired(clock["t"]) == ["mf-a"]


def test_drop_removes_lease(tmp_path):
    lease, clock = _leases(tmp_path)
    lease.record("mf-a", ttl=1)
    lease.drop("mf-a")
    assert lease.expired(clock["t"] + 999) == []


def test_rename_moves_key(tmp_path):
    lease, clock = _leases(tmp_path)
    lease.record("mf-a", ttl=1)
    lease.rename("mf-a", "mf-b")
    assert lease.expired(clock["t"] + 999) == ["mf-b"]


def test_missing_or_corrupt_file_is_empty(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{ not json")
    lease = Leases(str(path), clock=lambda: 0.0)
    assert lease.expired(1e12) == []  # no crash
    lease.record("mf-a", ttl=1)  # recovers and writes clean state
    assert lease.expired(1e12) == ["mf-a"]
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_leases.py -q` — Expected: FAIL (`ModuleNotFoundError: macfleet.leases`).

- [ ] **Step 3: Implement `macfleet/leases.py`**

```python
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
        os.makedirs(os.path.dirname(self._path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self._path))
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
        return [n for n, l in self._load().items() if l["expires_at"] < now]

    def drop(self, name: str) -> None:
        leases = self._load()
        if leases.pop(name, None) is not None:
            self._save(leases)

    def rename(self, old: str, new: str) -> None:
        leases = self._load()
        if old in leases:
            leases[new] = leases.pop(old)
            self._save(leases)
```

Note: a stdlib file lock (`fcntl.flock`) around `_load`/`_save` is a hardening follow-up; atomic replace already prevents torn reads, which is sufficient for the low-concurrency dev tool. Do not add it now (YAGNI).

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/test_leases.py -q` — Expected: PASS. `uv run ruff check macfleet/leases.py tests/test_leases.py` — clean.

- [ ] **Step 5: Commit**

```bash
git add macfleet/leases.py tests/test_leases.py
git commit -m "feat(engine): TTL lease store with atomic JSON persistence"
```

---

## Task 3: Fleet lifecycle — suspend/resume, create, reap

**Files:**
- Modify: `macfleet/connect.py`
- Test: `tests/test_connect.py`

**Interfaces:**
- Consumes: Task 1 (`Tart.suspend`, `_run_nocheck`), Task 2 (`Leases`, `default_state_path`).
- Produces: `Fleet(__init__ ... run_nocheck=_run_nocheck, leases=None, clock=time.time)`; `Fleet.suspend(name)`, `Fleet.resume(name)`, `Fleet.create(name, from_snapshot=None, ttl=None)`, `Fleet.reap() -> list[str]`, `Fleet._state(full_name) -> str`. `up(name)` now delegates to `create`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_connect.py  (append)
import subprocess
from macfleet.connect import Fleet
from macfleet.leases import Leases
from macfleet.vm import Tart, VmInfo


def _fleet(tmp_path, vms=(), clock_val=1000.0):
    calls = []
    listing = list(vms)

    def run(argv):
        calls.append(argv)
        if argv[:2] == ["tart", "list"]:
            import json as j
            return subprocess.CompletedProcess(argv, 0, j.dumps(
                [{"Name": v.name, "State": v.state, "Source": v.source, "Size": v.size} for v in listing]), "")
        if argv[:2] == ["tart", "get"]:
            return subprocess.CompletedProcess(argv, 0, '{"State":"running"}', "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    spawned = []
    lease = Leases(str(tmp_path / "state.json"), clock=lambda: clock_val)
    fleet = Fleet(tart=Tart(run=run), run=run, spawn=spawned.append,
                  leases=lease, clock=lambda: clock_val)
    return fleet, calls, spawned, lease


def test_suspend_resume(tmp_path):
    fleet, calls, spawned, _ = _fleet(tmp_path)
    fleet.suspend("web")
    fleet.resume("web")
    assert ["tart", "suspend", "mf-web"] in calls
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned


def test_create_clones_golden_and_records_ttl(tmp_path):
    fleet, calls, spawned, lease = _fleet(tmp_path)
    fleet.create("web", ttl=60)
    assert ["tart", "clone", "mf-golden", "mf-web"] in calls
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned
    assert lease.expired(1000 + 61) == ["mf-web"]


def test_create_from_snapshot(tmp_path):
    fleet, calls, _, _ = _fleet(tmp_path)
    fleet.create("web", from_snapshot="base-clean")
    assert ["tart", "clone", "mfsnap-base-clean", "mf-web"] in calls


def test_up_delegates_to_create(tmp_path):
    fleet, calls, _, _ = _fleet(tmp_path)
    fleet.up("web")
    assert ["tart", "clone", "mf-golden", "mf-web"] in calls


def test_reap_deletes_expired(tmp_path):
    fleet, calls, _, lease = _fleet(tmp_path, vms=[VmInfo("mf-old", "running", "local")], clock_val=2000.0)
    lease.record("mf-old", ttl=-1)  # already expired at t=2000
    reaped = fleet.reap()
    assert reaped == ["mf-old"]
    assert ["tart", "delete", "mf-old"] in calls
    assert lease.expired(1e12) == []
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_connect.py -q -k "suspend_resume or create or reap or delegates"` — Expected: FAIL.

- [ ] **Step 3: Implement in `macfleet/connect.py`**

Add imports at top: `import time` and `from macfleet.leases import Leases, default_state_path` and `from macfleet.vm import ... _run_nocheck` (extend the existing `from macfleet.vm import` line to include `_run_nocheck`).

Replace `Fleet.__init__` and `up`, and add the new methods:

```python
    def __init__(self, tart: Tart | None = None, run: Runner = _run,
                 spawn: Callable[[list[str]], None] = _spawn,
                 run_nocheck: Runner = _run_nocheck,
                 leases: Leases | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self.tart = tart or Tart(run=run)
        self._run = run
        self._spawn = spawn
        self._run_nocheck = run_nocheck
        self._leases = leases or Leases(default_state_path())
        self._clock = clock

    def _state(self, full: str) -> str:
        return self.tart.get_config(full)["State"]

    def suspend(self, name: str) -> None:
        self.tart.suspend(fullname(name))

    def resume(self, name: str) -> None:
        self._spawn(["tart", "run", fullname(name), "--no-graphics"])

    def create(self, name: str, from_snapshot: str | None = None,
               ttl: float | None = None) -> None:
        self.reap()
        target = fullname(name)
        if target not in {v.name for v in self.tart.list()}:
            src = f"mfsnap-{from_snapshot}" if from_snapshot else "mf-golden"
            self.tart.clone(src, target)
        self._spawn(["tart", "run", target, "--no-graphics"])
        if ttl is not None:
            self._leases.record(target, ttl)

    def up(self, name: str) -> None:
        self.create(name)

    def reap(self) -> list[str]:
        now = self._clock()
        existing = {v.name for v in self.tart.list()}
        reaped = []
        for full in self._leases.expired(now):
            if full in existing:
                try:
                    self.nuke(shortname(full))
                except RuntimeError:
                    pass
            self._leases.drop(full)
            reaped.append(full)
        return reaped
```

(Keep existing `down`, `nuke`, `ip`, `ssh`, `status`, `logs`, `computer`, `GuestControl`.) Note `reap` calls `self.tart.list()` and `create` calls `reap` then `list` — acceptable; the fake returns the same listing.

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/test_connect.py -q` — Expected: PASS (existing connect tests unaffected). `uv run ruff check macfleet/connect.py` — clean.

- [ ] **Step 5: Commit**

```bash
git add macfleet/connect.py tests/test_connect.py
git commit -m "feat(engine): suspend/resume, generalized create + TTL leases with lazy reap"
```

---

## Task 4: Fleet snapshots

**Files:**
- Modify: `macfleet/connect.py`
- Test: `tests/test_connect.py`

**Interfaces:**
- Consumes: Task 3 (`_state`, `_spawn`, `tart.suspend/clone/stop/list/delete`).
- Produces: `Fleet.snapshot(name, label) -> str`, `Fleet.snapshots() -> list[dict]`, `Fleet.delete_snapshot(snapshot_id)`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_connect.py  (append)
def test_snapshot_running_vm_suspends_clones_resumes(tmp_path):
    fleet, calls, spawned, _ = _fleet(tmp_path)  # _state returns "running" via fake
    sid = fleet.snapshot("web", "clean")
    assert sid == "web-clean"
    assert calls.index(["tart", "suspend", "mf-web"]) < calls.index(["tart", "clone", "mf-web", "mfsnap-web-clean"])
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned  # resumed original


def test_snapshot_falls_back_to_stop_when_suspend_fails(tmp_path):
    calls = []

    def run(argv):
        calls.append(argv)
        if argv[:2] == ["tart", "get"]:
            return subprocess.CompletedProcess(argv, 0, '{"State":"running"}', "")
        if argv[:2] == ["tart", "suspend"]:
            raise RuntimeError("suspend unsupported")
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, "[]", "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, spawn=lambda a: None,
                  leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0), clock=lambda: 0.0)
    fleet.snapshot("web", "clean")
    assert ["tart", "stop", "mf-web"] in calls  # clean-disk fallback


def test_snapshots_lists_and_parses(tmp_path):
    fleet, _, _, _ = _fleet(tmp_path, vms=[
        VmInfo("mfsnap-web-clean", "stopped", "local", 3.2),
        VmInfo("mf-web", "running", "local"),
    ])
    snaps = fleet.snapshots()
    assert snaps == [{"id": "web-clean", "vm": "web", "label": "clean", "size": 3.2}]


def test_delete_snapshot(tmp_path):
    fleet, calls, _, _ = _fleet(tmp_path)
    fleet.delete_snapshot("web-clean")
    assert ["tart", "delete", "mfsnap-web-clean"] in calls
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_connect.py -q -k snapshot` — Expected: FAIL.

- [ ] **Step 3: Implement in `macfleet/connect.py`**

```python
    def snapshot(self, name: str, label: str) -> str:
        src = fullname(name)
        was_running = self._state(src) == "running"
        if was_running:
            try:
                self.tart.suspend(src)
            except RuntimeError:
                self.tart.stop(src)  # clean-disk fallback if the image can't suspend
        self.tart.clone(src, f"mfsnap-{shortname(name)}-{label}")
        if was_running:
            self._spawn(["tart", "run", src, "--no-graphics"])  # resume original
        return f"{shortname(name)}-{label}"

    def snapshots(self) -> list[dict]:
        out = []
        for v in self.tart.list():
            if v.name.startswith("mfsnap-"):
                sid = v.name[len("mfsnap-"):]
                vm, _, label = sid.partition("-")
                out.append({"id": sid, "vm": vm, "label": label, "size": v.size})
        return out

    def delete_snapshot(self, snapshot_id: str) -> None:
        self.tart.delete(f"mfsnap-{snapshot_id}")
```

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_connect.py -q` PASS; `ruff` clean.

- [ ] **Step 5: Commit**

```bash
git add macfleet/connect.py tests/test_connect.py
git commit -m "feat(engine): stateful snapshots (suspend+clone) with clean-disk fallback"
```

---

## Task 5: Fleet identity, resources, access

**Files:**
- Modify: `macfleet/connect.py`
- Test: `tests/test_connect.py`

**Interfaces:**
- Produces: `Fleet.rename(old, new)`, `Fleet.duplicate(name, new)`, `Fleet.resources(name) -> dict`, `Fleet.set_resources(name, cpu=None, memory=None, disk_size=None, display=None)`, `Fleet.connection_info(name) -> dict`, `Fleet.exec(name, command) -> dict`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_connect.py  (append)
def test_rename_moves_vm_and_lease(tmp_path):
    fleet, calls, _, lease = _fleet(tmp_path)
    lease.record("mf-web", ttl=999)
    fleet.rename("web", "prod")
    assert ["tart", "rename", "mf-web", "mf-prod"] in calls
    assert lease.expired(1e12) == ["mf-prod"]


def test_duplicate_stateful(tmp_path):
    fleet, calls, spawned, _ = _fleet(tmp_path)  # _state -> running
    fleet.duplicate("web", "web2")
    assert ["tart", "clone", "mf-web", "mf-web2"] in calls
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned
    assert ["tart", "run", "mf-web2", "--no-graphics"] in spawned


def test_resources_parses_get(tmp_path):
    def run(argv):
        return subprocess.CompletedProcess(argv, 0,
            '{"CPU":6,"Memory":16384,"Disk":80,"Display":"1920x1080","State":"stopped"}', "")
    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    assert fleet.resources("web") == {"cpu": 6, "memory_mb": 16384, "disk_gb": 80,
                                      "display": "1920x1080", "state": "stopped"}


def test_set_resources_rejects_running(tmp_path):
    def run(argv):
        return subprocess.CompletedProcess(argv, 0, '{"State":"running","CPU":4,"Memory":8192,"Disk":50,"Display":"x"}', "")
    from macfleet.leases import Leases
    import pytest
    fleet = Fleet(tart=Tart(run=run), run=run, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    with pytest.raises(RuntimeError, match="stop the VM"):
        fleet.set_resources("web", cpu=8)


def test_set_resources_sets_when_stopped(tmp_path):
    calls = []
    def run(argv):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, '{"State":"stopped","CPU":4,"Memory":8192,"Disk":50,"Display":"x"}', "")
    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    fleet.set_resources("web", cpu=8, memory=16384)
    assert calls[-1] == ["tart", "set", "mf-web", "--cpu", "8", "--memory", "16384"]


def test_connection_info(tmp_path):
    def run(argv):
        if argv[:2] == ["tart", "ip"]:
            return subprocess.CompletedProcess(argv, 0, "192.168.64.9\n", "")
        return subprocess.CompletedProcess(argv, 0, "", "")
    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    info = fleet.connection_info("web")
    assert info["ip"] == "192.168.64.9"
    assert info["ssh"] == "ssh admin@192.168.64.9"
    assert info["guest_server"] == "http://192.168.64.9:8000"
    assert info["exec"] is True


def test_exec_returns_stdout_and_exit_code(tmp_path):
    def nocheck(argv):
        assert argv[:3] == ["tart", "exec", "mf-web"]
        assert argv[3:] == ["/bin/sh", "-lc", "echo hi"]
        return subprocess.CompletedProcess(argv, 2, "hi\n", "")
    from macfleet.leases import Leases
    fleet = Fleet(run=lambda a: subprocess.CompletedProcess(a, 0, "", ""),
                  run_nocheck=nocheck, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    assert fleet.exec("web", "echo hi") == {"stdout": "hi\n", "exit_code": 2}
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_connect.py -q -k "rename or duplicate or resources or connection or exec"` FAIL.

- [ ] **Step 3: Implement in `macfleet/connect.py`**

```python
    def rename(self, old: str, new: str) -> None:
        self.tart.rename(fullname(old), fullname(new))
        self._leases.rename(fullname(old), fullname(new))

    def duplicate(self, name: str, new: str) -> None:
        src = fullname(name)
        was_running = self._state(src) == "running"
        if was_running:
            try:
                self.tart.suspend(src)
            except RuntimeError:
                self.tart.stop(src)
        self.tart.clone(src, fullname(new))
        if was_running:
            self._spawn(["tart", "run", src, "--no-graphics"])
            self._spawn(["tart", "run", fullname(new), "--no-graphics"])

    def resources(self, name: str) -> dict:
        c = self.tart.get_config(fullname(name))
        return {"cpu": c["CPU"], "memory_mb": c["Memory"], "disk_gb": c["Disk"],
                "display": c["Display"], "state": c["State"]}

    def set_resources(self, name: str, cpu: int | None = None, memory: int | None = None,
                      disk_size: int | None = None, display: str | None = None) -> None:
        if self.resources(name)["state"] == "running":
            raise RuntimeError("stop the VM before changing resources")
        self.tart.set_config(fullname(name), cpu=cpu, memory=memory,
                             disk_size=disk_size, display=display)

    def connection_info(self, name: str) -> dict:
        ip = self.ip(name)
        return {"ip": ip, "ssh": f"ssh {GUEST_USER}@{ip}",
                "vnc": f"open vnc://{GUEST_USER}@{ip}",
                "guest_server": f"http://{ip}:{SERVER_PORT}", "exec": True}

    def exec(self, name: str, command: str) -> dict:
        proc = self._run_nocheck(["tart", "exec", fullname(name), "/bin/sh", "-lc", command])
        return {"stdout": proc.stdout, "exit_code": proc.returncode}
```

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_connect.py -q` PASS; `ruff` clean.

- [ ] **Step 5: Commit**

```bash
git add macfleet/connect.py tests/test_connect.py
git commit -m "feat(engine): rename, duplicate, resources get/set, connection-info, exec"
```

---

## Task 6: HTTP API endpoints

**Files:**
- Modify: `macfleet/api.py`
- Test: `tests/test_api.py`

**Interfaces:**
- Consumes: all Task 3-5 `Fleet` methods.
- Produces: the endpoints in the spec's API table. Extends the test `FakeFleet` with the new methods.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_api.py  (append; extend FakeFleet in place first — see Step 3)
def test_create_from_snapshot_with_ttl():
    fake = FakeFleet()
    r = TestClient(build_app(fake)).post("/vms", json={"name": "web", "from_snapshot": "base", "ttl": 60})
    assert r.status_code == 200
    assert ("create", "web", "base", 60) in fake.calls


def test_suspend_resume_endpoints():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    assert client.post("/vms/web/suspend").json() == {"ok": True}
    assert client.post("/vms/web/resume").json() == {"ok": True}
    assert ("suspend", "web") in fake.calls and ("resume", "web") in fake.calls


def test_snapshot_endpoints():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    assert client.post("/vms/web/snapshot", json={"label": "clean"}).json() == {"snapshot_id": "web-clean"}
    assert client.get("/snapshots").json() == [{"id": "web-clean", "vm": "web", "label": "clean", "size": 1.0}]
    assert client.delete("/snapshots/web-clean").json() == {"ok": True}


def test_rename_duplicate_endpoints():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    assert client.post("/vms/web/rename", json={"new": "prod"}).json() == {"ok": True}
    assert client.post("/vms/web/duplicate", json={"new": "web2"}).json() == {"ok": True}


def test_resources_endpoints_and_409_when_running():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    assert client.get("/vms/web/resources").json()["cpu"] == 4
    assert client.put("/vms/web/resources", json={"cpu": 8}).json() == {"ok": True}
    fake.set_resources_error = RuntimeError("stop the VM before changing resources")
    assert client.put("/vms/web/resources", json={"cpu": 8}).status_code == 409


def test_connection_and_exec_endpoints():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    assert client.get("/vms/web/connection").json()["ssh"] == "ssh admin@1.2.3.4"
    assert client.post("/vms/web/exec", json={"command": "uname"}).json() == {"stdout": "ok", "exit_code": 0}
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_api.py -q -k "create_from or suspend_resume_endpoints or snapshot_endpoints or rename_duplicate or resources_endpoints or connection_and_exec"` FAIL.

- [ ] **Step 3: Extend `FakeFleet` in `tests/test_api.py`**

Add these to the existing `FakeFleet` class (keep existing methods):

```python
    def __init__(self, vms=None, healthy=("a",), computer_obj=None, computer_error=None,
                 up_error=None):
        # ... existing body ...
        self.set_resources_error = None

    def create(self, name, from_snapshot=None, ttl=None):
        self.calls.append(("create", name, from_snapshot, ttl))

    def suspend(self, name): self.calls.append(("suspend", name))
    def resume(self, name): self.calls.append(("resume", name))
    def snapshot(self, name, label): self.calls.append(("snapshot", name, label)); return f"{name}-{label}"
    def snapshots(self): return [{"id": "web-clean", "vm": "web", "label": "clean", "size": 1.0}]
    def delete_snapshot(self, sid): self.calls.append(("delete_snapshot", sid))
    def rename(self, old, new): self.calls.append(("rename", old, new))
    def duplicate(self, name, new): self.calls.append(("duplicate", name, new))
    def resources(self, name): return {"cpu": 4, "memory_mb": 8192, "disk_gb": 50, "display": "x", "state": "stopped"}
    def set_resources(self, name, cpu=None, memory=None, disk_size=None, display=None):
        if self.set_resources_error: raise self.set_resources_error
        self.calls.append(("set_resources", name, cpu, memory, disk_size, display))
    def connection_info(self, name): return {"ip": "1.2.3.4", "ssh": "ssh admin@1.2.3.4", "vnc": "open vnc://admin@1.2.3.4", "guest_server": "http://1.2.3.4:8000", "exec": True}
    def exec(self, name, command): return {"stdout": "ok", "exit_code": 0}
```

- [ ] **Step 4: Implement endpoints in `macfleet/api.py`**

Add Pydantic bodies near the existing ones:

```python
class CreateRequest(BaseModel):
    name: str
    from_snapshot: str | None = None
    ttl: float | None = None


class LabelRequest(BaseModel):
    label: str


class RenameRequest(BaseModel):
    new: str


class ResourcesRequest(BaseModel):
    cpu: int | None = None
    memory: int | None = None
    disk_size: int | None = None
    display: str | None = None


class ExecRequest(BaseModel):
    command: str
```

Add routes inside `build_app` (after the existing `/vms` routes; the app-level RuntimeError handler already maps failures to 409):

```python
    @api.post("/vms")
    def create(body: CreateRequest) -> dict:
        fleet.create(body.name, from_snapshot=body.from_snapshot, ttl=body.ttl)
        return {"ok": True}

    @api.post("/vms/{name}/suspend")
    def suspend(name: str) -> dict:
        fleet.suspend(name)
        return {"ok": True}

    @api.post("/vms/{name}/resume")
    def resume(name: str) -> dict:
        fleet.resume(name)
        return {"ok": True}

    @api.post("/vms/{name}/snapshot")
    def snapshot(name: str, body: LabelRequest) -> dict:
        return {"snapshot_id": fleet.snapshot(name, body.label)}

    @api.get("/snapshots")
    def list_snapshots() -> list[dict]:
        return fleet.snapshots()

    @api.delete("/snapshots/{snapshot_id}")
    def delete_snapshot(snapshot_id: str) -> dict:
        fleet.delete_snapshot(snapshot_id)
        return {"ok": True}

    @api.post("/vms/{name}/rename")
    def rename(name: str, body: RenameRequest) -> dict:
        fleet.rename(name, body.new)
        return {"ok": True}

    @api.post("/vms/{name}/duplicate")
    def duplicate(name: str, body: RenameRequest) -> dict:
        fleet.duplicate(name, body.new)
        return {"ok": True}

    @api.get("/vms/{name}/resources")
    def get_resources(name: str) -> dict:
        return fleet.resources(name)

    @api.put("/vms/{name}/resources")
    def put_resources(name: str, body: ResourcesRequest) -> dict:
        fleet.set_resources(name, cpu=body.cpu, memory=body.memory,
                            disk_size=body.disk_size, display=body.display)
        return {"ok": True}

    @api.get("/vms/{name}/connection")
    def connection(name: str) -> dict:
        return fleet.connection_info(name)

    @api.post("/vms/{name}/exec")
    def exec_cmd(name: str, body: ExecRequest) -> dict:
        return fleet.exec(name, body.command)
```

- [ ] **Step 5: Run + commit**

Run: `uv run pytest tests/test_api.py -q` PASS; `uv run ruff check macfleet/api.py tests/test_api.py` clean.

```bash
git add macfleet/api.py tests/test_api.py
git commit -m "feat(api): endpoints for create/suspend/resume/snapshot/rename/duplicate/resources/connection/exec"
```

---

## Task 7: MCP server

**Files:**
- Create: `macfleet/mcp.py`
- Modify: `pyproject.toml`
- Test: `tests/test_mcp.py`

**Interfaces:**
- Consumes: all `Fleet` methods.
- Produces: tool functions `mcp_list_vms(fleet)`, `mcp_create_vm(fleet, name, from_snapshot=None, ttl_seconds=None)`, ... (one per operation, each taking `fleet` as first arg and returning JSON-able data); `build_server(fleet=None) -> FastMCP`; `main()`.

Rationale: the tool *logic* lives in top-level `mcp_*` functions that take `fleet` explicitly, so they're unit-testable with a fake. `build_server` registers thin FastMCP wrappers that close over a real `fleet` and delegate to these functions. The stdio transport itself is verified at L3, not in unit tests.

- [ ] **Step 1: Add the `[mcp]` extra to `pyproject.toml`**

Under `[project.optional-dependencies]` add:

```toml
mcp = ["mcp>=1.0"]
```

Under `[project.scripts]` add:

```toml
macfleet-mcp = "macfleet.mcp:main"
```

Then: `uv sync --extra dev --extra mcp` (installs the MCP SDK for tests). Expected: resolves, `python -c "import mcp.server.fastmcp"` succeeds.

- [ ] **Step 2: Write the failing tests**

```python
# tests/test_mcp.py
import pytest
from macfleet import mcp as M


class FakeFleet:
    def __init__(self):
        self.calls = []

    def list_vms(self): return [{"name": "mf-a", "state": "running", "healthy": True}]
    def create(self, name, from_snapshot=None, ttl=None): self.calls.append(("create", name, from_snapshot, ttl))
    def snapshot(self, name, label): self.calls.append(("snapshot", name, label)); return f"{name}-{label}"
    def snapshots(self): return [{"id": "a-clean", "vm": "a", "label": "clean", "size": 2.0}]
    def exec(self, name, command): self.calls.append(("exec", name, command)); return {"stdout": "hi", "exit_code": 0}
    def resources(self, name): return {"cpu": 4, "memory_mb": 8192, "disk_gb": 50, "display": "x", "state": "running"}


def test_list_vms_tool():
    assert M.mcp_list_vms(FakeFleet())[0]["name"] == "mf-a"


def test_create_vm_tool_maps_ttl_seconds():
    fake = FakeFleet()
    M.mcp_create_vm(fake, name="web", from_snapshot="base", ttl_seconds=60)
    assert ("create", "web", "base", 60) in fake.calls


def test_snapshot_tool_returns_id():
    assert M.mcp_snapshot(FakeFleet(), name="web", label="clean") == {"snapshot_id": "web-clean"}


def test_exec_tool_returns_output():
    assert M.mcp_exec(FakeFleet(), name="web", command="uname") == {"stdout": "hi", "exit_code": 0}


def test_build_server_registers_tools():
    server = M.build_server(FakeFleet())
    names = {t.name for t in server._tool_manager.list_tools()}
    assert {"list_vms", "create_vm", "snapshot", "exec"} <= names
```

- [ ] **Step 3: Run to verify failure** — `uv run pytest tests/test_mcp.py -q` FAIL (`ModuleNotFoundError: macfleet.mcp`).

- [ ] **Step 4: Implement `macfleet/mcp.py`**

```python
from __future__ import annotations

import os

from mcp.server.fastmcp import FastMCP, Image

from macfleet.connect import Fleet


# --- Tool logic (fleet-injected, unit-testable) ---------------------------------

def mcp_list_vms(fleet) -> list[dict]:
    return fleet.list_vms()


def mcp_create_vm(fleet, name: str, from_snapshot: str | None = None,
                  ttl_seconds: int | None = None) -> dict:
    fleet.create(name, from_snapshot=from_snapshot, ttl=ttl_seconds)
    return {"ok": True, "name": name}


def mcp_snapshot(fleet, name: str, label: str) -> dict:
    return {"snapshot_id": fleet.snapshot(name, label)}


def mcp_exec(fleet, name: str, command: str) -> dict:
    return fleet.exec(name, command)


# --- FastMCP server -------------------------------------------------------------

def build_server(fleet: Fleet | None = None) -> FastMCP:
    fleet = fleet or Fleet()
    mcp = FastMCP("macfleet")

    @mcp.tool()
    def list_vms() -> list[dict]:
        """List fleet VMs with state and health."""
        return mcp_list_vms(fleet)

    @mcp.tool()
    def create_vm(name: str, from_snapshot: str | None = None,
                  ttl_seconds: int | None = None) -> dict:
        """Create/clone a fleet VM and boot it. from_snapshot: a snapshot id from
        list_snapshots (resumes its captured state). ttl_seconds: auto-delete after N
        seconds (use for throwaway agent VMs)."""
        return mcp_create_vm(fleet, name, from_snapshot, ttl_seconds)

    @mcp.tool()
    def up(name: str) -> dict:
        """Boot a fleet VM (clone mf-golden if it doesn't exist)."""
        fleet.up(name)
        return {"ok": True}

    @mcp.tool()
    def down(name: str) -> dict:
        """Stop a fleet VM."""
        fleet.down(name)
        return {"ok": True}

    @mcp.tool()
    def suspend(name: str) -> dict:
        """Suspend a fleet VM (freeze running state to disk)."""
        fleet.suspend(name)
        return {"ok": True}

    @mcp.tool()
    def resume(name: str) -> dict:
        """Resume a suspended fleet VM."""
        fleet.resume(name)
        return {"ok": True}

    @mcp.tool()
    def delete_vm(name: str) -> dict:
        """Stop and permanently delete a fleet VM. Irreversible."""
        fleet.nuke(name)
        return {"ok": True}

    @mcp.tool()
    def rename_vm(name: str, new: str) -> dict:
        """Rename a fleet VM."""
        fleet.rename(name, new)
        return {"ok": True}

    @mcp.tool()
    def duplicate_vm(name: str, new: str) -> dict:
        """Duplicate a fleet VM (stateful copy of its current running state)."""
        fleet.duplicate(name, new)
        return {"ok": True}

    @mcp.tool()
    def get_resources(name: str) -> dict:
        """Get a VM's cpu/memory/disk/display/state."""
        return fleet.resources(name)

    @mcp.tool()
    def set_resources(name: str, cpu: int | None = None, memory: int | None = None,
                      disk_size: int | None = None, display: str | None = None) -> dict:
        """Set a VM's resources. The VM must be stopped. Disk can only grow."""
        fleet.set_resources(name, cpu=cpu, memory=memory, disk_size=disk_size, display=display)
        return {"ok": True}

    @mcp.tool()
    def snapshot(name: str, label: str) -> dict:
        """Snapshot a fleet VM's current state. Returns a snapshot id usable as
        create_vm(from_snapshot=...)."""
        return mcp_snapshot(fleet, name, label)

    @mcp.tool()
    def list_snapshots() -> list[dict]:
        """List snapshots."""
        return fleet.snapshots()

    @mcp.tool()
    def create_from_snapshot(snapshot_id: str, name: str, ttl_seconds: int | None = None) -> dict:
        """Create a new fleet VM from a snapshot; it resumes to the captured state."""
        return mcp_create_vm(fleet, name, snapshot_id, ttl_seconds)

    @mcp.tool()
    def delete_snapshot(snapshot_id: str) -> dict:
        """Delete a snapshot. Irreversible."""
        fleet.delete_snapshot(snapshot_id)
        return {"ok": True}

    @mcp.tool()
    def get_connection(name: str) -> dict:
        """Get connection info (ip, ssh command, vnc, guest server URL) for a VM."""
        return fleet.connection_info(name)

    @mcp.tool()
    def exec(name: str, command: str) -> dict:
        """Run a shell command inside a fleet VM via the guest agent. Returns
        {stdout, exit_code}. No SSH keys required."""
        return mcp_exec(fleet, name, command)

    if os.environ.get("MACFLEET_ALLOW_CONTROL") == "1":
        @mcp.tool()
        def screenshot(name: str) -> Image:
            """Capture the VM's screen as a PNG (computer-use)."""
            return Image(data=fleet.computer(name).screenshot(), format="png")

        @mcp.tool()
        def click(name: str, x: int, y: int) -> dict:
            """Click at pixel (x, y) in the VM."""
            fleet.computer(name).click(x, y)
            return {"ok": True}

        @mcp.tool()
        def type_text(name: str, text: str) -> dict:
            """Type text into the VM."""
            fleet.computer(name).type(text)
            return {"ok": True}

        @mcp.tool()
        def key(name: str, combo: str) -> dict:
            """Press a key/combo (e.g. 'cmd+space') in the VM."""
            fleet.computer(name).key(combo)
            return {"ok": True}

    return mcp


def main() -> None:
    build_server().run()
```

- [ ] **Step 5: Run + commit**

Run: `uv run pytest tests/test_mcp.py -q` PASS; `uv run ruff check macfleet/mcp.py tests/test_mcp.py` clean.
If `server._tool_manager.list_tools()` differs in the installed SDK version, adjust the introspection in `test_build_server_registers_tools` to the SDK's API (e.g. `await server.list_tools()`), keeping the assertion that the four tool names are registered.

```bash
git add macfleet/mcp.py tests/test_mcp.py pyproject.toml uv.lock
git commit -m "feat(mcp): stdio MCP server exposing the full VM provision-and-drive loop"
```

---

## Task 8: CLI commands + README

**Files:**
- Modify: `macfleet/cli.py`, `README.md`
- Test: `tests/test_cli.py`

**Interfaces:**
- Consumes: `Fleet` methods; existing Typer `app` and `_fleet()`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_cli.py  (append)
from typer.testing import CliRunner
from macfleet.cli import app
import macfleet.cli as climod


def test_snapshot_command(monkeypatch):
    calls = {}

    class FakeFleet:
        tart = None
        def snapshot(self, name, label): calls["snap"] = (name, label); return f"{name}-{label}"

    monkeypatch.setattr(climod, "_fleet", lambda: FakeFleet())
    result = CliRunner().invoke(app, ["snapshot", "web", "clean"])
    assert result.exit_code == 0
    assert calls["snap"] == ("web", "clean")
    assert "web-clean" in result.stdout
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_cli.py -q -k snapshot_command` FAIL.

- [ ] **Step 3: Add CLI commands in `macfleet/cli.py`**

```python
@app.command()
def suspend(name: str) -> None:
    """Suspend mf-<name> (freeze running state)."""
    _fleet().suspend(name)


@app.command()
def resume(name: str) -> None:
    """Resume a suspended mf-<name>."""
    _fleet().resume(name)


@app.command()
def snapshot(name: str, label: str) -> None:
    """Snapshot mf-<name>; prints the snapshot id."""
    typer.echo(_fleet().snapshot(name, label))


@app.command()
def snapshots() -> None:
    """List snapshots."""
    for s in _fleet().snapshots():
        typer.echo(f"{s['id']:24} {s['size']}G")


@app.command()
def clone(snapshot_id: str, name: str) -> None:
    """Create mf-<name> from a snapshot (resumes captured state)."""
    _fleet().create(name, from_snapshot=snapshot_id)
    typer.echo(f"up: mf-{name}")


@app.command()
def rename(old: str, new: str) -> None:
    """Rename mf-<old> to mf-<new>."""
    _fleet().rename(old, new)


@app.command()
def duplicate(name: str, new: str) -> None:
    """Duplicate mf-<name> to mf-<new>."""
    _fleet().duplicate(name, new)


@app.command()
def exec(name: str, command: str) -> None:
    """Run a shell command in mf-<name> via the guest agent."""
    out = _fleet().exec(name, command)
    typer.echo(out["stdout"], nl=False)
    raise typer.Exit(out["exit_code"])


@app.command()
def connect(name: str) -> None:
    """Print how to connect to mf-<name>."""
    for k, v in _fleet().connection_info(name).items():
        typer.echo(f"{k}: {v}")
```

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_cli.py -q` PASS; `uv run ruff check macfleet/cli.py` clean.

- [ ] **Step 5: Update `README.md`**

Add a "Snapshots & fast spin-up" note (stateful snapshots, `macfleet snapshot`/`clone`, TTL leases), an "MCP server" section:

````markdown
## MCP server (for AI agents)

Expose the fleet to an AI agent:

```bash
claude mcp add macfleet -- uv run --extra mcp macfleet-mcp
```

Tools cover the full loop: list/create (incl. `from_snapshot`, `ttl_seconds`),
up/down/suspend/resume/delete, snapshot/list_snapshots/create_from_snapshot,
rename/duplicate, get/set_resources, get_connection, exec, and — when
`MACFLEET_ALLOW_CONTROL=1` — screenshot/click/type/key.
````

Add to the verification ladder: L2 snapshot→clone→resume roundtrip; L2 `macfleet exec web "sw_vers"`; L3 MCP end-to-end.

- [ ] **Step 6: Commit**

```bash
git add macfleet/cli.py tests/test_cli.py README.md
git commit -m "feat(cli): snapshot/suspend/resume/clone/rename/duplicate/exec/connect commands + docs"
```

---

## Final verification (after all tasks)

- [ ] `make test` — full offline suite green.
- [ ] `uv run ruff check .` — clean.
- [ ] **L2 (real hardware, validates the core premise):** `uv run macfleet up base && uv run macfleet exec base "echo hi"` → prints `hi`; `uv run macfleet snapshot base ready` → prints `base-ready`; `uv run macfleet clone base-ready copy` → `copy` resumes to the captured state (confirm via screenshot or `exec copy "uptime"`). If resume fails, switch `snapshot`/`duplicate` to stop-instead-of-suspend (tests assert argv, so only the fallback branch changes).
- [ ] **L3:** `claude mcp add macfleet -- uv run --extra mcp macfleet-mcp`, then from an agent: `list_vms` → `create_from_snapshot` → `exec` → `screenshot` → `delete_vm`.
- [ ] Merge branch `vm-management-and-mcp` to `main`.

## Self-review notes (addressed)

- **Spec coverage:** suspend/resume (T3), stateful snapshot + fallback (T4), create-from-snapshot (T3/T4), rename/duplicate (T5), resources get/set + 409 (T5/T6), connection-info (T5), exec (T5), TTL leases + lazy reap (T2/T3), API (T6), MCP full loop incl. gated computer-use (T7), CLI + docs (T8). All covered.
- **Naming consistency:** `mfsnap-<vm>-<label>` and snapshot id `<vm>-<label>` used identically across engine, API, MCP, CLI. `set_resources` signature identical in Fleet/API/MCP. `create(name, from_snapshot, ttl)` identical everywhere.
- **Validation flagged:** stateful-clone-resume, `rename`/`set` preconditions (encoded as the running-check 409), `exec` exit codes (via `_run_nocheck`).
