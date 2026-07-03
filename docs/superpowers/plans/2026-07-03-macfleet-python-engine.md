# macfleet Python Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `macfleet` Python package — a CLI + local HTTP API that spins up a fleet of macOS `tart` VMs, manages them over SSH, and drives them via trycua `cua-computer-server`.

**Architecture:** One Python core (`vm`, `provision`, `connect`, `agent`, `api`) called by both a `typer` CLI and a FastAPI app. External effects (`tart`, `ssh`, `scp`, the cua SDK, Anthropic) are injected as callables/lazy imports so the core is unit-testable with zero hardware. VM-dependent behaviour is verified by an L0–L3 ladder; L0 runs fully offline against fakes.

**Tech Stack:** Python 3.12, `uv`, `typer`, `fastapi`, `uvicorn`, `pytest`, `ruff`. Optional extras: `[control]` → `cua-computer`; `[agent]` → `anthropic`.

## Global Constraints

- Python **3.12+**. `from __future__ import annotations` + `strict` typing in every module (full type hints; no bare `Any` in public signatures).
- Package name `macfleet`; VM name convention **`mf-<name>`**; golden template **`mf-golden`**; guest user **`admin`**; computer-server port **`8000`**; base image **`ghcr.io/cirruslabs/macos-tahoe-base:latest`**.
- All shell effects go through an **injected runner** (`Runner = Callable[[list[str]], subprocess.CompletedProcess[str]]`) — never call `subprocess` directly in core logic. Tests pass a fake runner.
- SSH options constant: `-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=8`.
- Conventional commits: `type(scope): description`. No Co-authored-by trailers.
- Real computer-use is gated by env `MACFLEET_ALLOW_CONTROL=1` (VM-only safety, mirrors the source repo).

---

### Task 1: Project scaffold

**Files:**
- Create: `pyproject.toml`
- Create: `macfleet/__init__.py`
- Create: `tests/test_smoke.py`
- Create: `Makefile`

**Interfaces:**
- Consumes: nothing.
- Produces: package `macfleet` with `__version__: str`; `uv run pytest` and `uv run ruff check` are the standard commands.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_smoke.py
import macfleet


def test_version_present():
    assert isinstance(macfleet.__version__, str)
    assert macfleet.__version__
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_smoke.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'macfleet'`

- [ ] **Step 3: Write minimal implementation**

```toml
# pyproject.toml
[project]
name = "macfleet"
version = "0.1.0"
description = "Spin up and control a fleet of macOS VMs via tart + cua"
requires-python = ">=3.12"
dependencies = ["typer>=0.12", "fastapi>=0.111", "uvicorn>=0.30"]

[project.optional-dependencies]
control = ["cua-computer>=0.3"]
agent = ["anthropic>=0.40"]
dev = ["pytest>=8", "ruff>=0.6", "httpx>=0.27"]

[project.scripts]
macfleet = "macfleet.cli:app"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.ruff]
target-version = "py312"
line-length = 100
```

```python
# macfleet/__init__.py
"""macfleet — a fleet of disposable macOS VMs, SSH-managed and computer-use-driven."""
from __future__ import annotations

