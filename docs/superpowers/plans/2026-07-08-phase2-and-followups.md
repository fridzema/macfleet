# Phase 2 (gap backends + follow-ups) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the four interface stubs real (agent-activity feed, suspended-state, live per-VM metrics, host Σ-RAM) and close five follow-ups.

**Architecture:** All logic in the `Fleet` engine + shared on-disk state (`~/.macfleet/state.json`, `~/.macfleet/activity.jsonl`); the HTTP API and MCP are thin adapters; the desktop consumes new endpoints. The MCP writes agent activity; the API reads it. `list_vms` gains a lazy per-VM resources cache so it stays fast.

**Tech Stack:** Python 3.12 / FastAPI / `tart`; Vue 3 / Pinia / Tailwind v4 / Vite / Vitest / Playwright; `uv`, `bun`.

## Global Constraints

- Python `>=3.12`, `from __future__ import annotations`, strict typing; engine failures raise `RuntimeError` (API maps → 409). Tests fake-only (no real tart/network/wall-clock/home-dir; inject runners, clock, paths).
- Shared state files: `~/.macfleet/state.json` (leases + `suspended` list) and `~/.macfleet/activity.jsonl` (ring buffer, cap **200**). Atomic writes (temp + rename); corrupt/missing reads as empty.
- Agent identity (`who`): `os.environ.get("MACFLEET_AGENT", "agent")` (resolved once in the MCP; registration passes `-e MACFLEET_AGENT=<name>`). Recording is MCP-only, action-tools-only, after the op succeeds.
- Suspended state: `tart list` reports a suspended VM as `"running"`; a VM in the `suspended` set whose tart state is `"running"` is reported `"suspended"`.
- `list_vms` returns `{name, state, source, healthy, cpu, memory_mb, disk_gb}` (new resource fields from the cache; `None` when unknown).
- `set_resources`/`create` disk is grow-only: never pass `--disk-size` that would shrink.
- CORS allowlist: `http://localhost:1420`, `tauri://localhost`, `https://tauri.localhost`.
- Frontend gates (from `desktop/`): `bun run test:unit`, `bunx playwright test`, `bun run lint`, `bunx vue-tsc -b`, `bun run build`, `bun run test:unit:coverage` (100%; exclude only bootstrap files). Engine: `uv run pytest -q`, `uv run ruff check macfleet/ tests/`.
- Commit after every task (Conventional Commits).

---

## File structure

- `macfleet/activity.py` (create) — `Activity` ring-buffer store + `default_activity_path`.
- `macfleet/leases.py` (modify) — whole-doc persistence + `suspend`/`unsuspend`/`suspended`.
- `macfleet/connect.py` (modify) — Fleet: suspended wiring, res-cache in `list_vms`, `metrics`, `set_resources` grow-only, `activity_recent`.
- `macfleet/api.py` (modify) — `/agents/activity`, `/vms/{name}/metrics`, CORS.
- `macfleet/mcp.py` (modify) — activity recording + `who`.
- `desktop/src/shared/api.ts` (modify) — `agentsActivity`, `metrics`, `Vm` fields, remove `up`.
- `desktop/src/components/AgentIndicator.vue`, `AppHeader.vue` (modify) — live feed + Σ-RAM.
- `desktop/src/components/vmtabs/ResourcesTab.vue` (modify) — live metrics.
- `desktop/src/components/vmtabs/ConnectTab.vue` (modify) — Tauri clipboard.
- `desktop/src/components/vmtabs/LogsTab.vue` (modify) — drop istanbul-ignore + test.
- `desktop/src/stores/fleet.ts` (modify) — remove `up`.
- `desktop/tests/e2e/*` (modify) — mock `/agents/activity`, `/metrics`.

---

## Task 1: Activity ring-buffer store

**Files:** Create `macfleet/activity.py`; Test `tests/test_activity.py`.

**Interfaces:**
- Produces: `default_activity_path() -> str`; `Activity(path, clock=time.time, cap=200)` with `record(who, action, target)`, `recent(limit=20) -> list[dict]` (newest-first).

