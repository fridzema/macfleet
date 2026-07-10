# Shared folders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount host directories into guest VMs, read-only by default, applied on the VM's next start.

**Architecture:** A new `Shares` store (`~/.macfleet/shares.json`, mirroring `leases.py`) holds per-VM folder shares. A single `Fleet._run_argv(full)` builds the `tart run` command with `--dir=` flags, and every boot site routes through it. New `GET`/`PUT /vms/{name}/shares` and `POST /vms/{name}/restart` endpoints, plus a `Folders` tab in the desktop VM detail with the Tauri folder picker.

**Tech Stack:** Python 3.12 (uv, pytest, FastAPI, Typer), Vue 3 + Pinia + TypeScript (bun, vitest), tart CLI (`--dir=<tag>:<path>[:ro]`).

This is **Plan 3 of 3** for `docs/superpowers/specs/2026-07-09-fleet-ux-snapshots-and-shared-folders-design.md`. Plans 1 (snapshots) and 2 (context menu + multi-select) are merged.

## Global Constraints

- Engine tests: `uv run pytest`; lint `make lint-engine`. Desktop: `bun run test:unit`, `bun run lint`, `bunx vue-tsc -b` from `desktop/`.
- **Verify test/typecheck output directly — do not trust a piped exit code** (a `... | grep` reports grep's status, not the tool's).
- `from __future__ import annotations`, type hints. Strict TS. Conventional commits, no `Co-authored-by`.
- Shares are keyed by **full** VM name (`mf-<x>`). A share is `{tag, host_path, read_only}`.
- tart flag: `--dir=<tag>:<host_path>` plus `:ro` when read-only. On macOS guests the share appears at `/Volumes/My Shared Files/<tag>`.
- Read-only is the default; read-write is an explicit opt-in.
- The 7 boot sites in `connect.py` (`grep -n 'tart", "run"' macfleet/connect.py`) all become `self._spawn(self._run_argv(<full>))`.

---

### Task 1: `Shares` persistence store

**Files:**
- Create: `macfleet/shares.py`
- Test: `tests/test_shares.py`

**Interfaces:**
- Produces: `default_shares_path() -> str`; `Shares(path)` with `get(name) -> list[dict]`, `set(name, shares: list[dict])` (empty list drops the key), `drop(name)`, `rename(old, new)`. Missing/corrupt file reads empty; atomic writes.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_shares.py
from macfleet.shares import Shares


def test_set_get_roundtrip(tmp_path):
    s = Shares(str(tmp_path / "shares.json"))
    s.set("mf-web", [{"tag": "src", "host_path": "/x", "read_only": True}])
    assert s.get("mf-web") == [{"tag": "src", "host_path": "/x", "read_only": True}]


def test_unknown_reads_empty(tmp_path):
    assert Shares(str(tmp_path / "s.json")).get("mf-nope") == []


def test_set_empty_drops_key(tmp_path):
    s = Shares(str(tmp_path / "s.json"))
    s.set("mf-web", [{"tag": "a", "host_path": "/x", "read_only": False}])
    s.set("mf-web", [])
    assert s.get("mf-web") == []


def test_rename_moves(tmp_path):
    s = Shares(str(tmp_path / "s.json"))
    s.set("mf-web", [{"tag": "a", "host_path": "/x", "read_only": True}])
    s.rename("mf-web", "mf-prod")
    assert s.get("mf-prod")[0]["tag"] == "a"
    assert s.get("mf-web") == []


def test_corrupt_file_reads_empty(tmp_path):
    p = tmp_path / "s.json"
    p.write_text("not json")
    assert Shares(str(p)).get("mf-web") == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/test_shares.py -v`
Expected: FAIL (module missing).

- [ ] **Step 3: Create the store**

```python
# macfleet/shares.py
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `uv run pytest tests/test_shares.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add macfleet/shares.py tests/test_shares.py
git commit -m "feat(engine): Shares store for per-VM folder shares"
```

---

### Task 2: Wire shares into Fleet + `_run_argv`

**Files:**
- Modify: `macfleet/connect.py`
- Test: `tests/test_connect.py`

