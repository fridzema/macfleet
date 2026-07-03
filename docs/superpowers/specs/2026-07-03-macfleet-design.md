# macfleet — design

Date: 2026-07-03
Status: approved design (layout + architecture), pending written-spec review

## Summary

`macfleet` spins up disposable **macOS VMs as a fleet** on an Apple-silicon host,
manages them over **SSH**, and drives them with **computer use** (trycua's
`cua-computer-server`). It ships two things over one shared Python core:

1. a **Python CLI + local API** (`macfleet`) — the engine, and
2. a small **Tauri desktop app** (scaffolded from `oxide-dock`) — a GUI client with a
   fleet view, per-VM control/screenshot/logs, and a menu-bar tray.

It is a lean generalization of the tart+cua path proven in `dtp-automation-harness`:
tart for the VM layer, `cua-computer-server` in-guest for control, golden-image
cloning for fast spin-up. All prepress/preflight/model-loop specifics are dropped.

## Goals

- Spin up N named macOS VMs in parallel, each SSH- and computer-use-addressable.
- Fast spin-up via a **golden image**: provision once, clone per VM in seconds.
- One Python brain for both CLI and GUI (no logic duplication).
- A small desktop app to manage the fleet and do basic actions: start/stop/clone/nuke,
  live screenshot + click/type control, log tailing, ad-hoc SSH.
- An optional demo computer-use agent to prove end-to-end control.

## Non-goals (v1)

- Cross-host / networked fleet orchestration, a daemon, or a shared team service.
- Full remote-desktop fidelity (VNC replacement). Screenshot + basic input only.
- Windows/Linux guests (Apple VZ, Apple-silicon-only).
- Distributable signed `.app` bundling of the Python engine (deferred follow-up).
- Baking specific applications into the image (documented recipe, not built-in).

## Prerequisites

- Apple-silicon Mac (Apple Virtualization.framework).
- `tart` (`brew install cirruslabs/cli/tart`).
- Python 3.12+ with `uv`; Rust stable + Bun (for the Tauri app, from oxide-dock).
- Network: NAT (192.168.64.x). NAT DNS proxy is dead — provisioning sets public
  resolvers in-guest (`networksetup -setdnsservers Ethernet 1.1.1.1 8.8.8.8`).

## Architecture

```
+---------------------------- host (macOS, Apple silicon) ----------------------------+
|                                                                                     |
|  Tauri app (oxide-dock)          macfleet CLI                                        |
|   Vue3 UI + tray  ── HTTP/WS ──►  macfleet serve  ◄── same core ── macfleet <cmd>    |
|   (Rust shell spawns the                │                                            |
|    serve sidecar)                        │  vm.py / provision.py / connect.py / agent │
|                                          ▼                                            |
|                         tart (clone/run/ip/stop/delete)                              |
|                         ssh / scp                                                    |
+──────────────────────────────────────┬──────────────────────────────────────────────+
                                        │ SSH (mgmt, file xfer, log tail)
                                        │ WS/HTTP :8000 (computer-server: screenshot/click/type)
                                        ▼
                        macOS guest VM (cloned from golden)
                          - cua-computer-server on :8000 (launchd, boot)
                          - keyless SSH, public DNS, TCC granted (baked)
```

Single source of truth for VM state is `tart list` (no separate registry). An optional
`~/.macfleet/meta.json` holds only cosmetic labels/notes.

## Components

### Python engine (`macfleet/`)

- **`vm.py`** — tart wrapper. `clone/run/ip/stop/delete/list`, wait-for-ssh with backoff.
  Naming convention `mf-<name>`; the golden template is `mf-golden`.
- **`provision.py`** — golden-image bake + fallback per-boot provisioning. Idempotent
  SSH steps: inject host pubkey, DNS fix, install `uv` + `cua-computer-server` venv,
  install a launchd plist to start the server on `:8000` at boot. **TCC grant
  (Accessibility + Screen Recording) is a one-time manual VNC step before snapshot** —
  cannot be scripted without SIP-off/MDM; all clones inherit it.
- **`connect.py`** — `Fleet` / `VM` classes. `vm.ssh()`, `vm.push()/pull()` (scp),
  `vm.computer()` → trycua `Computer` bound to `ws://<ip>:8000/ws`. Health via `/status`.
- **`agent.py`** — optional demo computer-use loop (screenshot → Claude → action).
  Behind a `Driver` interface; default impl = Anthropic computer-use API. Extra `[agent]`.