- [ ] **Step 1: Write the failing tests**
```python
# tests/test_activity.py
from macfleet.activity import Activity


def _act(tmp_path):
    t = {"v": 100.0}
    return Activity(str(tmp_path / "activity.jsonl"), clock=lambda: t["v"], cap=3), t


def test_record_and_recent_newest_first(tmp_path):
    a, t = _act(tmp_path)
    a.record("claude-code", "created", "web")
    t["v"] = 101.0
    a.record("agent-7", "snapshotted", "ci")
    r = a.recent(10)
    assert [e["who"] for e in r] == ["agent-7", "claude-code"]
    assert r[0] == {"who": "agent-7", "action": "snapshotted", "target": "ci", "ts": 101.0}


def test_ring_buffer_caps_entries(tmp_path):
    a, t = _act(tmp_path)  # cap=3
    for i in range(5):
        t["v"] = 100.0 + i
        a.record("a", "did", f"vm{i}")
    r = a.recent(10)
    assert len(r) == 3
    assert [e["target"] for e in r] == ["vm4", "vm3", "vm2"]  # newest 3, newest-first


def test_limit(tmp_path):
    a, t = _act(tmp_path)
    for i in range(3):
        t["v"] = 100.0 + i
        a.record("a", "did", f"vm{i}")
    assert len(a.recent(2)) == 2


def test_missing_or_corrupt_reads_empty(tmp_path):
    path = tmp_path / "activity.jsonl"
    assert Activity(str(path)).recent() == []          # missing
    path.write_text('{"who":"a"}\nnot json\n')          # one good-ish + one corrupt line
    got = Activity(str(path)).recent()
    assert len(got) == 1 and got[0]["who"] == "a"        # corrupt line skipped
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_activity.py -q` → FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement `macfleet/activity.py`**
```python
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
```

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_activity.py -q` PASS; `uv run ruff check macfleet/activity.py tests/test_activity.py` clean.

- [ ] **Step 5: Commit** — `git add macfleet/activity.py tests/test_activity.py && git commit -m "feat(engine): agent-activity ring-buffer store"`

---

## Task 2: Leases — whole-doc persistence + suspended set

**Files:** Modify `macfleet/leases.py`; Test `tests/test_leases.py` (append).

**Interfaces:**
- Produces: `Leases.suspend(name)`, `Leases.unsuspend(name)`, `Leases.suspended() -> set[str]`. Existing `record/expired/drop/rename` behavior unchanged; `rename` now also moves a suspended marker.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_leases.py`)
```python
def test_suspended_set_roundtrip(tmp_path):
    lease = Leases(str(tmp_path / "state.json"), clock=lambda: 0.0)
    lease.suspend("mf-a")
    lease.suspend("mf-a")  # idempotent
    assert lease.suspended() == {"mf-a"}
    lease.unsuspend("mf-a")
    assert lease.suspended() == set()


def test_suspended_coexists_with_leases(tmp_path):
    lease = Leases(str(tmp_path / "state.json"), clock=lambda: 1000.0)
    lease.record("mf-a", ttl=60)
    lease.suspend("mf-b")
    assert lease.expired(2000.0) == ["mf-a"]  # leases still work
    assert lease.suspended() == {"mf-b"}       # suspended preserved


def test_rename_moves_suspended_marker(tmp_path):
    lease = Leases(str(tmp_path / "state.json"), clock=lambda: 0.0)
    lease.suspend("mf-a")
    lease.rename("mf-a", "mf-b")
    assert lease.suspended() == {"mf-b"}
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_leases.py -q -k "suspended or moves_suspended"` FAIL.

- [ ] **Step 3: Implement in `macfleet/leases.py`** — replace `_load`/`_save` with whole-doc helpers and rework the methods:
```python
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
        doc = self._load_doc()
        if doc["leases"].pop(name, None) is not None:
            self._save_doc(doc)

    def rename(self, old: str, new: str) -> None:
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
        doc = self._load_doc()
        if name not in doc["suspended"]:
            doc["suspended"].append(name)
            self._save_doc(doc)

    def unsuspend(self, name: str) -> None:
        doc = self._load_doc()
        if name in doc["suspended"]:
            doc["suspended"].remove(name)
            self._save_doc(doc)

    def suspended(self) -> set[str]:
        return set(self._load_doc()["suspended"])
```
Delete the old `_load`/`_save` methods (their callers are all replaced above).

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_leases.py -q` PASS (all existing lease tests still green); ruff clean.

- [ ] **Step 5: Commit** — `git commit -am "feat(engine): leases store tracks a suspended set"`

---

## Task 3: Fleet — suspended tracking + list_vms suspended-merge

**Files:** Modify `macfleet/connect.py`; Test `tests/test_connect.py` (append).

**Interfaces:**
- Consumes: Task 2 (`Leases.suspend/unsuspend/suspended`).
- Produces: `Fleet.suspend/resume/down/nuke` maintain the suspended marker; `list_vms()` reports `state:"suspended"` for a suspended+tart-running VM.

- [ ] **Step 1: Write the failing tests** (use the existing `_fleet(tmp_path, vms=…)` helper)
```python
def test_suspend_marks_and_resume_clears(tmp_path):
    fleet, calls, spawned, lease = _fleet(tmp_path)
    fleet.suspend("web")
    assert lease.suspended() == {"mf-web"}
    fleet.resume("web")
    assert lease.suspended() == set()