**Interfaces:**
- Consumes: `Shares` (Task 1).
- Produces: `Fleet(..., shares: Shares | None = None)`; `Fleet._run_argv(full) -> list[str]`; `Fleet.get_shares(name) -> list[dict]`; `Fleet.set_shares(name, shares)` (validates tag format + uniqueness + that the host path is an existing directory, expands `~`, defaults `read_only` True). `rename`/`nuke` propagate to shares. Every boot site uses `_run_argv`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_connect.py  (add near the other Fleet tests; imports Shares + Leases already available)
from macfleet.shares import Shares


def _fleet_with_shares(tmp_path, shares):
    calls = []
    spawned = []

    def run(argv):
        calls.append(argv)
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, "[]", "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    fleet = Fleet(tart=Tart(run=run), run=run, spawn=spawned.append,
                  leases=Leases(str(tmp_path / "l.json"), clock=lambda: 0.0),
                  shares=shares, clock=lambda: 0.0)
    return fleet, calls, spawned


def test_run_argv_appends_dir_flags(tmp_path):
    shares = Shares(str(tmp_path / "s.json"))
    shares.set("mf-web", [
        {"tag": "src", "host_path": "/h/src", "read_only": True},
        {"tag": "out", "host_path": "/h/out", "read_only": False},
    ])
    fleet, _, _ = _fleet_with_shares(tmp_path, shares)
    assert fleet._run_argv("mf-web") == [
        "tart", "run", "mf-web", "--no-graphics",
        "--dir=src:/h/src:ro", "--dir=out:/h/out",
    ]


def test_run_argv_base_when_no_shares(tmp_path):
    fleet, _, _ = _fleet_with_shares(tmp_path, Shares(str(tmp_path / "s.json")))
    assert fleet._run_argv("mf-web") == ["tart", "run", "mf-web", "--no-graphics"]


def test_create_boots_with_share_flags(tmp_path):
    shares = Shares(str(tmp_path / "s.json"))
    shares.set("mf-web", [{"tag": "src", "host_path": "/h", "read_only": True}])
    fleet, _, spawned = _fleet_with_shares(tmp_path, shares)
    fleet.create("web")
    assert ["tart", "run", "mf-web", "--no-graphics", "--dir=src:/h:ro"] in spawned


def test_set_shares_validates_and_normalizes(tmp_path):
    d = tmp_path / "share"
    d.mkdir()
    fleet, _, _ = _fleet_with_shares(tmp_path, Shares(str(tmp_path / "s.json")))
    fleet.set_shares("web", [{"tag": "src", "host_path": str(d)}])
    got = fleet.get_shares("web")
    assert got == [{"tag": "src", "host_path": str(d), "read_only": True}]
    with pytest.raises(RuntimeError, match="not found"):
        fleet.set_shares("web", [{"tag": "x", "host_path": str(tmp_path / "missing")}])
    with pytest.raises(RuntimeError, match="invalid share tag"):
        fleet.set_shares("web", [{"tag": "bad/tag", "host_path": str(d)}])
    with pytest.raises(RuntimeError, match="duplicate share tag"):
        fleet.set_shares("web", [{"tag": "src", "host_path": str(d)},
                                 {"tag": "src", "host_path": str(d)}])


def test_set_shares_rejects_golden(tmp_path):
    fleet, _, _ = _fleet_with_shares(tmp_path, Shares(str(tmp_path / "s.json")))
    with pytest.raises(RuntimeError, match="protected template"):
        fleet.set_shares("golden", [])


def test_rename_and_nuke_propagate_to_shares(tmp_path):
    shares = Shares(str(tmp_path / "s.json"))
    shares.set("mf-web", [{"tag": "src", "host_path": "/h", "read_only": True}])
    fleet, _, _ = _fleet_with_shares(tmp_path, shares)
    fleet.rename("web", "prod")
    assert shares.get("mf-prod") and shares.get("mf-web") == []
    fleet.nuke("prod")
    assert shares.get("mf-prod") == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/test_connect.py -k "shares or run_argv" -v`
Expected: FAIL (`shares=` kwarg / `_run_argv` / `set_shares` missing).

- [ ] **Step 3: Wire shares into `Fleet.__init__`**

In `macfleet/connect.py`, add the import (beside the `leases` import):

```python
from macfleet.shares import Shares, default_shares_path
```

Add a `shares` param + field to `__init__` (the signature currently ends with `activity: Activity | None = None`):

```python
                 shares: Shares | None = None) -> None:
```

and in the body (next to `self._leases = ...`):

```python
        self._shares = shares or Shares(default_shares_path())
```

- [ ] **Step 4: Add `_run_argv`, `get_shares`, `set_shares`**

Add these methods (near `ip`/`resources`). `re` and `os` are already imported in this module:

```python
    def _run_argv(self, full: str) -> list[str]:
        argv = ["tart", "run", full, "--no-graphics"]
        for s in self._shares.get(full):
            flag = f"--dir={s['tag']}:{s['host_path']}"
            if s.get("read_only"):
                flag += ":ro"
            argv.append(flag)
        return argv

    def get_shares(self, name: str) -> list[dict]:
        return self._shares.get(fullname(name))

    def set_shares(self, name: str, shares: list[dict]) -> None:
        ensure_mutable(name)
        tag_re = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
        seen: set[str] = set()
        normalized: list[dict] = []
        for s in shares:
            tag = str(s.get("tag", ""))
            host_path = os.path.expanduser(str(s.get("host_path", "")))
            if not tag_re.fullmatch(tag):
                raise RuntimeError(f"invalid share tag {tag!r}: use letters, digits, '.', '_', '-'")
            if tag in seen:
                raise RuntimeError(f"duplicate share tag {tag!r}")
            seen.add(tag)
            if not os.path.isdir(host_path):
                raise RuntimeError(f"shared folder not found: {host_path}")
            normalized.append({"tag": tag, "host_path": host_path,
                               "read_only": bool(s.get("read_only", True))})
        self._shares.set(fullname(name), normalized)
```

- [ ] **Step 5: Route every boot site through `_run_argv`**

Replace each of the 7 `self._spawn(["tart", "run", <X>, "--no-graphics"])` occurrences with `self._spawn(self._run_argv(<X>))`. The `<X>` values are: `fullname(name)` (resume), `target` (create), `GOLDEN` (warm_golden), `src` (snapshot resume), `src` and `fullname(new)` (duplicate), `target` (restore). Find them with `grep -n 'tart", "run"' macfleet/connect.py`.

- [ ] **Step 6: Propagate shares on rename + nuke**

In `rename`, after `self._leases.rename(...)`:

```python
        self._shares.rename(fullname(old), fullname(new))
```

In `nuke`, after `self._leases.unsuspend(fullname(name))`:

```python
        self._shares.drop(fullname(name))
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `uv run pytest tests/test_connect.py -v`
Expected: PASS (new tests + all existing — the existing boot-site tests still assert `["tart", "run", <name>, "--no-graphics"]` and those VMs have no shares, so `_run_argv` returns exactly that).

- [ ] **Step 8: Commit**

```bash
git add macfleet/connect.py tests/test_connect.py
git commit -m "feat(engine): route VM boots through _run_argv with folder shares"
```

---

### Task 3: `restart` + shares/restart endpoints + CLI

**Files:**
- Modify: `macfleet/connect.py`, `macfleet/api.py`, `macfleet/cli.py`
- Test: `tests/test_connect.py`, `tests/test_api.py`, `tests/test_cli.py`

**Interfaces:**
- Produces: `Fleet.restart(name)` (stop, then boot with current shares); `GET /vms/{name}/shares` → `{shares: [...]}`; `PUT /vms/{name}/shares` (body `{shares: [...]}`); `POST /vms/{name}/restart`; CLI `macfleet restart <name>`.

- [ ] **Step 1: Write the failing engine test**

```python
# tests/test_connect.py
def test_restart_stops_then_boots_with_shares(tmp_path):
    shares = Shares(str(tmp_path / "s.json"))
    shares.set("mf-web", [{"tag": "src", "host_path": "/h", "read_only": True}])
    fleet, calls, spawned = _fleet_with_shares(tmp_path, shares)
    fleet.restart("web")
    assert ["tart", "stop", "mf-web"] in calls
    assert ["tart", "run", "mf-web", "--no-graphics", "--dir=src:/h:ro"] in spawned
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_connect.py::test_restart_stops_then_boots_with_shares -v`
Expected: FAIL (`restart` missing).

