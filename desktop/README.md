# macfleet desktop

A Tauri GUI client for `macfleet serve`, the engine's local API. Layout A: a
fleet sidebar (VM list, health dots, up-form) on the left, a VM detail pane
(live screenshot, click-through, type) on the right, with a log tail below it.
Runs as a menu-bar app — closing the window keeps it in the tray; use the
tray menu to show the window again or quit.

## Prerequisites

- The engine set up per the [root README](../README.md): `tart`, `uv`, and a
  baked `mf-golden` image.
- [`bun`](https://bun.sh/).
- [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/) (Rust
  toolchain + platform webview deps) for your OS.

## Setup

```bash
bun install
```

## Development

```bash
bun run tauri dev
```

This spawns the engine (`uv run macfleet serve --port 8765`) as a managed
sidecar process automatically — no separate `macfleet serve` needed.

## Computer-use control

Screenshot polling, click-through, and typing into a VM require
`MACFLEET_ALLOW_CONTROL=1` in the engine's environment and a reachable VM.
Without both, the detail pane shows a disabled hint
("no screenshot (control disabled or VM not ready)") instead of the live
screenshot.

## Testing

```bash
bun run test:unit   # Vitest
bun run test:e2e    # Playwright, against a mocked API — no engine/VM needed
```

## Status

Dev-run only for now (`bun run tauri dev`). A bundled `.app` with the engine
packaged as a PyInstaller sidecar is a later follow-up.