def test_down_and_nuke_clear_suspended(tmp_path):
    fleet, calls, _, lease = _fleet(tmp_path)
    lease.suspend("mf-web"); fleet.down("web"); assert lease.suspended() == set()
    lease.suspend("mf-web2"); fleet.nuke("web2"); assert lease.suspended() == set()


def test_list_vms_reports_suspended(tmp_path):
    fleet, _, _, lease = _fleet(tmp_path, vms=[VmInfo("mf-web", "running", "local")])
    lease.suspend("mf-web")
    row = next(r for r in fleet.list_vms() if r["name"] == "mf-web")
    assert row["state"] == "suspended"
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_connect.py -q -k "suspend or suspended"` FAIL.

- [ ] **Step 3: Implement in `macfleet/connect.py`** — update the four lifecycle methods:
```python
    def suspend(self, name: str) -> None:
        self.tart.suspend(fullname(name))
        self._leases.suspend(fullname(name))

    def resume(self, name: str) -> None:
        self._spawn(["tart", "run", fullname(name), "--no-graphics"])
        self._leases.unsuspend(fullname(name))

    def down(self, name: str) -> None:
        self.tart.stop(fullname(name))
        self._leases.unsuspend(fullname(name))

    def nuke(self, name: str) -> None:
        try:
            self.tart.stop(fullname(name))
        except RuntimeError:
            pass
        self.tart.delete(fullname(name))
        self._leases.unsuspend(fullname(name))
```
And merge suspended into `list_vms()` — change the return to compute `state`:
```python
        suspended = self._leases.suspended()
        return [{"name": v.name,
                 "state": "suspended" if (v.name in suspended and v.state == "running") else v.state,
                 "source": v.source,
                 "healthy": health.get(v.name, False)} for v in vms]
```
(Insert `suspended = self._leases.suspended()` before the return; leave the health block as-is. The resource fields come in Task 4.)

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_connect.py -q` PASS; ruff clean.

- [ ] **Step 5: Commit** — `git commit -am "feat(engine): track suspended VMs and surface in list_vms"`

---

## Task 4: Fleet — configured-resources cache + list_vms fields + grow-only set_resources

**Files:** Modify `macfleet/connect.py`; Test `tests/test_connect.py` (append).

**Interfaces:**
- Produces: `Fleet._res_cache` (dict); `list_vms()` rows gain `cpu/memory_mb/disk_gb`; cache invalidated on `set_resources`/`create`/`rename`/`nuke`; `set_resources` guards disk grow-only.

- [ ] **Step 1: Write the failing tests**
```python
def test_list_vms_includes_cached_resources_and_fetches_once(tmp_path):
    fleet, calls, _, _ = _fleet(tmp_path, vms=[VmInfo("mf-web", "running", "local")])
    # the shared _fleet fake returns {"State":"running"} for `tart get`; extend it below in Step 3 note.
    rows = fleet.list_vms()
    row = next(r for r in rows if r["name"] == "mf-web")
    assert "memory_mb" in row and "cpu" in row and "disk_gb" in row
    gets = [c for c in calls if c[:2] == ["tart", "get"]]
    fleet.list_vms()  # second call: cache hit
    gets2 = [c for c in calls if c[:2] == ["tart", "get"]]
    assert len(gets2) == len(gets)  # no additional tart get on cache hit


def test_set_resources_invalidates_cache(tmp_path):
    fleet, calls, _, _ = _fleet(tmp_path, vms=[VmInfo("mf-web", "stopped", "local")])
    fleet.list_vms()
    fleet._res_cache["mf-web"] = {"cpu": 4, "memory_mb": 8192, "disk_gb": 50}
    fleet.set_resources("web", cpu=8)
    assert "mf-web" not in fleet._res_cache


def test_set_resources_never_shrinks_disk(tmp_path):
    # fake get_config: stopped VM with 50GB disk; a shrink to 40 must be dropped
    def run(argv):
        if argv[:2] == ["tart", "get"]:
            return subprocess.CompletedProcess(argv, 0, '{"State":"stopped","CPU":4,"Memory":8192,"Disk":50,"Display":"x"}', "")
        if argv[:2] == ["tart", "set"]:
            assert "--disk-size" not in argv  # shrink dropped
        return subprocess.CompletedProcess(argv, 0, "", "")
    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    fleet.set_resources("web", disk_size=40)  # would shrink -> must be dropped, no error
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_connect.py -q -k "cached_resources or invalidates_cache or never_shrinks"` FAIL.

