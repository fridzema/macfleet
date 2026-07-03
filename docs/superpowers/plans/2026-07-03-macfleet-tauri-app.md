# macfleet Tauri App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the macfleet desktop app — a Tauri v2 (Vue 3) GUI client, scaffolded from `oxide-dock`, that manages the VM fleet and does basic control (screenshot, click/type, logs) by polling the local `macfleet serve` API; plus a menu-bar tray.

**Architecture:** The app lives in `~/workspace/macfleet/desktop/` and talks to the sibling Python engine over `http://127.0.0.1:8765` (REST, polled ~1–2 fps — no WebSocket). Phase A first adds the control/log endpoints the GUI needs to the Python engine (TDD). Phases B–F scaffold the app, wire a typed API client, build the sidebar-and-detail UI (layout A), spawn `macfleet serve` as a Rust-managed sidecar, and add the tray.

**Tech Stack:** Python (FastAPI, adds to the shipped engine) + Vue 3 / Vite / TypeScript / Tailwind v4 / Pinia / vue-router / VueUse / Vitest / Playwright, Bun package manager, Rust / Tauri v2.

## Global Constraints

- App directory: `~/workspace/macfleet/desktop/`, scaffolded by cloning `https://github.com/fridzema/oxide-dock`. Engine code stays in `~/workspace/macfleet/macfleet/`.
- Use **`bun`** for all JS/TS package + script operations (never npm/yarn). Frontend tests: `bun run test:unit` (Vitest) run from `desktop/`. Engine tests: `uv run pytest` from repo root.
- API base URL: **`http://127.0.0.1:8765`** (the `macfleet serve` default port). Screenshot and logs are **polled at ~1–2 fps (750 ms interval), pausable**. No WebSocket, no SSE.
- Control endpoints (`click`/`type`/`key`/`screenshot`) require `MACFLEET_ALLOW_CONTROL=1` in the engine; when disabled they return **HTTP 409** and the UI shows a "control disabled — re-bake" hint.
- Main window = **layout A (sidebar + detail)**. Tray = **menu-bar mode** (Tauri v2 tray).
- Python: `from __future__ import annotations` + full type hints. TypeScript: strict, no `any` in exported signatures. Vue: `<script setup lang="ts">`.
- Conventional commits (`type(scope): description`); NO Co-authored-by trailers.
- The engine CLI has exactly these commands: `up, down, nuke, ls, ssh, bake, serve`. Do not invent others.

---

## Phase A — Engine API additions (Python, TDD)

### Task 1: Control endpoints (click / type / key)

**Files:**
- Modify: `macfleet/api.py` (add three routes inside `build_app`, after the `screenshot` route)
- Test: `tests/test_api_control.py`

**Interfaces:**
- Consumes: `build_app(fleet)` and the `fleet.computer(name)` facade from the shipped engine — the returned object honors `click(x, y)`, `type(text)`, `key(combo)`, `screenshot() -> bytes`, and raises `RuntimeError` when control is disabled.
- Produces: routes `POST /vms/{name}/click` (JSON `{"x": int, "y": int}`), `POST /vms/{name}/type` (`{"text": str}`), `POST /vms/{name}/key` (`{"combo": str}`), each returning `{"ok": true}` or HTTP 409 on `RuntimeError`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_api_control.py
from fastapi.testclient import TestClient
from macfleet.api import build_app
from macfleet.vm import VmInfo


class FakeComputer:
    def __init__(self):
        self.events = []

    def click(self, x, y):
        self.events.append(("click", x, y))

    def type(self, text):
        self.events.append(("type", text))

    def key(self, combo):
        self.events.append(("key", combo))


class FakeFleet:
    def __init__(self, computer_obj=None, computer_error=None):
        self.tart = self
        self._computer_obj = computer_obj
        self._computer_error = computer_error

    def list(self):
        return [VmInfo("mf-a", "running", "local")]

    def status(self, name):
        return True

    def computer(self, name):
        if self._computer_error is not None:
            raise self._computer_error
        return self._computer_obj


def test_click_forwards_coords():
    comp = FakeComputer()
    client = TestClient(build_app(FakeFleet(computer_obj=comp)))
    r = client.post("/vms/web/click", json={"x": 12, "y": 34})
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert ("click", 12, 34) in comp.events


def test_type_forwards_text():
    comp = FakeComputer()
    client = TestClient(build_app(FakeFleet(computer_obj=comp)))
    assert client.post("/vms/web/type", json={"text": "hi"}).status_code == 200
    assert ("type", "hi") in comp.events


def test_key_forwards_combo():
    comp = FakeComputer()
    client = TestClient(build_app(FakeFleet(computer_obj=comp)))
    assert client.post("/vms/web/key", json={"combo": "cmd+s"}).status_code == 200
    assert ("key", "cmd+s") in comp.events