- [ ] **Step 3: Implement `Fleet.restart`**

Add to `macfleet/connect.py` (near `down`):

```python
    def restart(self, name: str) -> None:
        """Stop mf-<name> and boot it again — the way to apply a shared-folder change to a
        running VM (shares only take effect on `tart run`)."""
        ensure_mutable(name)
        full = fullname(name)
        try:
            self.tart.stop(full)
        except RuntimeError:
            pass
        self._forget_ip(full)
        self._leases.unsuspend(full)
        self._spawn(self._run_argv(full))
```

- [ ] **Step 4: Write the failing API tests**

Add these methods to the `FakeFleet` in `tests/test_api.py` (next to `restore`):

```python
    def get_shares(self, name):
        return [{"tag": "src", "host_path": "/h", "read_only": True}]

    def set_shares(self, name, shares):
        self.calls.append(("set_shares", name, shares))

    def restart(self, name):
        self.calls.append(("restart", name))
```

Add tests:

```python
def test_get_shares_endpoint():
    client = TestClient(build_app(FakeFleet()))
    assert client.get("/vms/web/shares").json()["shares"][0]["tag"] == "src"


def test_put_shares_endpoint():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    body = {"shares": [{"tag": "src", "host_path": "/h", "read_only": True}]}
    assert client.put("/vms/web/shares", json=body).status_code == 200
    assert ("set_shares", "web",
            [{"tag": "src", "host_path": "/h", "read_only": True}]) in fake.calls


def test_restart_endpoint():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    assert client.post("/vms/web/restart").status_code == 200
    assert ("restart", "web") in fake.calls
```

- [ ] **Step 5: Run to verify they fail**

Run: `uv run pytest tests/test_api.py -k "shares or restart" -v`
Expected: FAIL (routes 404).

- [ ] **Step 6: Add the endpoints**

In `macfleet/api.py`, add models near the others:

```python
class Share(BaseModel):
    tag: str
    host_path: str
    read_only: bool = True


class SharesRequest(BaseModel):
    shares: list[Share]
```

Add routes (near `resources`):

```python
    @api.get("/vms/{name}/shares")
    def get_shares(name: str) -> dict:
        return {"shares": fleet.get_shares(name)}

    @api.put("/vms/{name}/shares")
    def put_shares(name: str, body: SharesRequest) -> dict:
        fleet.set_shares(name, [s.model_dump() for s in body.shares])
        return {"ok": True}

    @api.post("/vms/{name}/restart")
    def restart(name: str) -> dict:
        fleet.restart(name)
        return {"ok": True}
```

- [ ] **Step 7: Add the CLI command + test**

`tests/test_cli.py`:

```python
def test_restart_command(monkeypatch):
    calls = {}

    class FakeFleet:
        def restart(self, name):
            calls["restart"] = name

    monkeypatch.setattr(cli, "_fleet", lambda: FakeFleet())
    result = runner.invoke(cli.app, ["restart", "web"])
    assert result.exit_code == 0
    assert calls["restart"] == "web"
```

`macfleet/cli.py` (near `restore`):

```python
@app.command()
def restart(name: str) -> None:
    """Stop mf-<name> and boot it again with its current shared folders."""
    _fleet().restart(name)
    typer.echo(f"restarted: mf-{name}")
```

- [ ] **Step 8: Run engine tests + lint**

Run: `uv run pytest -q` then `make lint-engine`
Expected: PASS (all), lint clean.

- [ ] **Step 9: Commit**

```bash
git add macfleet/connect.py macfleet/api.py macfleet/cli.py tests/test_connect.py tests/test_api.py tests/test_cli.py
git commit -m "feat(engine): restart + shares endpoints and CLI"
```

---

### Task 4: Desktop api client + store

**Files:**
- Modify: `desktop/src/shared/api.ts`, `desktop/src/stores/fleet.ts`
- Test: `desktop/tests/unit/fleet.test.ts`

**Interfaces:**
- Produces: `Share` interface `{tag, host_path, read_only}`; `api.getShares(n)`, `api.setShares(n, shares)`, `api.restart(n)`; `Tab` gains `'folders'`; `store.shares: Record<string, Share[]>`, `store.fetchShares(name)`, `store.setShares(name, list)`, `store.restart(name)`.