__version__ = "0.1.0"
```

```makefile
# Makefile
setup: ; uv sync --extra dev
test: ; uv run pytest -q
lint: ; uv run ruff check .
serve: ; uv run macfleet serve
.PHONY: setup test lint serve
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv sync --extra dev && uv run pytest tests/test_smoke.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml macfleet/__init__.py tests/test_smoke.py Makefile
git commit -m "chore: scaffold macfleet package"
```

---

### Task 2: `tart` wrapper (`vm.py`)

**Files:**
- Create: `macfleet/vm.py`
- Test: `tests/test_vm.py`

**Interfaces:**
- Consumes: `Runner` type (defined here).
- Produces:
  - `Runner = Callable[[list[str]], subprocess.CompletedProcess[str]]`
  - `@dataclass(frozen=True) class VmInfo: name: str; state: str; source: str`
  - `fullname(name: str) -> str` → `f"mf-{name}"` (idempotent if already prefixed)
  - `shortname(name: str) -> str` → strips a leading `mf-`
  - `class Tart:` `__init__(self, run: Runner = _run)`, `list(self) -> list[VmInfo]`, `clone(self, src: str, dst: str) -> None`, `start(self, name: str) -> None`, `ip(self, name: str) -> str`, `stop(self, name: str) -> None`, `delete(self, name: str) -> None`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_vm.py
import json
import subprocess
from macfleet.vm import Tart, VmInfo, fullname, shortname


def fake_runner(script):
    def run(argv):
        out = script(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")
    return run


def test_name_helpers():
    assert fullname("web") == "mf-web"
    assert fullname("mf-web") == "mf-web"
    assert shortname("mf-web") == "web"


def test_list_parses_json():
    payload = json.dumps([
        {"Name": "mf-golden", "State": "stopped", "Source": "oci"},
        {"Name": "mf-a", "State": "running", "Source": "local"},
    ])
    t = Tart(run=fake_runner(lambda argv: payload))
    assert t.list() == [
        VmInfo("mf-golden", "stopped", "oci"),
        VmInfo("mf-a", "running", "local"),
    ]


def test_clone_builds_command():
    seen = []
    t = Tart(run=fake_runner(lambda argv: (seen.append(argv), "")[1]))
    t.clone("mf-golden", "mf-a")
    assert seen[-1] == ["tart", "clone", "mf-golden", "mf-a"]


def test_ip_strips_whitespace():
    t = Tart(run=fake_runner(lambda argv: "192.168.64.4\n"))
    assert t.ip("mf-a") == "192.168.64.4"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_vm.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'macfleet.vm'`

- [ ] **Step 3: Write minimal implementation**

```python
# macfleet/vm.py
from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from dataclasses import dataclass

Runner = Callable[[list[str]], "subprocess.CompletedProcess[str]"]


def _run(argv: list[str]) -> "subprocess.CompletedProcess[str]":
    proc = subprocess.run(argv, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(argv)} failed: {proc.stderr.strip()}")
    return proc


def fullname(name: str) -> str:
    return name if name.startswith("mf-") else f"mf-{name}"


def shortname(name: str) -> str:
    return name[len("mf-"):] if name.startswith("mf-") else name


@dataclass(frozen=True)
class VmInfo:
    name: str
    state: str
    source: str


class Tart:
    def __init__(self, run: Runner = _run) -> None:
        self._run = run

    def list(self) -> list[VmInfo]:
        out = self._run(["tart", "list", "--format", "json"]).stdout
        return [VmInfo(v["Name"], v["State"], v.get("Source", "")) for v in json.loads(out)]

    def clone(self, src: str, dst: str) -> None:
        self._run(["tart", "clone", src, dst])

    def start(self, name: str) -> None:
        # `tart run` blocks; callers background it (see connect.start_vm).
        self._run(["tart", "run", name, "--no-graphics"])

    def ip(self, name: str) -> str:
        return self._run(["tart", "ip", name]).stdout.strip()

    def stop(self, name: str) -> None:
        self._run(["tart", "stop", name])

    def delete(self, name: str) -> None:
        self._run(["tart", "delete", name])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_vm.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add macfleet/vm.py tests/test_vm.py
git commit -m "feat(vm): tart wrapper with injectable runner"
```

---

### Task 3: SSH/SCP command builders + `Fleet` (`connect.py`)

**Files:**
- Create: `macfleet/connect.py`
- Test: `tests/test_connect.py`

