# macfleet — interface design brief (Claude prompt)

Paste the block below into Claude to generate an interactive prototype of the macfleet
interface. It covers the shipped desktop UI plus the new engine/MCP capabilities not yet
surfaced (snapshots, suspend/resume, rename, duplicate, resources, connection-info,
terminal/exec, TTL leases, agent activity). Written to translate to the real
Tauri v2 + Vue 3 + Tailwind v4 app.

---

# ROLE
You are a world-class product designer and front-end engineer with a Linear / Raycast /
Orbstack pedigree. Design AND build a high-fidelity, interactive, clickable prototype of
the **macfleet** desktop app. Output it as a single self-contained artifact.

# WHAT MACFLEET IS
macfleet spins up and controls a fleet of disposable macOS VMs on one Apple-silicon Mac —
for humans AND AI agents. You clone ready-to-go VMs from a golden image or from *stateful
snapshots* (resume to a running state in ~1–2s, no boot), drive them (live screen, click,
type, shell), snapshot them, and throw them away. Think "Orbstack for throwaway macOS
test VMs" — usable by hand, or by an AI agent over an MCP server. Speed and disposability
are the whole point.

# WHO IT'S FOR — design for all three at once
- **Developers**: speed, clear state, keyboard control, copy-paste connection details.
- **Hackers / power users**: terminal aesthetic, density, a command palette, monospace,
  keyboard-first everything.
- **"Normal" people**: approachable and obvious — clear labels, guided flows, no jargon
  wall, sensible defaults, advanced options tucked behind progressive disclosure.
The craft is ONE interface that feels powerful to a hacker and calm to a newcomer: dense
where it helps, quiet where it doesn't. Nothing about it should feel intimidating, and
nothing should feel dumbed-down.

# VISUAL DIRECTION
Modern, premium, a little bit hacker. Baseline is a "sleek dark console," elevated:
- Dark neutral canvas (near-black / zinc) as the primary, with a first-class, system-
  native LIGHT mode (airy, clean). A theme toggle in the header; both must look intentional.
- One confident accent: **emerald** = healthy / primary; **amber** = booting / warning;
  **red** = destructive; **zinc/grey** = idle. Use color sparingly and meaningfully.
- **Monospace** for machine things (VM names, IPs, logs, shell, resource values); a clean
  sans for UI chrome. Tabular numbers everywhere numbers change.
- Subtle 1px borders, soft shadows, rounded-lg cards, tight-but-breathing spacing.
- Status = color + motion: solid green = running, amber pulse = booting, grey = stopped,
  spinner = creating, dim = suspended. A soft glow on the currently-live VM.
- Micro-interactions: smooth transitions, hover states, skeleton loaders, toasts. The live
  VM screenshot is the HERO — framed, crisp, the centerpiece of the detail view.
- Quality bar: Linear, Raycast, Vercel, Orbstack, Warp. Screenshot-worthy. Never templated.

# THE FULL INTERFACE — include ALL of it

## App shell
- Top header: macfleet wordmark/mark; a ⌘K command-palette trigger with a visible hint;
  a global search; an **agent activity** indicator (e.g. "2 AI agents connected" with a
  live pulse and a popover of recent agent actions); a host-capacity readout (e.g. "fleet:
  3 VMs · 12 GB / 32 GB"); a light/dark toggle. Slim, fixed height, no page scroll.
- Full-height layout, no overflow: left sidebar | main detail pane.

## Left sidebar
- **FLEET** section: one row per VM — status dot, mono short name, state label, and (if the
  VM has a TTL lease) a small countdown chip ("expires 4m"). Active row highlighted. Live-
  updating. A newly-created VM appears instantly as a "creating…" row with a spinner.
- **SNAPSHOTS** section: one row per snapshot — label, source VM, size, age; each row has a
  "New VM from this" affordance (the fast path).
- **Create** control pinned at the bottom: name input + primary "Spin up" button; expandable
  advanced options — source (Golden image | a snapshot), optional TTL (auto-delete), an
  optional resource preset (CPU/RAM). Micro-copy that sells the speed ("resumes in ~2s").

## Main detail pane (a VM is selected)
- Header: mono VM name; a status badge; resource chips (e.g. "4 vCPU · 8 GB · 50 GB");
  and an action cluster: **suspend/resume**, **snapshot**, **duplicate**, **rename**
  (inline edit), **connect**, and **delete** (destructive, red, two-step inline confirm —
  no blocking dialogs).
- Tabbed body:
  1. **Screen** — the live VM screenshot as a framed hero; click anywhere to move/click the
     VM cursor; a "type into VM" input; a pause toggle; a fullscreen button. Show graceful
     states: "booting — waiting for guest", "stopped", "control disabled".
  2. **Terminal** — an in-guest shell (runs commands via the guest agent, no SSH keys):
     command input + monospace scrollback with exit codes.
  3. **Logs** — a live streaming tail of the guest log, monospace.
  4. **Resources** — current CPU / memory / disk / display; editable when the VM is
     **stopped** (with a clear "stop the VM to change resources" hint when running; note
     disk can only grow).
  5. **Connect** — the per-VM "how to connect" bundle: IP, an `ssh admin@<ip>` command, a
     VNC/screen-sharing command, and the guest server URL — each with a one-click **copy**
     button and a note that in-guest `exec` is available.
- Empty state (nothing selected): calm "Select a VM to view it", or, if the fleet is empty,
  "No VMs yet — spin one up to get started" with a prominent create affordance.

## Overlays & flows
- **Command palette (⌘K)**: every action reachable and searchable — spin up, new-from-
  snapshot, snapshot, suspend/resume, rename, duplicate, resize, connect, open terminal,
  delete, switch VM, toggle theme. Keyboard-first, fuzzy search, recent actions.
- **Create-VM flow**: from Golden or from a snapshot; optional TTL; optional resources.
- **Snapshot flow**: name/label prompt; show the "freezing state…" moment.
- Toasts for async results; optimistic UI on create; destructive actions confirm inline.

## States to demonstrate (make them real, with mock data)
running · booting (amber pulse) · stopped · suspended · creating (spinner) · leased with a
live TTL countdown · unhealthy/error · control-disabled. Show a fleet of several VMs across
these states, plus at least two snapshots.

# INTERACTIONS & RULES
- Keyboard shortcuts throughout, with discreet hints; ⌘K everywhere.
- Copy-to-clipboard on every connection detail (with a copied ✓ confirmation).
- Every list/panel has loading, empty, error, and populated states.
- Destructive = red + inline two-step confirm, never a modal dialog.
- Respect reduced motion; keep animation purposeful.

# CONSTRAINTS
- The production app is **Tauri v2 + Vue 3 + Tailwind v4** — design so it translates
  cleanly, but deliver the prototype as a SINGLE self-contained artifact (HTML with inline
  CSS/JS, or a single React file), no external assets/CDNs/fonts, works fully offline, uses
  realistic mock data and a convincing placeholder for the live VM "screen".
- Responsive to window resizing; the body never scrolls horizontally.
- Both dark and light themes must be first-class; header toggle switches them.
- Accessible: keyboard-navigable, visible focus rings, adequate contrast in both themes.

# DELIVERABLE
First, briefly state your design approach: the layout, how you reconcile hacker-density
with newcomer-clarity, and your color + type system. Then build the full interactive
prototype as one artifact. Make it feel alive — a selected running VM showing its live
"screen", the terminal and logs streaming, the snapshot browser, the create flow, the
command palette, and the agent-activity indicator all present and interactive. This should
be something a developer would screenshot and share.