def test_click_returns_409_when_control_disabled():
    fleet = FakeFleet(computer_error=RuntimeError("computer-use disabled — set MACFLEET_ALLOW_CONTROL=1"))
    client = TestClient(build_app(fleet))
    assert client.post("/vms/web/click", json={"x": 1, "y": 2}).status_code == 409
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_api_control.py -v`
Expected: FAIL — 404 (routes not defined) so the 200/409 assertions fail.

- [ ] **Step 3: Add the routes**

In `macfleet/api.py`, inside `build_app`, immediately after the existing `screenshot` route, add:

```python
    @api.post("/vms/{name}/click")
    def click(name: str, body: dict) -> dict:
        try:
            fleet.computer(name).click(int(body["x"]), int(body["y"]))
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True}

    @api.post("/vms/{name}/type")
    def type_text(name: str, body: dict) -> dict:
        try:
            fleet.computer(name).type(body["text"])
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True}

    @api.post("/vms/{name}/key")
    def key(name: str, body: dict) -> dict:
        try:
            fleet.computer(name).key(body["combo"])
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_api_control.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add macfleet/api.py tests/test_api_control.py
git commit -m "feat(api): click/type/key control endpoints (409 when disabled)"
```

---

### Task 2: Logs endpoint + CORS + log paths in the launchd plist

**Files:**
- Modify: `macfleet/connect.py` (add `Fleet.logs`)
- Modify: `macfleet/api.py` (add CORS middleware + `GET /vms/{name}/logs`)
- Modify: `macfleet/provision.py` (`_PLIST` writes stdout/stderr to a log file)
- Test: `tests/test_api_logs.py`; extend `tests/test_provision.py`

**Interfaces:**
- Consumes: `Fleet.ssh(name, remote_cmd) -> str` from the shipped engine.
- Produces:
  - `Fleet.logs(self, name: str, lines: int = 100) -> str` — tails the computer-server log over SSH.
  - `GET /vms/{name}/logs?lines=N` → `{"lines": str}`.
  - CORS: the app responds with `access-control-allow-origin: *` (the API binds `127.0.0.1` only, not network-exposed).
  - Log file path constant `SERVER_LOG = "/Users/admin/Library/Logs/macfleet-computerserver.log"` in `provision.py`, referenced by `Fleet.logs`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_api_logs.py
from fastapi.testclient import TestClient
from macfleet.api import build_app
from macfleet.connect import Fleet
from macfleet.vm import Tart, VmInfo
import subprocess


def fake_tart(name="mf-a"):
    import json

    def run(argv):
        out = json.dumps([{"Name": name, "State": "running", "Source": "local"}]) if argv[:2] == ["tart", "list"] else ""
        return subprocess.CompletedProcess(argv, 0, out, "")
    return Tart(run=run)


def test_logs_endpoint_returns_tail():
    # Fleet.ssh is exercised through an injected runner that returns canned log text.
    def run(argv):
        if argv[0] == "ssh":
            return subprocess.CompletedProcess(argv, 0, "line1\nline2\n", "")
        return subprocess.CompletedProcess(argv, 0, "192.168.64.4\n", "")
    fleet = Fleet(tart=fake_tart(), run=run)
    client = TestClient(build_app(fleet))
    r = client.get("/vms/a/logs?lines=50")
    assert r.status_code == 200
    assert r.json() == {"lines": "line1\nline2\n"}


def test_cors_header_present():
    fleet = Fleet(tart=fake_tart(), run=lambda argv: subprocess.CompletedProcess(argv, 0, "[]", ""))
    client = TestClient(build_app(fleet))
    r = client.get("/vms", headers={"Origin": "tauri://localhost"})
    assert r.headers.get("access-control-allow-origin") == "*"
```

Add to `tests/test_provision.py`:

```python
def test_plist_writes_log_file():
    from macfleet.provision import render_provision_script, SERVER_LOG
    s = render_provision_script()
    assert SERVER_LOG in s
    assert "StandardOutPath" in s
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_logs.py tests/test_provision.py::test_plist_writes_log_file -v`
Expected: FAIL — `Fleet.logs`/route/`SERVER_LOG` not defined.

- [ ] **Step 3: Implement**

In `macfleet/provision.py`, add the constant near the top and the two plist keys:

```python
SERVER_LOG = "/Users/admin/Library/Logs/macfleet-computerserver.log"
```

In `_PLIST`, inside the `<dict>`, add (after the `KeepAlive` key):

```xml
  <key>StandardOutPath</key><string>/Users/admin/Library/Logs/macfleet-computerserver.log</string>
  <key>StandardErrorPath</key><string>/Users/admin/Library/Logs/macfleet-computerserver.log</string>
```

In `macfleet/connect.py`, add to `Fleet`:

```python
    def logs(self, name: str, lines: int = 100) -> str:
        from macfleet.provision import SERVER_LOG

        return self.ssh(name, f"tail -n {int(lines)} {SERVER_LOG} 2>/dev/null || true")
```

In `macfleet/api.py`, add the CORS import at the top and register the middleware + route inside `build_app`:

```python
from fastapi.middleware.cors import CORSMiddleware
```

Right after `api = FastAPI(title="macfleet")`:

```python
    api.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )
```

After the control routes:

```python
    @api.get("/vms/{name}/logs")
    def logs(name: str, lines: int = 100) -> dict:
        return {"lines": fleet.logs(name, lines)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_logs.py tests/test_provision.py -v`
Expected: PASS

- [ ] **Step 5: Run full engine suite + commit**

Run: `uv run pytest -q && uv run ruff check .`
Expected: all pass, ruff clean

```bash
git add macfleet/connect.py macfleet/api.py macfleet/provision.py tests/test_api_logs.py tests/test_provision.py
git commit -m "feat(api): logs endpoint + CORS; provision writes computer-server log file"
```

---

## Phase B — App scaffold, API client, Rust sidecar

### Task 3: Scaffold `desktop/` from oxide-dock

**Files:**
- Create: `desktop/` (clone of oxide-dock, history removed, demo content stripped)
- Modify: `desktop/src-tauri/tauri.conf.json`, `desktop/package.json`
- Delete: `desktop/src/components/{ClipboardDemo,FileDialogDemo,NotificationDemo,SystemInfoDemo}.vue`

**Interfaces:**
- Produces: a buildable Tauri app in `desktop/` renamed to macfleet, with `bun run test:unit` green on the trimmed baseline.

- [ ] **Step 1: Clone the template into `desktop/`**

```bash
cd /Users/fridzema/workspace/macfleet
git clone --depth 1 https://github.com/fridzema/oxide-dock desktop
rm -rf desktop/.git desktop/CHANGELOG.md desktop/.github
```

- [ ] **Step 2: Rename the app**

In `desktop/src-tauri/tauri.conf.json` set:
- `"productName": "macfleet"`
- `"identifier": "com.macfleet.desktop"`
- window `"title": "macfleet"`, `"width": 1100`, `"height": 760`
- `security.csp`: `"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:8765"`

In `desktop/package.json` set `"name": "macfleet-desktop"`.

- [ ] **Step 3: Strip demo components + wire an empty HomePage**

```bash
rm -f desktop/src/components/ClipboardDemo.vue desktop/src/components/FileDialogDemo.vue \
      desktop/src/components/NotificationDemo.vue desktop/src/components/SystemInfoDemo.vue
```

Replace `desktop/src/pages/HomePage.vue` with a placeholder that Task 9 will fill:

```vue
<script setup lang="ts">
</script>

<template>
  <main class="p-4 text-sm">macfleet — fleet dashboard (wiring in progress)</main>
</template>
```

- [ ] **Step 4: Install + verify baseline**

Run:
```bash
cd /Users/fridzema/workspace/macfleet/desktop && bun install && bun run test:unit
```
Expected: install succeeds; Vitest runs (the counter store test from the template passes; if a deleted demo had a test, remove that test file too and re-run until green).

- [ ] **Step 5: Commit**

```bash
cd /Users/fridzema/workspace/macfleet
git add desktop
git commit -m "chore(desktop): scaffold macfleet app from oxide-dock, strip demos"
```

---

### Task 4: Typed API client (`desktop/src/shared/api.ts`)

**Files:**
- Create: `desktop/src/shared/api.ts`
- Test: `desktop/src/shared/api.test.ts`

**Interfaces:**
- Produces:
  - `API_BASE = "http://127.0.0.1:8765"`
  - `interface Vm { name: string; state: string; source: string; healthy: boolean }`
  - `const api` with: `listVms(): Promise<Vm[]>`, `up/down/nuke(n: string): Promise<unknown>`, `status(n): Promise<{healthy: boolean}>`, `screenshot(n): Promise<{png_b64: string}>`, `click(n,x,y)`, `typeText(n,text)`, `key(n,combo)`, `logs(n, lines?): Promise<{lines: string}>`.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/src/shared/api.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, API_BASE } from './api'

afterEach(() => vi.restoreAllMocks())

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  )
}