**Interfaces:**
- Consumes: `Tart`, `fullname` from `vm.py`.
- Produces:
  - `SSH_OPTS: list[str]` (the constant from Global Constraints)
  - `GUEST_USER = "admin"`, `SERVER_PORT = 8000`
  - `ssh_cmd(ip: str, remote_cmd: str) -> list[str]`
  - `scp_push_cmd(ip: str, local: str, remote: str) -> list[str]`
  - `scp_pull_cmd(ip: str, remote: str, local: str) -> list[str]`
  - `class Fleet:` `__init__(self, tart: Tart | None = None, run: Runner = _run)`, `up(self, name: str) -> None`, `down(self, name: str) -> None`, `nuke(self, name: str) -> None`, `ip(self, name: str) -> str`, `ssh(self, name: str, remote_cmd: str) -> str`, `status(self, name: str) -> bool` (computer-server `/status` reachable), `computer(self, name: str)` (lazy cua import; raises if `MACFLEET_ALLOW_CONTROL` unset)

- [ ] **Step 1: Write the failing test**

```python
# tests/test_connect.py
import subprocess
import pytest
from macfleet.connect import ssh_cmd, scp_push_cmd, Fleet, SSH_OPTS
from macfleet.vm import Tart


def fake_runner(script):
    def run(argv):
        return subprocess.CompletedProcess(argv, 0, stdout=script(argv), stderr="")
    return run


def test_ssh_cmd_shape():
    cmd = ssh_cmd("192.168.64.4", "uptime")
    assert cmd[0] == "ssh"
    assert "admin@192.168.64.4" in cmd
    assert cmd[-1] == "uptime"
    for opt in SSH_OPTS:
        assert opt in cmd


def test_scp_push_cmd_shape():
    cmd = scp_push_cmd("192.168.64.4", "a.txt", "/tmp/a.txt")
    assert cmd[0] == "scp"
    assert cmd[-2] == "a.txt"
    assert cmd[-1] == "admin@192.168.64.4:/tmp/a.txt"


def test_up_clones_golden_and_starts():
    seen = []
    fleet = Fleet(tart=Tart(run=fake_runner(lambda argv: (seen.append(argv), "")[1])),
                  run=fake_runner(lambda argv: (seen.append(argv), "")[1]))
    fleet.up("web")
    assert ["tart", "clone", "mf-golden", "mf-web"] in seen


def test_computer_blocked_without_env(monkeypatch):
    monkeypatch.delenv("MACFLEET_ALLOW_CONTROL", raising=False)
    fleet = Fleet(tart=Tart(run=fake_runner(lambda argv: "")))
    with pytest.raises(RuntimeError, match="MACFLEET_ALLOW_CONTROL"):
        fleet.computer("web")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_connect.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'macfleet.connect'`

- [ ] **Step 3: Write minimal implementation**

```python
# macfleet/connect.py
from __future__ import annotations

import os
import subprocess
import urllib.request
from typing import Any

from macfleet.vm import Runner, Tart, _run, fullname

GUEST_USER = "admin"
SERVER_PORT = 8000
SSH_OPTS = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
]


def ssh_cmd(ip: str, remote_cmd: str) -> list[str]:
    return ["ssh", *SSH_OPTS, f"{GUEST_USER}@{ip}", remote_cmd]


def scp_push_cmd(ip: str, local: str, remote: str) -> list[str]:
    return ["scp", *SSH_OPTS, local, f"{GUEST_USER}@{ip}:{remote}"]


def scp_pull_cmd(ip: str, remote: str, local: str) -> list[str]:
    return ["scp", *SSH_OPTS, f"{GUEST_USER}@{ip}:{remote}", local]


class Fleet:
    def __init__(self, tart: Tart | None = None, run: Runner = _run) -> None:
        self.tart = tart or Tart(run=run)
        self._run = run

    def up(self, name: str) -> None:
        target = fullname(name)
        existing = {v.name for v in self.tart.list()}
        if target not in existing:
            self.tart.clone("mf-golden", target)
        # background `tart run` so it doesn't block the caller
        subprocess.Popen(["tart", "run", target, "--no-graphics"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def down(self, name: str) -> None:
        self.tart.stop(fullname(name))

    def nuke(self, name: str) -> None:
        try:
            self.tart.stop(fullname(name))
        except RuntimeError:
            pass
        self.tart.delete(fullname(name))

    def ip(self, name: str) -> str:
        return self.tart.ip(fullname(name))

    def ssh(self, name: str, remote_cmd: str) -> str:
        return self._run(ssh_cmd(self.ip(name), remote_cmd)).stdout

    def status(self, name: str) -> bool:
        try:
            with urllib.request.urlopen(
                f"http://{self.ip(name)}:{SERVER_PORT}/status", timeout=4
            ) as resp:
                return b"ok" in resp.read()
        except Exception:
            return False

    def computer(self, name: str) -> Any:
        if os.environ.get("MACFLEET_ALLOW_CONTROL") != "1":
            raise RuntimeError(
                "computer-use disabled — set MACFLEET_ALLOW_CONTROL=1 (VM-only)."
            )
        from computer import Computer  # lazy: only when [control] extra installed

        return Computer(os_type="macos", host=self.ip(name), port=SERVER_PORT)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_connect.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add macfleet/connect.py tests/test_connect.py
git commit -m "feat(connect): ssh/scp builders + Fleet lifecycle"
```