- [ ] **Step 1: Add the api client bindings**

In `desktop/src/shared/api.ts`, add the interface (near `Resources`):

```ts
export interface Share {
  tag: string
  host_path: string
  read_only: boolean
}
```

Add to the `api` object (near `resources`):

```ts
  getShares: (n: string) => j<{ shares: Share[] }>(`/vms/${enc(n)}/shares`),
  setShares: (n: string, shares: Share[]) => putJson(`/vms/${enc(n)}/shares`, { shares }),
  restartVm: (n: string) => j(`/vms/${enc(n)}/restart`, { method: 'POST' }),
```

- [ ] **Step 2: Write the failing store tests**

```ts
// desktop/tests/unit/fleet.test.ts  (inside the lifecycle-mutations describe)
  it('fetchShares populates the shares cache', async () => {
    vi.spyOn(api, 'getShares').mockResolvedValue({
      shares: [{ tag: 'src', host_path: '/h', read_only: true }],
    })
    const s = useFleet()
    await s.fetchShares('web')
    expect(s.shares.web).toEqual([{ tag: 'src', host_path: '/h', read_only: true }])
  })

  it('setShares calls api.setShares, refetches, and toasts', async () => {
    const set = vi.spyOn(api, 'setShares').mockResolvedValue({})
    vi.spyOn(api, 'getShares').mockResolvedValue({ shares: [] })
    const s = useFleet()
    await s.setShares('web', [{ tag: 'src', host_path: '/h', read_only: true }])
    expect(set).toHaveBeenCalledWith('web', [{ tag: 'src', host_path: '/h', read_only: true }])
    expect(useToasts().toasts.value.some((t) => t.msg.includes('Shared folders saved'))).toBe(true)
  })

  it('restart calls api.restartVm then refreshes', async () => {
    const restart = vi.spyOn(api, 'restartVm').mockResolvedValue({})
    const s = useFleet()
    await s.restart('web')
    expect(restart).toHaveBeenCalledWith('web')
    expect(s.error).toBeNull()
  })
```

- [ ] **Step 3: Run to verify they fail**

Run (from `desktop/`): `bun run test:unit fleet`
Expected: FAIL (`fetchShares`/`setShares`/`restart` undefined).

- [ ] **Step 4: Implement in the store**

In `desktop/src/stores/fleet.ts`: extend the `Tab` type (line 13):

```ts
export type Tab = 'screen' | 'terminal' | 'logs' | 'resources' | 'connect' | 'folders'
```

Import `Share` in the existing `../shared/api` import. Add state near `resources`:

```ts
  // Per-VM shared folders, keyed by short name. Fetched on demand by the Folders tab.
  const shares = ref<Record<string, Share[]>>({})
```

Add actions near `fetchResources`:

```ts
  async function fetchShares(name: string): Promise<void> {
    try {
      const { shares: list } = await api.getShares(name)
      shares.value = { ...shares.value, [name]: list }
    } catch (e) {
      error.value = String(e)
    }
  }
  async function setShares(name: string, list: Share[]): Promise<void> {
    try {
      await api.setShares(name, list)
      await fetchShares(name)
      toast('Shared folders saved', '✓')
    } catch (e) {
      error.value = String(e)
      toast(`Failed to save shared folders for ${name}`, '⚠')
    }
  }
  async function restart(name: string): Promise<void> {
    toast(`Restarting ${name}…`, '↻')
    try {
      await api.restartVm(name)
      await refresh()
    } catch (e) {
      error.value = String(e)
      toast(`Failed to restart ${name}`, '⚠')
    }
  }
```

Expose `shares, fetchShares, setShares, restart` in the returned object.

- [ ] **Step 5: Run to verify they pass + typecheck**

