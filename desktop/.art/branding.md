# macfleet Brand Tokens

## Core Positioning

- Name: `macfleet`
- Story: a fleet of disposable macOS VMs on one Apple-silicon host — cloned from a single
  golden image, driven over SSH or by a computer-use agent, thrown away when done.
- Personality: precise, quiet, fast, operator-grade.
- Promise: a whole fleet of clean macs, a few seconds away.

## Taglines

- Primary: `A fleet of throwaway macs.`
- Alternative: `Clone. Drive. Discard.`
- Alternative: `Disposable macOS, on tap.`

## Product Description

- Short: `macfleet spins up and controls a fleet of macOS VMs on a single Apple-silicon host.`
- Extended: `macfleet clones N named VMs from one provisioned golden image, manages them over
  SSH, and hands any of them to a computer-use agent. A Python engine (CLI + local API + MCP
  server) and a Tauri desktop app share the same core.`

## Mark

The app icon is a stacked-window glyph: two ghost cards behind one solid front card carrying a
status dot — a fleet of machines, one of them live. The header redraws the same glyph at 26px
(`desktop/src/components/AppHeader.vue`); the ghost cards use `currentColor` so they invert with
the theme, while the front card keeps the violet identity and its emerald status dot.

- Master: `desktop/.art/icon.af` (Affinity), exported to `icon.svg` / `icon.png`
- Bundle icons: regenerate with `make icons` (drives `tauri icon` + the tray renderer)
- Tray: monochrome macOS template image — no color, the system tints it

## Color Tokens

`desktop/src/style.css` is the source of truth; the app is dark-first with a light override.
The identity colors are the violet mark accent and the emerald "running" dot.

```css
:root {
  --bg: #09090b;
  --bg-elev: #0e0e11;
  --text: #e7e7ea;
  --text-dim: #a0a0a8;
  --violet: #8b8bf5; /* brand accent */
  --emerald: #10b981; /* running */
  --amber: #f59e0b; /* transitional */
  --red: #f0555a; /* failed */
}
```

## Typography Tokens

- UI: the macOS system stack (`-apple-system`, `BlinkMacSystemFont`)
- Mono: `ui-monospace`, `SF Mono`, `JetBrains Mono` — used for VM names, IDs, and command output

## Voice Guidelines

- Tone: terse, concrete, no marketing.
- Say what a command does and what it costs (time, disk, a re-bake).
- Preferred language: "resumes in ~2s" over "blazing fast."