- [ ] **Step 3: Implement in `macfleet/connect.py`**

Add cache init in `__init__` (after `self._clock = clock`): `self._res_cache: dict[str, dict] = {}`.

Add a config-fetch helper:
```python
    def _fetch_config(self, full: str) -> dict:
        c = self.tart.get_config(full)
        return {"cpu": c.get("CPU"), "memory_mb": c.get("Memory"), "disk_gb": c.get("Disk")}
```
Rewrite the resource part of `list_vms()` (inside/after the ThreadPoolExecutor block, before the return):
```python
        uncached = [v for v in vms if v.name not in self._res_cache]
        if running or uncached:
            with ThreadPoolExecutor(max_workers=min(8, len(vms))) as pool:
                if running:
                    health = dict(pool.map(lambda v: (v.name, self.status(shortname(v.name))), running))
                for name, res in pool.map(lambda v: (v.name, self._fetch_config(v.name)), uncached):
                    self._res_cache[name] = res
        suspended = self._leases.suspended()
        return [{"name": v.name,
                 "state": "suspended" if (v.name in suspended and v.state == "running") else v.state,
                 "source": v.source, "healthy": health.get(v.name, False),
                 **self._res_cache.get(v.name, {"cpu": None, "memory_mb": None, "disk_gb": None})}
                for v in vms]
```
(Replace the existing `if running:` health block + return with the above; keep `health: dict[str, bool] = {}` initialized before it.)

Invalidate the cache — add `self._res_cache.pop(fullname(name), None)` to `nuke` (after delete), `set_resources` (after set), and `rename` (pop old); in `create`, after cloning, `self._res_cache.pop(target, None)`.

Add the grow-only guard + invalidation to `set_resources`:
```python
    def set_resources(self, name: str, cpu: int | None = None, memory: int | None = None,
                      disk_size: int | None = None, display: str | None = None) -> None:
        current = self.resources(name)
        if current["state"] == "running":
            raise RuntimeError("stop the VM before changing resources")
        if disk_size is not None and disk_size <= current["disk_gb"]:
            disk_size = None  # tart set --disk-size is grow-only
        self.tart.set_config(fullname(name), cpu=cpu, memory=memory,
                             disk_size=disk_size, display=display)
        self._res_cache.pop(fullname(name), None)
```

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_connect.py -q` PASS (the shared `_fleet` fake already returns `{"State":"running"}` for `tart get`; `_fetch_config` uses `.get`, so missing CPU/Memory/Disk become `None` — the `test_list_vms_includes_cached_resources` test only asserts the keys exist). ruff clean.

- [ ] **Step 5: Commit** — `git commit -am "feat(engine): configured-resources cache in list_vms + grow-only set_resources"`

---

## Task 5: Fleet — live metrics

**Files:** Modify `macfleet/connect.py`; Test `tests/test_connect.py` (append).

**Interfaces:**
- Produces: `Fleet.metrics(name) -> {cpu_pct, mem_used_mb, mem_total_mb}`.

- [ ] **Step 1: Write the failing tests**
```python
def test_metrics_parses_top(tmp_path):
    top = "CPU usage: 1.91% user, 23.56% sys, 74.52% idle\nPhysMem: 8029M used (1027M wired), 147M unused."
    def nocheck(argv):
        assert argv[:3] == ["tart", "exec", "mf-web"]
        return subprocess.CompletedProcess(argv, 0, top, "")
    def run(argv):  # for mem_total via resources()
        return subprocess.CompletedProcess(argv, 0, '{"State":"running","CPU":4,"Memory":8192,"Disk":50,"Display":"x"}', "")
    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, run_nocheck=nocheck,
                  leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    m = fleet.metrics("web")
    assert m["cpu_pct"] == 25.5           # 100 - 74.52 = 25.48 -> 25.5
    assert m["mem_used_mb"] == 8029
    assert m["mem_total_mb"] == 8192