Run: `bun run test:unit fleet` then `bunx vue-tsc -b` (check exit is 0, no error lines).
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/shared/api.ts desktop/src/stores/fleet.ts desktop/tests/unit/fleet.test.ts
git commit -m "feat(desktop): shares api client + store actions"
```

---

### Task 5: Folders tab

**Files:**
- Create: `desktop/src/components/vmtabs/FoldersTab.vue`
- Modify: `desktop/src/components/VmDetail.vue`
- Test: `desktop/tests/unit/FoldersTab.test.ts`

**Interfaces:**
- Consumes: `store.shares`, `store.fetchShares`, `store.setShares`, `store.restart`; `Share` from the api. Registered as the `folders` tab.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/tests/unit/FoldersTab.test.ts
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import FoldersTab from '../../src/components/vmtabs/FoldersTab.vue'
import { setToastScheduler } from '../../src/composables/useToasts'
import { api } from '../../src/shared/api'
import { useFleet } from '../../src/stores/fleet'

beforeEach(() => {
  setActivePinia(createPinia())
  setToastScheduler(() => {})
})

it('lists shares and removes one via setShares', async () => {
  vi.spyOn(api, 'getShares').mockResolvedValue({
    shares: [{ tag: 'src', host_path: '/h', read_only: true }],
  })
  const s = useFleet()
  const setShares = vi.spyOn(s, 'setShares').mockResolvedValue()
  const w = mount(FoldersTab, { props: { name: 'web' } })
  await flushPromises()
  expect(w.text()).toContain('src')
  await w.get('[data-test="folders-remove"]').trigger('click')
  expect(setShares).toHaveBeenCalledWith('web', [])
})

it('adds a folder from the path input, defaulting the tag to the basename', async () => {
  vi.spyOn(api, 'getShares').mockResolvedValue({ shares: [] })
  const s = useFleet()
  const setShares = vi.spyOn(s, 'setShares').mockResolvedValue()
  const w = mount(FoldersTab, { props: { name: 'web' } })
  await flushPromises()
  await w.get('[data-test="folders-add-path"]').setValue('/Users/me/src')
  await w.get('[data-test="folders-add"]').trigger('click')
  expect(setShares).toHaveBeenCalledWith('web', [
    { tag: 'src', host_path: '/Users/me/src', read_only: true },
  ])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test:unit FoldersTab`
Expected: FAIL (component missing).

- [ ] **Step 3: Create the component**

```vue
<!-- desktop/src/components/vmtabs/FoldersTab.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Share } from '../../shared/api'
import { useFleet } from '../../stores/fleet'

const props = defineProps<{ name: string }>()
const store = useFleet()
const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

const list = computed<Share[]>(() => store.shares[props.name] ?? [])
const vm = computed(() => store.vms.find((v) => short(v.name) === props.name))
const running = computed(() => vm.value?.state === 'running')
const newPath = ref('')

watch(() => props.name, (name) => store.fetchShares(name), { immediate: true })

function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || 'share'
}
function save(next: Share[]): void {
  store.setShares(props.name, next)
}
function add(): void {
  const path = newPath.value.trim()
  if (!path) return
  save([...list.value, { tag: basename(path), host_path: path, read_only: true }])
  newPath.value = ''
}
function remove(tag: string): void {
  save(list.value.filter((s) => s.tag !== tag))
}
function toggleRo(tag: string): void {
  save(list.value.map((s) => (s.tag === tag ? { ...s, read_only: !s.read_only } : s)))
}
async function browse(): Promise<void> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const p = await open({ directory: true })
    if (typeof p === 'string') newPath.value = p
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-[640px] flex-col gap-3">
    <div
      v-if="running"
      data-test="folders-restart-banner"
      class="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 py-2 text-[12px] text-[var(--text-dim)]"
    >
      <span>Shared-folder changes apply on the VM's next start.</span>
      <button
        type="button"
        data-test="folders-restart"
        class="h-7 rounded-md bg-[var(--emerald)] px-2.5 text-[11px] font-semibold text-[#04130d]"
        @click="store.restart(name)"
      >
        ↻ Restart
      </button>
    </div>

    <div v-if="!list.length" class="text-[12.5px] text-[var(--text-faint)]">
      No shared folders. Add a host directory to mount it into the guest.
    </div>
    <div
      v-for="s in list"
      :key="s.tag"
      data-test="folders-share-row"
      class="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elev2)] px-3 py-2"
    >
      <div class="min-w-0 flex-1">
        <div class="truncate font-mono text-[12.5px] text-[var(--text)]">{{ s.tag }}</div>
        <div class="truncate font-mono text-[11px] text-[var(--text-faint)]">{{ s.host_path }}</div>
        <div class="font-mono text-[11px] text-[var(--text-faint)]">
          guest: /Volumes/My Shared Files/{{ s.tag }}
        </div>
      </div>
      <button
        type="button"
        class="h-7 rounded-md border border-[var(--border)] px-2 text-[11px] text-[var(--text-dim)]"
        @click="toggleRo(s.tag)"
      >
        {{ s.read_only ? 'read-only' : 'read-write' }}
      </button>
      <button
        type="button"
        data-test="folders-remove"
        class="h-7 rounded-md border border-[var(--border)] px-2 text-[11px] text-[var(--red)]"
        @click="remove(s.tag)"
      >
        Remove
      </button>
    </div>

    <div class="flex gap-2">
      <input
        v-model="newPath"
        data-test="folders-add-path"
        placeholder="/Users/you/project"
        class="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 font-mono text-[12px] text-[var(--text)] outline-none"
      />
      <button
        type="button"
        data-test="folders-browse"
        class="h-9 rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--text-dim)]"
        @click="browse"
      >
        Browse…
      </button>
      <button
        type="button"
        data-test="folders-add"
        class="h-9 rounded-lg bg-[var(--emerald)] px-3 text-xs font-semibold text-[#04130d]"
        @click="add"
      >
        Add
      </button>
    </div>
    <div class="text-[11px] text-[var(--text-faint)]">
      Folders are read-only by default. Read-write lets guest (agent-driven) code modify host
      files — grant it deliberately.
    </div>
  </div>
</template>
```

