# macfleet

A fleet of disposable macOS VMs on a single Apple-silicon host, managed over SSH and
driven with computer use ([trycua](https://github.com/trycua)'s `cua-computer-server`).
Spin up N named VMs cloned from one provisioned golden image, SSH in for scripted
work, or hand a VM to a computer-use agent to click/type through a GUI. It ships as a
Python engine (CLI + local API + MCP server) and a Tauri desktop app (fleet view, live
screen, per-VM terminal/logs/resources) built on the same core. Run it with `make dev`;
a local desktop build includes a self-contained engine executable and needs only `tart` at
runtime.

## Prerequisites

- Apple-silicon Mac (uses Apple's Virtualization.framework via `tart`).
- [`tart`](https://github.com/cirruslabs/tart): `brew install cirruslabs/cli/tart`
- [`uv`](https://github.com/astral-sh/uv) for Python dependency management.

## Install

Releases are published as source on GitHub only. There is no PyPI package or prebuilt desktop
download: the app is not code-signed or notarized, so both halves are built from a clone:

```bash
git clone https://github.com/fridzema/macfleet.git
cd macfleet
make setup            # engine venv + desktop deps
scripts/bake.sh       # one-time golden image (see below)
```

That is everything the CLI, the API, and the MCP server need — drive them with `uv run
macfleet …` from the clone, or `uv tool install .` to put `macfleet` on your PATH.

For the desktop app, `make dev` runs it from source, and `make build` produces a bundle under
`desktop/src-tauri/target/release/bundle/` (a `.app` and a `.dmg`) with the engine embedded as
a self-contained executable — that machine then needs only `tart`, not Python or `uv`. Because
the bundle is unsigned, macOS Gatekeeper blocks it on first launch: right-click the app and
choose **Open**, or clear the quarantine attribute yourself.

## Setup

```bash
make setup   # engine venv (uv sync) + desktop deps (bun, Playwright, hooks)
```

Engine-only: `make setup-engine`. Desktop-only: `make setup-desktop`.

## Common tasks

`make` (or `make help`) lists all targets. The top-level ones cover both the engine
and the desktop app:

```bash
make dev      # run the desktop app (Tauri window; auto-spawns the engine API sidecar)
make serve    # run the engine API only (:8765)
make mcp      # run the stdio MCP server
make build    # build the desktop app bundle
make test     # all unit tests (engine pytest + desktop vitest)
make lint     # lint everything (ruff + eslint/biome/clippy)
make format   # format everything (ruff + biome/cargo fmt)
```

Scoped variants exist for one half — `make test-engine` / `make test-desktop`,
`make lint-engine` / `make lint-desktop`, etc. The whole-project aggregates need both
halves installed; use the scoped targets to run just one. `make e2e` runs the desktop
Playwright suite (mocked API, no VM needed).

## Baking the golden image

VMs are cloned from a single provisioned image, `mf-golden`, so per-VM boot is fast.
Bake it once per host:

```bash
scripts/bake.sh
```

This clones the base image, boots it, copies your SSH key in, and runs the guest
provisioning (public DNS, authenticated `cua-computer-server` gateway, launchd, and
TCC grants). After verification it warm-suspends the golden image automatically, so
new VMs resume from its saved state instead of cold-booting macOS. When the host's
Virtualization framework refuses a restore, the engine cold-boots instead and records a
`coldboot-fallback` entry in the activity feed.

## CLI usage

```bash
uv run macfleet up web              # clone mf-golden -> mf-web and boot it
uv run macfleet up web --preset heavy # 8cpu/16GB instead of the configured default
uv run macfleet ssh web "uname -a"  # run a command on mf-web over SSH
uv run macfleet ls                  # list fleet VMs and their state
uv run macfleet down web            # stop mf-web
uv run macfleet nuke web            # stop + delete mf-web
uv run macfleet reset               # delete every fleet VM, snapshot, and state file (keeps mf-golden)
uv run macfleet reset --all         # also delete mf-golden and reset settings — forces a re-bake
uv run macfleet bake                # print the golden-image bake checklist
uv run macfleet serve               # start the local API (desktop app and integrations)

uv run macfleet suspend web         # freeze mf-web's running state
uv run macfleet resume web          # resume a suspended mf-web
uv run macfleet snapshot web clean  # snapshot mf-web, prints the snapshot id "web-clean"
uv run macfleet snapshots           # list snapshots
uv run macfleet clone web-clean web2 # create mf-web2 from a snapshot (resumes captured state)
uv run macfleet rename web web3     # rename mf-web to mf-web3
uv run macfleet duplicate web3 web4 # duplicate mf-web3 to mf-web4
uv run macfleet exec web "sw_vers"  # run a shell command in mf-web via the guest agent
uv run macfleet connect web         # print how to connect to mf-web
uv run macfleet reap                # delete VMs whose TTL lease has expired
```

`up` returns as soon as `tart run` is launched — it does not wait for SSH to come up.
A normally baked, warm-suspended golden image resumes in a few seconds. A cold or
manually stopped image can still take roughly 30 seconds, so immediate SSH includes retries.

## Snapshots & fast spin-up

Snapshots (`mfsnap-<vm>-<label>`) are stateful clones — captured while the source VM
is suspended so a resumed clone picks up right where the source left off, not from a
cold boot. `macfleet snapshot <name> <label>` captures one; `macfleet clone
<snapshot-id> <name>` spins up a new VM from it. If a VM can't suspend cleanly,
`snapshot`/`duplicate` fall back to stop-then-clone (a clean-disk copy instead of a
resumed one). `macfleet up`/`create` also accept a TTL lease so short-lived VMs are
reaped automatically instead of accumulating. Reaping is lazy (`list_vms()` sweeps on
every call) with `macfleet serve` additionally running it on a 60s interval as a
backstop, and `macfleet reap` / `POST /reap` trigger a sweep on demand.

## Config, doctor & reset

`macfleet up`'s VM size (cpu + RAM only) comes from one of three engine-owned
presets stored in `~/.macfleet/config.json`: `light` (2cpu/4GB), `standard`
(4cpu/8GB, the default), `heavy` (8cpu/16GB). `--preset` overrides the configured
default for one VM. Disk is deliberately not a preset field — `tart set --disk-size`
is grow-only and `mf-golden` already ships an ~80GB disk. `macfleet reset [--all]`
deletes every fleet VM, snapshot, and state file after a confirmation prompt, and
exits non-zero if any VM fails to delete; plain `reset` keeps `mf-golden`, `--all`
also deletes it and resets settings, so golden needs a full re-bake afterwards.

The API additionally serves `GET`/`PUT /config`, `GET /doctor` (eight on-demand
checks — architecture, `tart` installed, golden image present/warm, screen recording
permission, leaked temporary VMs, stale leases, disk space — diagnosis only, it
repairs nothing), and `POST /data/reset` (same semantics as `macfleet reset`).

## Files

macfleet keeps its state under `~/.macfleet/`:

- `config.json` — settings (`default_preset`)
- `state.json` — TTL leases + suspended set
- `shares.json` — per-VM shared folders
- `activity.jsonl` — agent activity ring buffer
- `engine.log`, `engine.log.1` — the desktop app's engine sidecar output, current
  and previous run (rotated on each launch)
- `operations/` — per-VM flock files

## Computer-use safety gate

Computer-use control (screenshot/click/type via `Fleet.computer()`) is disabled by
default. It requires `MACFLEET_ALLOW_CONTROL=1` in the environment, and it only ever
targets fleet VMs over their guest IP — never the host. The privileged guest `/cmd`
gateway also requires a boot-rotated token that the engine retrieves over SSH, so direct
HTTP calls cannot bypass the host-side gate. Without the flag, `Fleet.computer()` raises.

## Security model

macfleet is a single-user tool for a host you own. It assumes the operator is trusted, and
it draws exactly one hard boundary: the **host** is protected from the fleet, and the fleet is
not protected from anything.

What is defended:

- **The local API.** `macfleet serve` binds `127.0.0.1` and always requires a token — a random
  one is generated when `MACFLEET_API_TOKEN` is unset or empty, and the desktop app passes its
  own per-run token on an ephemeral port. Every route needs it, reads included, because `GET
  /vms` reaps expired VMs and `POST /vms/{name}/exec` runs guest commands. Otherwise any
  local page or process could drive the fleet.
- **Computer-use.** Disabled unless `MACFLEET_ALLOW_CONTROL=1`, and it only ever targets a
  fleet VM's guest IP, never the host. The guest's privileged `/cmd` gateway additionally
  requires a token that rotates on every boot and is stored 0600, retrieved by the engine over
  SSH — so direct HTTP to a guest cannot bypass the host-side gate.
- **The host's own VMs.** Every destructive operation is namespaced to `mf-`/`mfsnap-`
  prefixes, `mf-golden` is protected from mutation, and VM names and snapshot labels are
  validated before they reach `tart`. Shell-outs use argument vectors — never a shell — with
  bounded runtime and bounded captured output.
- **The supply chain.** The golden base image is digest-pinned in `scripts/bake.sh`; CI audits
  Python, JS, and Rust dependencies on every push.

What is deliberately *not* defended — treat a fleet VM as disposable, never as a sandbox:

- **Guests run with SIP disabled** (the base image ships that way) and macfleet seeds TCC
  grants for Screen Recording, Accessibility, and PostEvent directly into the system TCC
  database, so the headless helper can capture the screen with no manual step. Every clone
  inherits those grants.
- **The guest gateway listens on `0.0.0.0:8000`** inside the VM. It is token-authenticated,
  but it is reachable from anything that can route to the guest on tart's network.
- **The guest account is `admin`** with the base image's default password, plus your SSH
  public key copied in during the bake.
- **Anything a guest can reach, guest code can reach** — including any host folder you share
  into it (mounted read-only unless you ask otherwise).

Do not put secrets in a fleet VM, and do not run untrusted code in one unless you accept that
it can do anything a local user with SIP off can do.

## MCP server (for AI agents)

Expose the fleet to an AI agent:

```bash
claude mcp add macfleet -e MACFLEET_AGENT=claude-code -- uv run --extra mcp macfleet-mcp
```

Tools cover the full loop: list/create (incl. `from_snapshot`, `ttl_seconds`),
up/down/suspend/resume/delete, snapshot/list_snapshots/create_from_snapshot,
rename/duplicate, get/set_resources, get_connection, exec, and — when
`MACFLEET_ALLOW_CONTROL=1` — screenshot/click/type/key.

## Verification ladder (L0-L3)

- **L0 — offline, no hardware.** Unit + integration tests against injectable
  fakes (no real `tart`/SSH). Run with `make test-engine` or `make demo`
  (`tests/test_integration_l0.py`, a scripted list -> up -> list flow through the API).
- **L1 — tart reachable.** After `scripts/bake.sh`, run `tart list` and confirm
  `mf-golden` is listed.
- **L2 — up + SSH.** `uv run macfleet up web && uv run macfleet ssh web "sw_vers -productVersion"`
  should print the guest macOS version.
- **L2 — snapshot round-trip.** `uv run macfleet snapshot web ready && uv run macfleet clone
  web-ready web-copy` should resume `web-copy` into the captured state (confirm with a
  screenshot or `uv run macfleet exec web-copy "uptime"`).
- **L2 — exec.** `uv run macfleet exec web "sw_vers"` should print the guest's `sw_vers`
  output.
- **L3 — computer-use control.** With the golden image's TCC grant in place:
  `MACFLEET_ALLOW_CONTROL=1 uv run python -c "from macfleet.connect import Fleet; print(len(Fleet().computer('web').screenshot()))"`
  should print a nonzero byte count (a PNG frame).
- **L3 — MCP end-to-end.** With the server registered (see above), from an agent:
  `list_vms` -> `create_from_snapshot` -> `exec` -> `screenshot` -> `delete_vm`.

L1-L3 require an Apple-silicon host with a baked `mf-golden` image. Run the complete
release check with `make verify-hardware`; it creates only `mf-releasecheck`,
`mf-releasecopy`, and `mfsnap-releasecheck-ready`, refuses to touch pre-existing entries
with those names, and cleans up after itself. It remains a manual release gate rather than
part of CI because hosted runners do not provide Virtualization.framework VM capacity.

## Design docs

- [`docs/superpowers/specs/`](docs/superpowers/specs/) — design spec.
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — implementation plan.

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
setup, test, and commit conventions, and [SECURITY.md](SECURITY.md) for reporting a
vulnerability privately.

## License

[MIT](LICENSE) © Robert Fridzema