- **`api.py`** — FastAPI on `127.0.0.1:PORT`. JSON endpoints mirror the CLI ops; WS
  endpoints stream screenshots (poll ~1–2 fps, pausable) and log tails. This is what the
  GUI talks to; the CLI calls the same functions directly.
- **`cli.py`** — `bake · up · list · ssh · push · pull · down · nuke · ctl · serve`.

### Tauri app (from `oxide-dock`)

- **Rust shell** — spawns and supervises `macfleet serve` as a sidecar; window + tray.
- **Vue 3 frontend** — **layout A (sidebar + detail)**:
  - left: fleet list (name, state, IP, `:8000` health dot) + `up` / `bake` actions;
  - right (selected VM): live screenshot (click on image → click; type box → keys),
    log pane (computer-server log + `log stream` over SSH), ad-hoc SSH command box,
    action buttons (type, ssh cmd, `ctl` run-task, nuke).
  - **System tray = menu-bar mode**: running count, health dots, latest thumbnail,
    quick start/stop, "open dashboard".
- Reuses oxide-dock's Vite/Pinia/VueUse/Vitest/Playwright/ESLint/CI/Makefile.

## Control paths (two, like the source repo)

1. **SSH-first** — management, file transfer, log tailing, arbitrary commands. Always available.
2. **computer-use** — pixel control via `cua-computer-server` (`vm.computer()`), needs the
   baked TCC grant. Used by the detail-pane screenshot/click/type and by the demo agent.

## Data flow (a control action from the GUI)

1. User clicks on the screenshot in the Tauri detail pane.
2. Vue → `POST /vm/{name}/click {x,y}` on `macfleet serve`.
3. `api.py` → `connect.VM.computer().click(x,y)` → WS to guest `:8000`.
4. Next screenshot poll returns the updated frame over the WS stream.

## Golden-image workflow

- `macfleet bake` — clone `ghcr.io/cirruslabs/macos-tahoe-base:latest` → boot → run the
  idempotent provisioner → (manual TCC grant via VNC, prompted) → `tart stop` → the VM is
  the `mf-golden` template.
- `macfleet up <name>` — `tart clone mf-golden mf-<name>` + `tart run` + wait-for-ssh.
  If `mf-golden` is missing, fall back to cloning the stock image and provisioning inline
  (slower, and TCC pixel control unavailable until baked).

## Error handling

- Preflight: Apple-silicon check, `tart` present, `mf-golden` exists (warn + offer bake).
- Boot/SSH: retry with backoff (~30s boot); surface a clear timeout.
- DNS/egress verify after provisioning (`curl -sI https://pypi.org`).
- Health dot = `/status` poll; red on failure.
- Screenshot failure → explicit "TCC not granted — re-bake golden" message (the known trap).
- API returns structured errors; GUI shows a toast.

## Testing (ladder mirrors dtp-automation-harness L0–L3)

- **Python unit** — CLI arg parsing, provisioner step rendering, meta store; subprocess/tart
  mocked. FastAPI via `TestClient`.
- **L0 offline** — fake tart + fake computer-server: CLI + API flows green, no VM.
- **L1 bake** — `bake` produces `mf-golden`.
- **L2 up+ssh** — `up` then `ssh` reachable; DNS/egress verified.
- **L3 control** — `vm.computer().screenshot()` returns a frame (TCC proof).
- **Tauri** — Vitest component tests + Playwright e2e against a mock API (both in oxide-dock).

## Packaging

- v1 dev: `make dev` runs the Tauri app + `macfleet serve` from the venv.
- Deferred: bundle `macfleet` as a PyInstaller Tauri sidecar inside the signed `.app`.

## Open follow-ups (not v1)

- Detail-pane extras: resource stats (CPU/mem via SSH), file push/pull drop zone,
  per-VM "bake from this VM".
- App-specific golden images (documented recipe).
- Provider-neutral agent drivers beyond Anthropic.
- Git remote (local-only for now).

## Decisions locked during brainstorming

- Fleet, many concurrent (not single-disposable, not long-lived+reset).
- Computer use = `cua-computer-server` plumbing **plus** an optional demo agent.
- Python CLI package as the engine; Tauri (oxide-dock) app as GUI client; tray = same app.
- Golden-image bake + `up` clone, with vanilla-provision fallback.
- Main window: layout A (sidebar + detail).
- Defaults: ~1–2 fps pausable screenshot polling; generic base image.