describe('api', () => {
  it('listVms GETs /vms', async () => {
    const f = mockFetch(200, [{ name: 'mf-a', state: 'running', source: 'local', healthy: true }])
    const vms = await api.listVms()
    expect(f).toHaveBeenCalledWith(`${API_BASE}/vms`, undefined)
    expect(vms[0].name).toBe('mf-a')
  })

  it('click POSTs JSON coords', async () => {
    const f = mockFetch(200, { ok: true })
    await api.click('web', 5, 9)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${API_BASE}/vms/web/click`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ x: 5, y: 9 })
  })

  it('throws on non-ok', async () => {
    mockFetch(409, { detail: 'disabled' })
    await expect(api.screenshot('web')).rejects.toThrow('409')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && bun run test:unit src/shared/api.test.ts`
Expected: FAIL — cannot import `./api`.

- [ ] **Step 3: Implement**

```ts
// desktop/src/shared/api.ts
export const API_BASE = 'http://127.0.0.1:8765'

export interface Vm {
  name: string
  state: string
  source: string
  healthy: boolean
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init)
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}`)
  return (await res.json()) as T
}

function postJson(path: string, payload: unknown): Promise<unknown> {
  return j(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export const api = {
  listVms: () => j<Vm[]>('/vms'),
  up: (n: string) => j(`/vms/${n}/up`, { method: 'POST' }),
  down: (n: string) => j(`/vms/${n}/down`, { method: 'POST' }),
  nuke: (n: string) => j(`/vms/${n}/nuke`, { method: 'POST' }),
  status: (n: string) => j<{ healthy: boolean }>(`/vms/${n}/status`),
  screenshot: (n: string) => j<{ png_b64: string }>(`/vms/${n}/screenshot`, { method: 'POST' }),
  click: (n: string, x: number, y: number) => postJson(`/vms/${n}/click`, { x, y }),
  typeText: (n: string, text: string) => postJson(`/vms/${n}/type`, { text }),
  key: (n: string, combo: string) => postJson(`/vms/${n}/key`, { combo }),
  logs: (n: string, lines = 100) => j<{ lines: string }>(`/vms/${n}/logs?lines=${lines}`),
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && bun run test:unit src/shared/api.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
cd /Users/fridzema/workspace/macfleet
git add desktop/src/shared/api.ts desktop/src/shared/api.test.ts
git commit -m "feat(desktop): typed macfleet API client"
```

---

### Task 5: Rust-managed `macfleet serve` sidecar

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: the engine at the repo root (`..` relative to `desktop/`); `uv run macfleet serve --port 8765`.
- Produces: on app start the sidecar is spawned; on app exit it is killed. No frontend interface (the frontend uses the fixed `API_BASE`).

- [ ] **Step 1: Add the sidecar to the builder**

There is no unit test for process spawning; this is verified manually in Step 2. Edit `desktop/src-tauri/src/lib.rs`:

1. Add imports at the top of the file (below the existing `mod` lines):

```rust
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct Sidecar(Mutex<Option<Child>>);
```

2. In the builder chain, add a `.setup(...)` call immediately before `.run(tauri::generate_context!())?;`:

```rust
        .setup(|app| {
            // Spawn the Python engine's local API as a managed sidecar.
            // In dev the app runs from `desktop/`, so the engine repo root is `..`.
            let child = Command::new("uv")
                .args(["run", "macfleet", "serve", "--port", "8765"])
                .current_dir("..")
                .spawn()
                .ok();
            app.manage(Sidecar(Mutex::new(child)));
            Ok(())
        })
```

3. Replace the final `.run(tauri::generate_context!())?;` with a build-then-run that kills the sidecar on exit:

```rust
        .build(tauri::generate_context!())?
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(sc) = app_handle.try_state::<Sidecar>() {
                    if let Some(mut child) = sc.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
    Ok(())
```

- [ ] **Step 2: Verify the app boots and reaches the API**

Run (manual; needs the engine venv + `uv` on PATH):
```bash
cd /Users/fridzema/workspace/macfleet/desktop && bun run tauri dev
```
Expected: the window opens; in a second terminal `curl -s http://127.0.0.1:8765/vms` returns JSON (proving the sidecar spawned). Close the app; confirm no `macfleet serve` process lingers (`pgrep -f "macfleet serve"` prints nothing).

- [ ] **Step 3: Commit**

```bash
cd /Users/fridzema/workspace/macfleet
git add desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): spawn/kill macfleet serve as a Rust-managed sidecar"
```

---

## Phase C — Fleet view (sidebar)

### Task 6: Pinia fleet store (`desktop/src/stores/fleet.ts`)

**Files:**
- Create: `desktop/src/stores/fleet.ts`
- Test: `desktop/src/stores/fleet.test.ts`

**Interfaces:**
- Consumes: `api` from `../shared/api`.
- Produces: `useFleet()` store exposing `vms: Ref<Vm[]>`, `error: Ref<string | null>`, `refresh(): Promise<void>`, `up/down/nuke(name: string): Promise<void>` (each refreshes after acting).

- [ ] **Step 1: Write the failing test**

```ts
// desktop/src/stores/fleet.test.ts
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFleet } from './fleet'
import { api } from '../shared/api'

beforeEach(() => setActivePinia(createPinia()))

describe('fleet store', () => {
  it('refresh loads vms', async () => {
    vi.spyOn(api, 'listVms').mockResolvedValue([
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
    ])
    const s = useFleet()
    await s.refresh()
    expect(s.vms).toHaveLength(1)
    expect(s.error).toBeNull()
  })

  it('up calls api then refreshes', async () => {
    const up = vi.spyOn(api, 'up').mockResolvedValue({})
    vi.spyOn(api, 'listVms').mockResolvedValue([])
    const s = useFleet()
    await s.up('web')
    expect(up).toHaveBeenCalledWith('web')
  })

  it('refresh records errors', async () => {
    vi.spyOn(api, 'listVms').mockRejectedValue(new Error('boom'))
    const s = useFleet()
    await s.refresh()
    expect(s.error).toContain('boom')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && bun run test:unit src/stores/fleet.test.ts`
Expected: FAIL — cannot import `./fleet`.

- [ ] **Step 3: Implement**

```ts
// desktop/src/stores/fleet.ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, type Vm } from '../shared/api'

export const useFleet = defineStore('fleet', () => {
  const vms = ref<Vm[]>([])
  const error = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      vms.value = await api.listVms()
      error.value = null
    } catch (e) {
      error.value = String(e)
    }
  }

  async function up(name: string): Promise<void> {
    await api.up(name)
    await refresh()
  }
  async function down(name: string): Promise<void> {
    await api.down(name)
    await refresh()
  }
  async function nuke(name: string): Promise<void> {
    await api.nuke(name)
    await refresh()
  }

  return { vms, error, refresh, up, down, nuke }
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && bun run test:unit src/stores/fleet.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
cd /Users/fridzema/workspace/macfleet
git add desktop/src/stores/fleet.ts desktop/src/stores/fleet.test.ts
git commit -m "feat(desktop): pinia fleet store (refresh + up/down/nuke)"
```

---

### Task 7: Fleet sidebar (`desktop/src/components/FleetSidebar.vue`)

**Files:**
- Create: `desktop/src/components/FleetSidebar.vue`
- Test: `desktop/src/components/FleetSidebar.test.ts`

**Interfaces:**
- Consumes: `useFleet()` store.
- Produces: a component that renders one row per VM (name, state, a health dot) and emits `select` with the VM short name (strip a leading `mf-`) when a row is clicked; an `up` button calls `store.up(promptedName)`. Emits: `(e: 'select', name: string)`.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/src/components/FleetSidebar.test.ts
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import FleetSidebar from './FleetSidebar.vue'
import { useFleet } from '../stores/fleet'

beforeEach(() => setActivePinia(createPinia()))

describe('FleetSidebar', () => {
  it('renders a row per vm and emits select with short name', async () => {
    const store = useFleet()
    store.vms = [
      { name: 'mf-a', state: 'running', source: 'local', healthy: true },
      { name: 'mf-b', state: 'stopped', source: 'local', healthy: false },
    ]
    const wrapper = mount(FleetSidebar)
    const rows = wrapper.findAll('[data-test="vm-row"]')
    expect(rows).toHaveLength(2)
    await rows[0].trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && bun run test:unit src/components/FleetSidebar.test.ts`
Expected: FAIL — cannot import the component.

- [ ] **Step 3: Implement**

```vue
<!-- desktop/src/components/FleetSidebar.vue -->
<script setup lang="ts">
import { onMounted } from 'vue'
import { useFleet } from '../stores/fleet'
import type { Vm } from '../shared/api'

const store = useFleet()
const emit = defineEmits<{ (e: 'select', name: string): void }>()

const short = (n: string) => (n.startsWith('mf-') ? n.slice(3) : n)

onMounted(() => {
  store.refresh()
})

function select(vm: Vm) {
  emit('select', short(vm.name))
}
</script>

<template>
  <aside class="w-64 shrink-0 border-r border-neutral-800 p-2 text-sm">
    <div v-if="store.error" class="mb-2 text-red-400">{{ store.error }}</div>
    <button
      v-for="vm in store.vms"
      :key="vm.name"
      data-test="vm-row"
      class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-neutral-800"
      @click="select(vm)"
    >
      <span
        class="h-2 w-2 rounded-full"
        :class="vm.healthy ? 'bg-green-500' : 'bg-neutral-600'"
      />
      <span class="flex-1">{{ vm.name }}</span>
      <span class="text-neutral-500">{{ vm.state }}</span>
    </button>
  </aside>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && bun run test:unit src/components/FleetSidebar.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/fridzema/workspace/macfleet
git add desktop/src/components/FleetSidebar.vue desktop/src/components/FleetSidebar.test.ts
git commit -m "feat(desktop): fleet sidebar list with health dots + select"
```

---

## Phase D — VM detail (screenshot control + logs)

### Task 8: VM detail with screenshot polling + control (`desktop/src/components/VmDetail.vue`)

**Files:**
- Create: `desktop/src/components/VmDetail.vue`
- Test: `desktop/src/components/VmDetail.test.ts`

**Interfaces:**
- Consumes: `api` (`screenshot`, `click`, `typeText`).
- Produces: a component with prop `name: string`. It polls `api.screenshot(name)` every 750 ms into an `<img>` (`data:image/png;base64,...`), stops polling on unmount and when `paused` is true. Clicking the image maps the click to image pixel coordinates and calls `api.click(name, x, y)`. A text field + button calls `api.typeText`.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/src/components/VmDetail.test.ts
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VmDetail from './VmDetail.vue'
import { api } from '../shared/api'

afterEach(() => vi.restoreAllMocks())

describe('VmDetail', () => {
  it('renders the polled screenshot as a data URI', async () => {
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const wrapper = mount(VmDetail, { props: { name: 'web' } })
    await vi.waitFor(() => {
      const src = wrapper.find('[data-test="shot"]').attributes('src')
      expect(src).toBe('data:image/png;base64,QUJD')
    })
    wrapper.unmount()
  })

  it('maps an image click to pixel coords and calls api.click', async () => {
    vi.spyOn(api, 'screenshot').mockResolvedValue({ png_b64: 'QUJD' })
    const click = vi.spyOn(api, 'click').mockResolvedValue({})
    const wrapper = mount(VmDetail, { props: { name: 'web' } })
    const img = wrapper.find('[data-test="shot"]')
    // stub geometry: 100x100 element mapping to a 200x200 natural image => scale 2x
    const el = img.element as HTMLImageElement
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    })
    Object.defineProperty(el, 'naturalWidth', { value: 200 })
    Object.defineProperty(el, 'naturalHeight', { value: 200 })
    await img.trigger('click', { clientX: 10, clientY: 20 })
    expect(click).toHaveBeenCalledWith('web', 20, 40)
    wrapper.unmount()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && bun run test:unit src/components/VmDetail.test.ts`
Expected: FAIL — cannot import the component.

- [ ] **Step 3: Implement**

```vue
<!-- desktop/src/components/VmDetail.vue -->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../shared/api'

const props = defineProps<{ name: string }>()

const shot = ref<string | null>(null)
const paused = ref(false)
const typed = ref('')
const err = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

async function poll() {
  if (paused.value) return
  try {
    const { png_b64 } = await api.screenshot(props.name)
    shot.value = `data:image/png;base64,${png_b64}`
    err.value = null
  } catch (e) {
    err.value = String(e)
  }
}

function start() {
  stop()
  poll()
  timer = setInterval(poll, 750)
}
function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

watch(() => props.name, start, { immediate: true })
onBeforeUnmount(stop)

async function onImgClick(ev: MouseEvent) {
  const el = ev.target as HTMLImageElement
  const rect = el.getBoundingClientRect()
  const sx = el.naturalWidth / rect.width
  const sy = el.naturalHeight / rect.height
  const x = Math.round((ev.clientX - rect.left) * sx)
  const y = Math.round((ev.clientY - rect.top) * sy)
  await api.click(props.name, x, y)
}

async function sendType() {
  if (typed.value) {
    await api.typeText(props.name, typed.value)
    typed.value = ''
  }
}
</script>

<template>
  <section class="flex flex-1 flex-col gap-2 p-2 text-sm">
    <div class="flex items-center gap-2">
      <strong>{{ name }}</strong>
      <button class="rounded border border-neutral-700 px-2 py-0.5" @click="paused = !paused">
        {{ paused ? 'resume' : 'pause' }}
      </button>
      <span v-if="err" class="text-red-400">{{ err }}</span>
    </div>
    <img
      v-if="shot"
      data-test="shot"
      :src="shot"
      class="max-w-full cursor-crosshair rounded border border-neutral-800"
      @click="onImgClick"
    />
    <div v-else class="rounded border border-dashed border-neutral-700 p-6 text-neutral-500">
      no screenshot (control disabled or VM not ready)
    </div>
    <form class="flex gap-2" @submit.prevent="sendType">
      <input
        v-model="typed"
        placeholder="type into VM…"
        class="flex-1 rounded border border-neutral-700 bg-transparent px-2 py-1"
      />
      <button class="rounded border border-neutral-700 px-2 py-1" type="submit">send</button>
    </form>
  </section>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && bun run test:unit src/components/VmDetail.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
cd /Users/fridzema/workspace/macfleet
git add desktop/src/components/VmDetail.vue desktop/src/components/VmDetail.test.ts
git commit -m "feat(desktop): VM detail with polled screenshot + click/type control"
```

---

### Task 9: Log pane + dashboard wiring (`LogPane.vue` + `HomePage.vue`)

**Files:**
- Create: `desktop/src/components/LogPane.vue`
- Test: `desktop/src/components/LogPane.test.ts`
- Modify: `desktop/src/pages/HomePage.vue` (compose sidebar + detail + logs)

**Interfaces:**
- Consumes: `api.logs`; `FleetSidebar` (emits `select`), `VmDetail` (prop `name`).
- Produces: `LogPane.vue` with prop `name: string` that polls `api.logs(name)` every 2 s into a `<pre>`; `HomePage.vue` holds a `selected` ref wired from the sidebar's `select` event.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/src/components/LogPane.test.ts
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LogPane from './LogPane.vue'
import { api } from '../shared/api'

afterEach(() => vi.restoreAllMocks())

describe('LogPane', () => {
  it('polls logs and renders them', async () => {
    vi.spyOn(api, 'logs').mockResolvedValue({ lines: 'boot ok\nserver up' })
    const wrapper = mount(LogPane, { props: { name: 'web' } })
    await vi.waitFor(() => expect(wrapper.find('pre').text()).toContain('server up'))
    wrapper.unmount()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && bun run test:unit src/components/LogPane.test.ts`
Expected: FAIL — cannot import the component.

- [ ] **Step 3: Implement `LogPane.vue`**

```vue
<!-- desktop/src/components/LogPane.vue -->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../shared/api'

const props = defineProps<{ name: string }>()
const text = ref('')
let timer: ReturnType<typeof setInterval> | null = null

async function poll() {
  try {
    text.value = (await api.logs(props.name)).lines
  } catch (e) {
    text.value = String(e)
  }
}
function start() {
  if (timer) clearInterval(timer)
  poll()
  timer = setInterval(poll, 2000)
}
watch(() => props.name, start, { immediate: true })
onBeforeUnmount(() => timer && clearInterval(timer))
</script>

<template>
  <pre class="h-40 overflow-auto rounded border border-neutral-800 bg-black/30 p-2 text-xs">{{ text }}</pre>
</template>
```

- [ ] **Step 4: Wire the dashboard in `HomePage.vue`**

```vue
<!-- desktop/src/pages/HomePage.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import FleetSidebar from '../components/FleetSidebar.vue'
import VmDetail from '../components/VmDetail.vue'
import LogPane from '../components/LogPane.vue'

const selected = ref<string | null>(null)
</script>

<template>
  <div class="flex h-screen">
    <FleetSidebar @select="selected = $event" />
    <main class="flex flex-1 flex-col">
      <template v-if="selected">
        <VmDetail :name="selected" />
        <div class="p-2"><LogPane :name="selected" /></div>
      </template>
      <div v-else class="p-6 text-sm text-neutral-500">select a VM</div>
    </main>
  </div>
</template>
```

- [ ] **Step 5: Run tests + commit**

Run: `cd desktop && bun run test:unit`
Expected: all component/store/api tests pass.

```bash
cd /Users/fridzema/workspace/macfleet
git add desktop/src/components/LogPane.vue desktop/src/components/LogPane.test.ts desktop/src/pages/HomePage.vue
git commit -m "feat(desktop): log pane + dashboard wiring (sidebar + detail + logs)"
```

---

## Phase E — Menu-bar tray

### Task 10: System tray (`desktop/src-tauri/src/lib.rs` + `Cargo.toml`)

**Files:**
- Modify: `desktop/src-tauri/Cargo.toml` (enable the `tray-icon` feature)
- Modify: `desktop/src-tauri/src/lib.rs` (build a tray in `setup`)

**Interfaces:**
- Consumes: the running app + window from Task 5's `setup`.
- Produces: a menu-bar tray icon with a menu — "Show macfleet" (focuses the main window) and "Quit". No frontend interface.

- [ ] **Step 1: Enable the tray feature**

There is no unit test for the tray; verify manually in Step 3. In `desktop/src-tauri/Cargo.toml`, add the `tray-icon` feature to the `tauri` dependency, e.g.:

```toml
tauri = { version = "2", features = ["tray-icon"] }
```

(Keep any existing features; append `"tray-icon"`.)

- [ ] **Step 2: Build the tray inside `setup`**

In `desktop/src-tauri/src/lib.rs`, add these imports near the others:

```rust
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
```

Inside the existing `.setup(|app| { ... })` closure from Task 5, before `Ok(())`, add:

```rust
            let show = MenuItem::with_id(app, "show", "Show macfleet", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
```

- [ ] **Step 3: Verify the tray appears**

Run: `cd /Users/fridzema/workspace/macfleet/desktop && bun run tauri dev`
Expected: a macfleet icon appears in the macOS menu bar; its menu has "Show macfleet" and "Quit"; "Show" focuses the window; "Quit" exits (and the sidecar dies via Task 5's exit handler).

- [ ] **Step 4: Commit**

```bash
cd /Users/fridzema/workspace/macfleet
git add desktop/src-tauri/Cargo.toml desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): menu-bar tray (show/quit)"
```

---

## Phase F — E2E + docs

### Task 11: Playwright smoke against a mocked API + desktop README

**Files:**
- Create: `desktop/tests/e2e/dashboard.spec.ts`
- Create: `desktop/README.md`

**Interfaces:**
- Consumes: the built frontend served by Vite; Playwright intercepts `http://127.0.0.1:8765/**` so no engine/VM is needed.

- [ ] **Step 1: Write the e2e smoke test**

```ts
// desktop/tests/e2e/dashboard.spec.ts
import { expect, test } from '@playwright/test'

test('sidebar lists mocked VMs and selecting shows detail', async ({ page }) => {
  await page.route('**/vms', (route) =>
    route.fulfill({ json: [{ name: 'mf-a', state: 'running', source: 'local', healthy: true }] }),
  )
  await page.route('**/vms/*/screenshot', (route) => route.fulfill({ json: { png_b64: 'QUJD' } }))
  await page.route('**/vms/*/logs**', (route) => route.fulfill({ json: { lines: 'ok' } }))

  await page.goto('/')
  const row = page.getByTestId('vm-row')
  await expect(row).toHaveText(/mf-a/)
  await row.click()
  await expect(page.getByTestId('shot')).toBeVisible()
})
```

- [ ] **Step 2: Run it**

Run: `cd desktop && bun run test:e2e tests/e2e/dashboard.spec.ts`
Expected: PASS (Playwright starts Vite via the template's `playwright.config.ts` webServer; if the config's testDir doesn't include `tests/e2e`, point it there or move the spec under the config's `testDir`).

- [ ] **Step 3: Write `desktop/README.md`**

Document: what the app is (Tauri GUI client to `macfleet serve`, layout A + tray); prerequisites (the engine set up per the root README, `bun`, Rust/Tauri deps); `bun install`; `bun run tauri dev` (spawns the engine sidecar automatically); that control (screenshot/click/type) needs `MACFLEET_ALLOW_CONTROL=1` on the engine and a reachable VM, otherwise the detail pane shows the disabled hint; `bun run test:unit` + `bun run test:e2e`. Note the app is dev-run for now; a bundled `.app` (PyInstaller sidecar) is a later follow-up.

- [ ] **Step 4: Commit**

```bash
cd /Users/fridzema/workspace/macfleet
git add desktop/tests/e2e/dashboard.spec.ts desktop/README.md
git commit -m "test(desktop): playwright dashboard smoke + README"
```

---

## Self-Review

**Spec coverage (against the design spec's Tauri-app section):**
- GUI client to `macfleet serve` → Tasks 4–9 (API client, store, components). Engine endpoints the GUI needs → Tasks 1–2.
- Layout A (sidebar + detail) → Tasks 7 (sidebar), 8 (detail), 9 (dashboard compose).
- Live screenshot click-through + type → Task 8; log tail → Task 9; ~1–2 fps pausable polling → Task 8 (750 ms + pause).
- Rust shell spawns/supervises the `macfleet serve` sidecar → Task 5.
- System tray = menu-bar mode → Task 10.
- Reuses oxide-dock (Vite/Pinia/Vitest/Playwright) → Task 3.
- Out of scope (deferred, per spec): bundled PyInstaller sidecar `.app`, WS streaming, resource stats, file push/pull drop-zone, per-VM bake-from. Not tasked — noted so they aren't mistaken for gaps.

**Placeholder scan:** No TBD/TODO. The two Rust tasks (5, 10) and the tray/sidecar are process/UI behavior with no unit harness — each carries a concrete manual verification command, not a vague "test it". Task 3/2 note conditional cleanup ("if a deleted demo had a test") — that is a concrete instruction, not a placeholder.

**Type consistency:** `Vm` shape (`name/state/source/healthy`) is identical across `api.ts` (Task 4), the store (Task 6), and the sidebar (Task 7). `api` method names (`listVms/up/down/nuke/status/screenshot/click/typeText/key/logs`) are defined in Task 4 and used unchanged in Tasks 6, 8, 9. Engine routes added in Tasks 1–2 (`/vms/{name}/click|type|key|logs`) match the `api.ts` paths exactly. `useFleet` store surface (`vms/error/refresh/up/down/nuke`) is consistent across Tasks 6, 7. Component props (`VmDetail`/`LogPane` take `name: string`; `FleetSidebar` emits `select`) match their consumers in Task 9.

**Cross-plan note:** Tasks 1–2 modify the already-merged engine (`macfleet/`), so this plan touches two subsystems by necessity (the GUI needs new endpoints). They are TDD'd against the engine suite and kept minimal; the bulk (Tasks 3–11) is the app.