---

### Task 4: Provisioning script renderer (`provision.py`)

**Files:**
- Create: `macfleet/provision.py`
- Test: `tests/test_provision.py`

**Interfaces:**
- Consumes: `Fleet`, `ssh_cmd` from `connect.py`.
- Produces:
  - `DNS_SERVERS = "1.1.1.1 8.8.8.8"`, `NET_SERVICE = "Ethernet"`
  - `render_provision_script(dns: str = DNS_SERVERS) -> str` — an idempotent bash script (string) that: sets DNS, installs `uv`, creates the cua-computer-server venv, installs a launchd plist that starts `computer_server` on `:8000` at boot, and launches it now.
  - `bake_steps() -> list[str]` — ordered human-readable checklist strings (used by the CLI to print the manual TCC step).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_provision.py
from macfleet.provision import render_provision_script, bake_steps


def test_script_sets_public_dns():
    s = render_provision_script()
    assert "networksetup -setdnsservers Ethernet 1.1.1.1 8.8.8.8" in s
    assert "killall -HUP mDNSResponder" in s


def test_script_installs_server_and_launchd():
    s = render_provision_script()
    assert "computer_server" in s
    assert "LaunchAgents" in s
    assert ":8000" in s or "--port 8000" in s


def test_script_is_idempotent_guarded():
    s = render_provision_script()
    # re-runnable: guards before install so re-bake is safe
    assert "command -v uv" in s


def test_bake_steps_mention_tcc():
    steps = bake_steps()
    assert any("TCC" in s or "Accessibility" in s for s in steps)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_provision.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'macfleet.provision'`

- [ ] **Step 3: Write minimal implementation**

```python
# macfleet/provision.py
from __future__ import annotations

DNS_SERVERS = "1.1.1.1 8.8.8.8"
NET_SERVICE = "Ethernet"

_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.macfleet.computerserver</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/admin/cs-venv/bin/python</string>
    <string>-m</string><string>computer_server</string>
    <string>--host</string><string>0.0.0.0</string>
    <string>--port</string><string>8000</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
"""


def render_provision_script(dns: str = DNS_SERVERS) -> str:
    return f"""#!/bin/bash