- [ ] **Step 4: Register the tab in VmDetail**

In `desktop/src/components/VmDetail.vue`, import the component (with the other tab imports) and add it to both `TABS` and `TAB_COMPONENTS`:

```ts
import FoldersTab from './vmtabs/FoldersTab.vue'
```

`TABS` array — add after `resources`:

```ts
  { id: 'folders', label: 'Folders' },
```

`TAB_COMPONENTS` — add:

```ts
  folders: FoldersTab,
```

- [ ] **Step 5: Run the full desktop suite + lint + typecheck**

Run: `bun run test:unit` (verify the printed "Tests N passed" line), then `bun run lint`, then `bunx vue-tsc -b` (confirm exit 0 with no error lines).
Expected: all green. If a VmDetail test asserts the exact tab count/list, update it to include `folders`.

- [ ] **Step 6: Full regression + commit**

```bash
uv run pytest -q
cd desktop && bun run test:unit && cd ..
git add desktop/src/components/vmtabs/FoldersTab.vue desktop/src/components/VmDetail.vue desktop/tests/unit/FoldersTab.test.ts
git commit -m "feat(desktop): Folders tab for host<->guest shared folders"
```

---

## Self-Review

**Spec coverage (Feature D):** Persistence (`Shares`, `~/.macfleet/shares.json`) → Task 1; wired into Fleet with rename/nuke propagation → Task 2. `_run_argv` + all boot sites → Task 2. Apply-on-start + `restart` → Task 3. `GET`/`PUT /shares` + `POST /restart` → Task 3. Desktop client/store → Task 4. Folders tab (list/add/remove/RO toggle/guest path/restart banner/security note) with the Tauri picker + browser fallback → Task 5. Read-only default enforced in the store's `set_shares` normalization (Task 2) and the tab's `add` (Task 5).

**Placeholder scan:** none.

**Type consistency:** `Share {tag, host_path, read_only}` identical in `api.py` (`Share` model), `connect.py` (dict shape), and `api.ts`/store/`FoldersTab`. `get_shares`/`set_shares`/`restart` (engine), `getShares`/`setShares`/`restartVm` (api.ts), `fetchShares`/`setShares`/`restart` (store) are internally consistent. `_run_argv(full)` consumed only inside `connect.py`.

**Note:** the API `restart` route and CLI `restart` command share the name of Plan-1's snapshot work only incidentally; there is no existing `restart` endpoint/command to collide with (verified: `grep -n restart macfleet/api.py macfleet/cli.py` is empty before this plan).
