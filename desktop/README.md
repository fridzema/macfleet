# macfleet desktop

A Tauri GUI client for `macfleet serve`, the engine's local API. Layout A: a
fleet sidebar (VM list, health dots, up-form) on the left, a VM detail pane
(live screenshot, click-through, type) on the right, with a log tail below it.
Runs as a menu-bar app — closing the window keeps it in the tray; use the
tray menu to show the window again or quit.

## Prerequisites

- The engine set up per the [root README](../README.md): `tart`, `uv` for development, and a
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

This spawns the engine (`uv run --frozen macfleet serve`) as a managed
sidecar process automatically — no separate `macfleet serve` needed.

`bun run dev` alone serves the frontend in a browser instead. There is no Tauri host there to
hand it the engine's per-run token, so point it at a running `macfleet serve` with
`VITE_MACFLEET_TOKEN` (the token that command prints on startup) and, if it is not on
`127.0.0.1:8765`, `VITE_MACFLEET_API_BASE`. See `.env.example`.

## Menu bar

The app lives in the menu bar. Closing the window hides it — the VMs keep
running and the tray stays up; **Show macfleet** brings the window back. Quit
(the tray's **Quit** or `⌘Q`) is the only exit, and it suspends the fleet on
the way out.

The tray menu lists the fleet with a status dot per VM (`●` running, `◐`
booting, `○` stopped or suspended). Each VM's submenu offers Connect VNC/SSH
and Copy IP address (enabled once the guest is healthy), Restart, Suspend,
Stop, Resume, Show in app, and a confirm-gated Delete. Below the VMs sit New
VM, Suspend all, Settings…, Doctor…, Show macfleet, and Quit.

The tray is driven by a Rust-side poll of the engine's `/vms` every 2s, not by
the window: the webview's fleet stream is route-scoped and pauses when the
window is hidden, which is exactly when the tray needs the data. Lifecycle and
connect actions run in Rust over HTTP; only the items that surface the window
are handed to the webview.

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

## Bundles

`bun run tauri build` first creates an unpacked standalone engine with pinned
PyInstaller 6.21.0, then bundles it under the app's resources. The target Mac needs
`tart`, but not Python or `uv`. Source and development runs keep the `uv` fallback.