set -e
# 1. public DNS (NAT proxy is dead)
sudo networksetup -setdnsservers {NET_SERVICE} {dns}
sudo killall -HUP mDNSResponder || true
# 2. uv (idempotent)
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
# 3. cua-computer-server venv (idempotent)
test -d "$HOME/cs-venv" || uv venv "$HOME/cs-venv"
"$HOME/cs-venv/bin/python" -m pip install --quiet cua-computer-server
# 4. launchd unit -> server on :8000 at boot
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/com.macfleet.computerserver.plist" <<'PLIST'
{_PLIST}PLIST
launchctl unload "$HOME/Library/LaunchAgents/com.macfleet.computerserver.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.macfleet.computerserver.plist"
echo MACFLEET_PROVISIONED_OK
"""


def bake_steps() -> list[str]:
    return [
        "clone base image + boot",
        "ssh-copy-id admin@<ip>  (keyless SSH)",
        "run the provision script (DNS + computer-server + launchd)",
        "MANUAL (once, via VNC): grant Accessibility + Screen Recording (TCC) to the "
        "computer-server helper — cannot be scripted; all clones inherit it",
        "tart stop mf-golden  (snapshot template ready)",
    ]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_provision.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add macfleet/provision.py tests/test_provision.py
git commit -m "feat(provision): idempotent guest provisioning + bake checklist"
```

---

### Task 5: CLI (`cli.py`)

**Files:**
- Create: `macfleet/cli.py`
- Test: `tests/test_cli.py`

**Interfaces:**
- Consumes: `Fleet` from `connect.py`; `bake_steps`, `render_provision_script` from `provision.py`.
- Produces: `app: typer.Typer` with commands `up`, `down`, `nuke`, `ls`, `ssh`, `bake`, `serve`. `up/down/nuke/ssh` take a `name`. `serve` starts the API (Task 6). Commands accept an injected `Fleet` via a module-level `_fleet()` factory that tests monkeypatch.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_cli.py
from typer.testing import CliRunner
import macfleet.cli as cli

runner = CliRunner()


class FakeFleet:
    def __init__(self):
        self.calls = []

    def up(self, name): self.calls.append(("up", name))
    def nuke(self, name): self.calls.append(("nuke", name))


def test_up_invokes_fleet(monkeypatch):
    fake = FakeFleet()
    monkeypatch.setattr(cli, "_fleet", lambda: fake)
    result = runner.invoke(cli.app, ["up", "web"])
    assert result.exit_code == 0
    assert ("up", "web") in fake.calls


def test_bake_prints_checklist():
    result = runner.invoke(cli.app, ["bake", "--help"])
    assert result.exit_code == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_cli.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'macfleet.cli'`

- [ ] **Step 3: Write minimal implementation**

```python
# macfleet/cli.py
from __future__ import annotations

import typer

from macfleet.connect import Fleet
from macfleet.provision import bake_steps

app = typer.Typer(help="macfleet — a fleet of macOS VMs, SSH-managed + computer-use-driven")


def _fleet() -> Fleet:
    return Fleet()


@app.command()
def up(name: str) -> None:
    """Clone mf-golden -> mf-<name> and boot it."""
    _fleet().up(name)
    typer.echo(f"up: mf-{name}")


@app.command()
def down(name: str) -> None:
    """Stop mf-<name>."""
    _fleet().down(name)


@app.command()
def nuke(name: str) -> None:
    """Stop + delete mf-<name>."""
    _fleet().nuke(name)


@app.command()
def ls() -> None:
    """List fleet VMs."""
    for v in _fleet().tart.list():
        typer.echo(f"{v.state:8} {v.name}")


@app.command()
def ssh(name: str, cmd: str) -> None:
    """Run a command on mf-<name> over SSH."""
    typer.echo(_fleet().ssh(name, cmd))


@app.command()
def bake() -> None:
    """Print the golden-image bake checklist (one-time TCC step included)."""
    for i, step in enumerate(bake_steps(), 1):
        typer.echo(f"{i}. {step}")


@app.command()
def serve(port: int = 8765) -> None:
    """Start the local API for the desktop app."""
    import uvicorn

    from macfleet.api import build_app

    uvicorn.run(build_app(), host="127.0.0.1", port=port)


if __name__ == "__main__":
    app()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_cli.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add macfleet/cli.py tests/test_cli.py
git commit -m "feat(cli): typer commands up/down/nuke/ls/ssh/bake/serve"
```

---

### Task 6: Local API (`api.py`)

**Files:**
- Create: `macfleet/api.py`
- Test: `tests/test_api.py`

**Interfaces:**
- Consumes: `Fleet` from `connect.py`, `VmInfo` from `vm.py`.
- Produces: `build_app(fleet: Fleet | None = None) -> fastapi.FastAPI` with:
  - `GET /vms` → `[{"name","state","source","healthy": bool}]`
  - `POST /vms/{name}/up`, `POST /vms/{name}/down`, `POST /vms/{name}/nuke` → `{"ok": true}`
  - `GET /vms/{name}/status` → `{"healthy": bool}`
  - `POST /vms/{name}/screenshot` → `{"png_b64": str}` (guarded by control env; 409 if disabled)

- [ ] **Step 1: Write the failing test**

```python
# tests/test_api.py
from fastapi.testclient import TestClient
from macfleet.api import build_app
from macfleet.vm import VmInfo


class FakeFleet:
    def __init__(self):
        self.tart = self
        self.calls = []

    def list(self):  # stands in for tart.list()
        return [VmInfo("mf-a", "running", "local")]

    def status(self, name):
        return name == "a"

    def up(self, name):
        self.calls.append(("up", name))


def test_list_vms_marks_health():
    client = TestClient(build_app(FakeFleet()))
    r = client.get("/vms")
    assert r.status_code == 200
    body = r.json()
    assert body[0]["name"] == "mf-a"
    assert body[0]["healthy"] is True


def test_up_endpoint():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    r = client.post("/vms/web/up")
    assert r.status_code == 200
    assert ("up", "web") in fake.calls
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_api.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'macfleet.api'`

- [ ] **Step 3: Write minimal implementation**

```python
# macfleet/api.py
from __future__ import annotations

import base64

from fastapi import FastAPI, HTTPException

from macfleet.connect import Fleet
from macfleet.vm import shortname


def build_app(fleet: Fleet | None = None) -> FastAPI:
    fleet = fleet or Fleet()
    api = FastAPI(title="macfleet")

    @api.get("/vms")
    def list_vms() -> list[dict]:
        out = []
        for v in fleet.tart.list():
            out.append({
                "name": v.name, "state": v.state, "source": v.source,
                "healthy": fleet.status(shortname(v.name)) if v.state == "running" else False,
            })
        return out

    @api.post("/vms/{name}/up")
    def up(name: str) -> dict:
        fleet.up(name)
        return {"ok": True}

    @api.post("/vms/{name}/down")
    def down(name: str) -> dict:
        fleet.down(name)
        return {"ok": True}

    @api.post("/vms/{name}/nuke")
    def nuke(name: str) -> dict:
        fleet.nuke(name)
        return {"ok": True}

    @api.get("/vms/{name}/status")
    def status(name: str) -> dict:
        return {"healthy": fleet.status(name)}

    @api.post("/vms/{name}/screenshot")
    def screenshot(name: str) -> dict:
        try:
            png = fleet.computer(name).screenshot()
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"png_b64": base64.b64encode(png).decode()}

    return api
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_api.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add macfleet/api.py tests/test_api.py
git commit -m "feat(api): FastAPI fleet endpoints + guarded screenshot"
```

---

### Task 7: Demo computer-use agent (`agent.py`, optional)

**Files:**
- Create: `macfleet/agent.py`
- Test: `tests/test_agent.py`

**Interfaces:**
- Consumes: `Fleet.computer` (duck-typed: object with `screenshot()`, `click(x,y)`, `type(text)`).
- Produces:
  - `class Driver(Protocol): def next_action(self, screenshot: bytes, task: str) -> dict` (returns `{"action": "click"|"type"|"done", ...}`)
  - `run_task(computer, task: str, driver: Driver, max_steps: int = 20) -> int` — loop screenshot→driver→apply until `done` or `max_steps`; returns steps taken.
  - `AnthropicDriver` — default impl (guarded import of `anthropic`); not unit-tested here.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_agent.py
from macfleet.agent import run_task


class FakeComputer:
    def __init__(self):
        self.clicks = []

    def screenshot(self): return b"png"
    def click(self, x, y): self.clicks.append((x, y))
    def type(self, text): pass


class ScriptedDriver:
    def __init__(self, actions): self.actions = list(actions)

    def next_action(self, screenshot, task):
        return self.actions.pop(0)


def test_run_task_applies_clicks_until_done():
    comp = FakeComputer()
    driver = ScriptedDriver([
        {"action": "click", "x": 10, "y": 20},
        {"action": "done"},
    ])
    steps = run_task(comp, "open menu", driver)
    assert steps == 2
    assert comp.clicks == [(10, 20)]


def test_run_task_stops_at_max_steps():
    comp = FakeComputer()
    driver = ScriptedDriver([{"action": "click", "x": 1, "y": 1}] * 100)
    steps = run_task(comp, "spin", driver, max_steps=3)
    assert steps == 3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_agent.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'macfleet.agent'`

- [ ] **Step 3: Write minimal implementation**

```python
# macfleet/agent.py
from __future__ import annotations

from typing import Any, Protocol


class Driver(Protocol):
    def next_action(self, screenshot: bytes, task: str) -> dict[str, Any]: ...


def run_task(computer: Any, task: str, driver: Driver, max_steps: int = 20) -> int:
    for step in range(1, max_steps + 1):
        action = driver.next_action(computer.screenshot(), task)
        kind = action.get("action")
        if kind == "done":
            return step
        if kind == "click":
            computer.click(action["x"], action["y"])
        elif kind == "type":
            computer.type(action["text"])
        if step == max_steps:
            return step
    return max_steps


class AnthropicDriver:
    """Default driver: Claude computer-use. Requires the [agent] extra + ANTHROPIC_API_KEY."""

    def __init__(self, model: str = "claude-opus-4-8") -> None:
        from anthropic import Anthropic  # lazy import

        self._client = Anthropic()
        self._model = model

    def next_action(self, screenshot: bytes, task: str) -> dict[str, Any]:
        # Minimal single-turn computer-use call; expand as needed.
        raise NotImplementedError("wire Anthropic computer-use tool loop here")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_agent.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add macfleet/agent.py tests/test_agent.py
git commit -m "feat(agent): provider-neutral computer-use loop + Anthropic driver stub"
```

---

### Task 8: L0 offline integration + full suite green

**Files:**
- Create: `tests/test_integration_l0.py`
- Modify: `Makefile` (add `demo` target)

**Interfaces:**
- Consumes: `build_app` (api), `Fleet`, fakes from earlier tests.
- Produces: a single offline test that exercises list→up→status via the API against a fake tart+server, proving the wiring with no VM. `make demo` runs it.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_integration_l0.py
from fastapi.testclient import TestClient
from macfleet.api import build_app
from macfleet.connect import Fleet
from macfleet.vm import Tart
import subprocess


def scripted_tart(state):
    import json

    def run(argv):
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")
        return subprocess.CompletedProcess(argv, 0, "", "")
    return Tart(run=run)


def test_l0_list_then_up(monkeypatch):
    state = [{"Name": "mf-golden", "State": "stopped", "Source": "oci"}]
    fleet = Fleet(tart=scripted_tart(state))
    monkeypatch.setattr(fleet, "status", lambda name: False)
    # avoid launching a real `tart run` subprocess
    monkeypatch.setattr(fleet, "up", lambda name: state.append(
        {"Name": f"mf-{name}", "State": "running", "Source": "local"}))
    client = TestClient(build_app(fleet))

    assert len(client.get("/vms").json()) == 1
    assert client.post("/vms/web/up").json() == {"ok": True}
    names = [v["name"] for v in client.get("/vms").json()]
    assert "mf-web" in names
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_integration_l0.py -v`
Expected: FAIL — assertion or import error before implementation confirms wiring

- [ ] **Step 3: Add the Makefile demo target**

```makefile
demo: ; uv run pytest tests/test_integration_l0.py -v
.PHONY: demo
```

- [ ] **Step 4: Run the whole suite**

Run: `uv run pytest -q && uv run ruff check .`
Expected: PASS (all tasks' tests green), ruff clean

- [ ] **Step 5: Commit**

```bash
git add tests/test_integration_l0.py Makefile
git commit -m "test(l0): offline list->up->list integration + make demo"
```

---

### Task 9: VM verification ladder (L1–L3) + README

**Files:**
- Create: `scripts/bake.sh`
- Create: `README.md`

**Interfaces:**
- Consumes: the CLI + provision renderer. These steps need real hardware (Apple-silicon + tart) and are run manually — they are verification, not unit tests.

- [ ] **Step 1: Write `scripts/bake.sh` (host-side golden bake)**

```bash
#!/usr/bin/env bash
# Bake mf-golden from the base image. Requires: tart, host SSH key.
set -euo pipefail
BASE="ghcr.io/cirruslabs/macos-tahoe-base:latest"
tart clone "$BASE" mf-golden
tart run mf-golden --no-graphics & sleep 40
IP="$(tart ip mf-golden)"
ssh-copy-id "admin@$IP"
uv run python -c "from macfleet.provision import render_provision_script as r; print(r())" \
  | ssh admin@"$IP" 'bash -s'
echo ">> Now grant Accessibility + Screen Recording via VNC (one time), then:"
echo ">>   tart stop mf-golden"
```

- [ ] **Step 2: L1 — verify tart reachable**

Run: `tart list`
Expected: shows `mf-golden` after bake.

- [ ] **Step 3: L2 — verify up + SSH**

Run: `uv run macfleet up web && uv run macfleet ssh web "sw_vers -productVersion"`
Expected: prints the guest macOS version (e.g. `26.5`).

- [ ] **Step 4: L3 — verify computer-use control**

Run: `MACFLEET_ALLOW_CONTROL=1 uv run python -c "from macfleet.connect import Fleet; print(len(Fleet().computer('web').screenshot()))"`
Expected: prints a nonzero byte count (a PNG frame) — proves TCC granted.

- [ ] **Step 5: Write README + commit**

Write `README.md` covering: prerequisites, `make setup`, `scripts/bake.sh`, `macfleet up/ssh/ls/nuke`, `macfleet serve`, the `MACFLEET_ALLOW_CONTROL` safety gate, and the L0–L3 ladder.

```bash
git add scripts/bake.sh README.md
git commit -m "docs: bake script + README with L0-L3 ladder"
```

---

## Self-Review

**Spec coverage:**
- Fleet lifecycle → Tasks 2,3,5. Golden bake + fallback → Tasks 4,9 (`Fleet.up` clones golden). SSH mgmt → Task 3,5. Computer-use control → Tasks 3,6 (`computer()`, screenshot). Local API for GUI → Task 6. Demo agent → Task 7. Test ladder L0–L3 → Tasks 8,9. Error handling (control gate, health) → Tasks 3,6. DNS/TCC provisioning → Task 4.
- Not in this plan (by scope): the Tauri app + tray, WS screenshot/log *streaming*, `push`/`pull` CLI subcommands, `meta.json` labels. These land in **Plan 2 (Tauri app)** and a small engine follow-up; the API/WS streaming is added when the GUI needs it. Noted so it isn't mistaken for a gap.

**Placeholder scan:** `AnthropicDriver.next_action` raises `NotImplementedError` by design (optional, out-of-scope for offline tests) — flagged, not a hidden placeholder. No other TBDs.

**Type consistency:** `Runner`, `VmInfo`, `fullname`/`shortname` defined in Task 2 and reused consistently in Tasks 3,6,8. `Fleet` method names (`up/down/nuke/ip/ssh/status/computer`) match across Tasks 3,5,6. `build_app(fleet)` signature matches Tasks 5,6,8. `run_task(computer, task, driver, max_steps)` consistent in Task 7.