def test_metrics_raises_when_exec_fails(tmp_path):
    def nocheck(argv):
        return subprocess.CompletedProcess(argv, 1, "", "vm not running")
    from macfleet.leases import Leases
    import pytest
    fleet = Fleet(run=lambda a: subprocess.CompletedProcess(a, 0, "", ""),
                  run_nocheck=nocheck, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    with pytest.raises(RuntimeError, match="metrics unavailable"):
        fleet.metrics("web")
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_connect.py -q -k metrics` FAIL.

- [ ] **Step 3: Implement in `macfleet/connect.py`** — add `import re` at the top, then:
```python
    def metrics(self, name: str) -> dict:
        proc = self._run_nocheck(
            ["tart", "exec", fullname(name), "/bin/sh", "-lc",
             "top -l1 -n0 | grep -E 'CPU usage|PhysMem'"])
        if proc.returncode != 0:
            raise RuntimeError(f"metrics unavailable: {proc.stderr.strip() or 'exec failed'}")
        cpu_pct = 0.0
        mem_used_mb = 0
        for line in proc.stdout.splitlines():
            if "CPU usage" in line:
                m = re.search(r"([\d.]+)%\s+idle", line)
                if m:
                    cpu_pct = round(100 - float(m.group(1)), 1)
            elif "PhysMem" in line:
                m = re.search(r"([\d.]+)([MG])\s+used", line)
                if m:
                    val = float(m.group(1))
                    mem_used_mb = int(val * 1024) if m.group(2) == "G" else int(val)
        total = self._res_cache.get(fullname(name), {}).get("memory_mb") or self.resources(name)["memory_mb"]
        return {"cpu_pct": cpu_pct, "mem_used_mb": mem_used_mb, "mem_total_mb": total}
```

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_connect.py -q -k metrics` PASS; ruff clean.

- [ ] **Step 5: Commit** — `git commit -am "feat(engine): live per-VM metrics via tart exec top"`

---

## Task 6: Fleet — activity instance + activity_recent

**Files:** Modify `macfleet/connect.py`; Test `tests/test_connect.py` (append).

**Interfaces:**
- Consumes: Task 1 (`Activity`, `default_activity_path`).
- Produces: `Fleet(__init__ … activity=None)`; `Fleet.activity` (the `Activity`); `Fleet.activity_recent(limit=20) -> list[dict]`.

- [ ] **Step 1: Write the failing test**
```python
def test_activity_recent_delegates(tmp_path):
    from macfleet.activity import Activity
    from macfleet.leases import Leases
    act = Activity(str(tmp_path / "a.jsonl"), clock=lambda: 5.0)
    act.record("claude-code", "created", "web")
    fleet = Fleet(run=lambda a: subprocess.CompletedProcess(a, 0, "", ""),
                  leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0), activity=act)
    r = fleet.activity_recent()
    assert r[0]["who"] == "claude-code" and r[0]["action"] == "created"
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_connect.py -q -k activity_recent` FAIL.

- [ ] **Step 3: Implement in `macfleet/connect.py`** — import + inject + method:
- Add to imports: `from macfleet.activity import Activity, default_activity_path`.
- Extend `__init__` signature with `activity: Activity | None = None` and set `self.activity = activity or Activity(default_activity_path())`.
```python
    def activity_recent(self, limit: int = 20) -> list[dict]:
        return self.activity.recent(limit)
```

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_connect.py -q` PASS; ruff clean.

- [ ] **Step 5: Commit** — `git commit -am "feat(engine): Fleet holds the activity log + activity_recent"`

---

## Task 7: API — activity + metrics endpoints, list_vms fields, CORS

**Files:** Modify `macfleet/api.py`; Test `tests/test_api.py`.

**Interfaces:**
- Consumes: Task 5/6 (`Fleet.metrics`, `Fleet.activity_recent`), Task 4 (list_vms fields).
- Produces: `GET /agents/activity?limit=`, `GET /vms/{name}/metrics`; CORS restricted.

- [ ] **Step 1: Extend `FakeFleet` in `tests/test_api.py`** (add methods; keep existing):
```python
    def activity_recent(self, limit=20):
        return [{"who": "claude-code", "action": "created", "target": "web", "ts": 5.0}][:limit]

    def metrics(self, name):
        return {"cpu_pct": 25.5, "mem_used_mb": 8029, "mem_total_mb": 8192}
```

- [ ] **Step 2: Write the failing tests** (append to `tests/test_api.py`)
```python
def test_agents_activity_endpoint():
    r = TestClient(build_app(FakeFleet())).get("/agents/activity?limit=5")
    assert r.status_code == 200
    assert r.json()[0]["who"] == "claude-code"


def test_metrics_endpoint():
    r = TestClient(build_app(FakeFleet())).get("/vms/web/metrics")
    assert r.json() == {"cpu_pct": 25.5, "mem_used_mb": 8029, "mem_total_mb": 8192}


def test_cors_allows_tauri_origin_and_denies_others():
    client = TestClient(build_app(FakeFleet()))
    ok = client.get("/vms", headers={"Origin": "http://localhost:1420"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:1420"
    bad = client.get("/vms", headers={"Origin": "https://evil.example"})
    assert bad.headers.get("access-control-allow-origin") is None
```

- [ ] **Step 3: Run to verify failure** — `uv run pytest tests/test_api.py -q -k "agents_activity or metrics_endpoint or cors_allows"` FAIL.

- [ ] **Step 4: Implement in `macfleet/api.py`**
- Change the CORS middleware:
```python
    api.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:1420", "tauri://localhost", "https://tauri.localhost"],
        allow_methods=["*"], allow_headers=["*"],
    )
```
- Add routes (inside `build_app`, near the other GETs):
```python
    @api.get("/agents/activity")
    def agents_activity(limit: int = 20) -> list[dict]:
        return fleet.activity_recent(limit)

    @api.get("/vms/{name}/metrics")
    def metrics(name: str) -> dict:
        return fleet.metrics(name)
```

- [ ] **Step 5: Run + commit** — `uv run pytest tests/test_api.py -q` PASS; ruff clean.
`git commit -am "feat(api): /agents/activity + /vms/{name}/metrics; restrict CORS to Tauri origins"`

---

## Task 8: MCP — record agent activity on action tools

**Files:** Modify `macfleet/mcp.py`; Test `tests/test_mcp.py`.

**Interfaces:**
- Consumes: `Fleet.activity` (Task 6).
- Produces: each MCP action tool records `{who, action, target}` after the Fleet op; read tools do not; `who = os.environ.get("MACFLEET_AGENT", "agent")`.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_mcp.py`; the file's `FakeFleet` needs an `activity` with a `record` spy)
```python
def test_create_vm_records_activity(monkeypatch):
    monkeypatch.setenv("MACFLEET_AGENT", "claude-code")
    fake = FakeFleet()
    recorded = []
    fake.activity = type("A", (), {"record": lambda self, who, action, target: recorded.append((who, action, target))})()
    M.mcp_create_vm(fake, name="web")
    assert recorded == [("claude-code", "created", "web")]


def test_list_vms_does_not_record(monkeypatch):
    fake = FakeFleet()
    recorded = []
    fake.activity = type("A", (), {"record": lambda self, w, a, t: recorded.append((w, a, t))})()
    M.mcp_list_vms(fake)
    assert recorded == []


def test_who_defaults_to_agent(monkeypatch):
    monkeypatch.delenv("MACFLEET_AGENT", raising=False)
    assert M._who() == "agent"
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/test_mcp.py -q -k "records_activity or does_not_record or who_defaults"` FAIL.

- [ ] **Step 3: Implement in `macfleet/mcp.py`**
- Add `import os` (if absent) and a helper:
```python
def _who() -> str:
    return os.environ.get("MACFLEET_AGENT", "agent")
```
- In the tool-logic functions that mutate/act, record after the op. For the extracted `mcp_*` functions (e.g. `mcp_create_vm`), add the record call; for tools defined only inline in `build_server`, add `fleet.activity.record(_who(), "<phrase>", <target>)` after the fleet call. Action→phrase map (use these exact phrases): create_vm→"created", up→"started", down→"stopped", suspend→"suspended", resume→"resumed", delete_vm→"deleted", rename_vm→"renamed", duplicate_vm→"duplicated", snapshot→"snapshotted", create_from_snapshot→"created from snapshot", delete_snapshot→"deleted snapshot", set_resources→"resized", exec→"ran a command on", screenshot→"took a screenshot of", click→"clicked in", type_text→"typed into", key→"pressed a key in". Target = the VM short name (or snapshot id for delete_snapshot). Example for `mcp_create_vm`:
```python
def mcp_create_vm(fleet, name: str, from_snapshot: str | None = None,
                  ttl_seconds: int | None = None) -> dict:
    fleet.create(name, from_snapshot=from_snapshot, ttl=ttl_seconds)
    fleet.activity.record(_who(), "created", name)
    return {"ok": True, "name": name}
```
Do NOT record in `mcp_list_vms`, `list_snapshots`, `get_resources`, `get_connection`, or a metrics read tool.

- [ ] **Step 4: Run to verify pass** — `uv run pytest tests/test_mcp.py -q` PASS; ruff clean.

- [ ] **Step 5: Commit** — `git commit -am "feat(mcp): record agent activity on action tools"`

Also update the README MCP-registration line to pass the agent name:
`claude mcp add macfleet -e MACFLEET_AGENT=claude-code -- uv run --extra mcp macfleet-mcp`.

---

## Task 9: Frontend API client — activity, metrics, Vm fields, remove up

**Files:** Modify `desktop/src/shared/api.ts`; Test `desktop/tests/unit/api.test.ts`.

**Interfaces:**
- Produces: `api.agentsActivity(limit?)`, `api.metrics(name)`, types `AgentActivity {who,action,target,ts}`, `Metrics {cpu_pct,mem_used_mb,mem_total_mb}`; `Vm` gains `cpu?/memory_mb?/disk_gb?: number|null`; `api.up` removed.

- [ ] **Step 1: Add failing tests** (append to `desktop/tests/unit/api.test.ts`): assert `agentsActivity(5)` → `GET /agents/activity?limit=5`; `metrics('web')` → `GET /vms/web/metrics`. Remove any `api.up` test.
- [ ] **Step 2: Run → FAIL.** `bun run test:unit -- api`
- [ ] **Step 3: Implement**: add the two client fns (reuse `j`), the two types, extend `Vm` with `cpu?/memory_mb?/disk_gb?: number | null`, and delete `up: (n) => …` from the `api` object.
- [ ] **Step 4: Run → PASS**; `bunx vue-tsc -b` + `bun run lint` clean. (Note: `store.up` still references `api.up` until Task 13 — if tsc breaks, do Task 13's `store.up` removal together with this task's `api.up` removal. Prefer: remove `api.up` here AND `store.up` here to keep the tree compiling, folding Task 13's store part in. Adjust Task 13 accordingly.)
- [ ] **Step 5: Commit** — `feat(desktop): api client for agents-activity + metrics; Vm resource fields; drop up`

---

## Task 10: AgentIndicator live feed + AppHeader Σ-RAM

**Files:** Modify `desktop/src/components/AgentIndicator.vue`, `AppHeader.vue`; Tests.

**Interfaces:**
- Consumes: `api.agentsActivity`, `Vm.memory_mb`.

- [ ] **Step 1: Failing tests**: AgentIndicator polls `api.agentsActivity` and renders entries + a distinct-agent count badge; empty feed shows the honest empty state (no fabricated data). AppHeader capacity shows `Σ(running memory_mb)/1024 rounded` GB used + host total (e.g. "12 / 48 GB") when memory_mb present, falling back to running-count + host total when absent.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**: AgentIndicator — on mount, poll `api.agentsActivity(20)` every 5s (clear on unmount); the chip badge = count of distinct `who` in the feed; the popover lists `who · action · target · <relative ts>` (mirror comp lines 90-99). Keep the empty state when the feed is empty. AppHeader — compute `usedGb = round(Σ running memory_mb / 1024)`; show `"{usedGb} / {host.total_mem_gb} GB"` when any running VM has `memory_mb`, else the current running-count form.
- [ ] **Step 4: Run → PASS**; lint + tsc clean.
- [ ] **Step 5: Commit** — `feat(desktop): live agent-activity indicator + real Σ-RAM capacity`

---

## Task 11: ResourcesTab live metrics

**Files:** Modify `desktop/src/components/vmtabs/ResourcesTab.vue`; Test.

**Interfaces:**
- Consumes: `api.metrics(name)`.

- [ ] **Step 1: Failing tests**: when the selected VM is `running`, ResourcesTab polls `api.metrics(name)` (~3s) and the CPU bar width + caption reflect `cpu_pct` ("X% load"), the Memory bar + caption reflect `mem_used_mb/mem_total_mb` ("Y / Z GB used"); when not running (stopped/suspended/booting) OR a metrics fetch fails, it falls back to the configured bars/caption (no live numbers, no fabrication); the poll clears on unmount and on VM change.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**: add a `metrics` ref + a poll gated on `state === 'running'` (mirror ScreenTab's gate + cleanup); drive the CPU/Memory card bars from `metrics` when present, else configured; disk stays configured. On fetch error, keep configured (clear `metrics`). Captions per comp lines 361/367.
- [ ] **Step 4: Run → PASS**; lint + tsc clean.
- [ ] **Step 5: Commit** — `feat(desktop): resources tab live CPU/memory metrics`

---

## Task 12: ConnectTab Tauri clipboard

**Files:** Modify `desktop/src/components/vmtabs/ConnectTab.vue`; Test.

- [ ] **Step 1: Failing test**: copy uses the Tauri clipboard plugin when available and falls back to `navigator.clipboard` otherwise; success-only confirmation preserved. Test both branches: with a stubbed Tauri `writeText` (spy) and without (navigator path).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**: a small `copyText(s)` that tries `@tauri-apps/plugin-clipboard-manager`'s `writeText` when `window.__TAURI_INTERNALS__`/`window.__TAURI__` is present (dynamic `import()` guarded in try/catch), else `navigator.clipboard.writeText`; keep the `.catch`/success-only "✓ Copied". Ensure the plugin is permitted in `desktop/src-tauri/capabilities/*.json` (add `clipboard-manager:allow-write-text` if missing).
- [ ] **Step 4: Run → PASS**; lint + tsc + `bun run build` clean.
- [ ] **Step 5: Commit** — `fix(desktop): connect-tab copy via Tauri clipboard with browser fallback`

---

## Task 13: LogsTab test + e2e mocks + coverage

**Files:** Modify `desktop/src/components/vmtabs/LogsTab.vue` (+ test), `desktop/tests/e2e/*`.

- [ ] **Step 1: LogsTab** — replace the `/* istanbul ignore */` on `scrollToBottom`'s post-unmount `if (el)` guard with a real test: mount, trigger the `flush:'post'` watcher (append a log), `wrapper.unmount()` before flush, assert no throw and the guard is exercised. Remove the ignore.
- [ ] **Step 2: e2e** — add route mocks for `**/agents/activity` (→ a small list) and `**/vms/*/metrics` (→ `{cpu_pct,mem_used_mb,mem_total_mb}`) to the shared e2e API mock so the header indicator + Resources tab don't hit a dead route; extend one journey to open Resources and assert a live "% load" caption.
- [ ] **Step 3: Run all gates** — `bun run test:unit`, `bunx playwright test`, `bun run lint`, `bunx vue-tsc -b`, `bun run build`, `bun run test:unit:coverage` (100%; add tests rather than ignores for any new branch). Engine: `uv run pytest -q`, `uv run ruff check`.
- [ ] **Step 4: Commit** — `test(desktop): logs-tab unmount test + e2e mocks for activity/metrics`

---

## Final verification (after all tasks)

- [ ] All gates green (engine pytest/ruff; desktop unit/e2e/lint/tsc/build/coverage).
- [ ] **L1 (real hardware — controller):** `claude mcp add macfleet -e MACFLEET_AGENT=claude-code …`, drive a create/snapshot/exec via the MCP → they appear in the header feed with the agent name; open a running VM's Resources tab → live CPU/mem bars; suspend a VM → shows **Suspended** (violet) → resume → running; capacity chip shows real Σ used/total; copy in the packaged app; the desktop still reaches the API under the tightened CORS. Validate the `top -l1` parse and the packaged Tauri origin (open items in the spec).
- [ ] Merge branch `phase2-and-followups` to `main`.

## Self-review notes (addressed)

- **Spec coverage:** agent feed (T1 store, T6 Fleet, T7 API, T8 MCP, T10 UI); suspended (T2 store, T3 Fleet, list_vms merge, UI already styles it); host Σ-RAM (T4 cache + list_vms fields, T10 header); live metrics (T5 Fleet, T7 API, T11 UI); follow-ups — set_resources grow-only (T4), CORS (T7), clipboard (T12), remove up (T9), LogsTab test (T13). All covered.
- **Identity deviation (documented):** `who` resolves from `MACFLEET_AGENT` env (default "agent"), not the MCP `clientInfo` handshake — chosen for robustness against SDK-version fragility (the Phase-1 FastMCP-introspection lesson); registration passes the name. Same user-visible outcome (named agents in the feed).
- **Naming consistency:** `list_vms` fields `cpu/memory_mb/disk_gb`; `metrics` keys `cpu_pct/mem_used_mb/mem_total_mb`; `Activity.record(who, action, target)`; `Leases.suspend/unsuspend/suspended` — used identically across engine, API, MCP, and frontend.
