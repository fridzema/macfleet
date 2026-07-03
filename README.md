# macfleet

A fleet of disposable macOS VMs on a single Apple-silicon host, managed over SSH and
driven with computer use ([trycua](https://github.com/trycua)'s `cua-computer-server`).
Spin up N named VMs cloned from one provisioned golden image, SSH in for scripted
work, or hand a VM to a computer-use agent to click/type through a GUI. Today this is
a Python engine (CLI + local API); a Tauri desktop app (fleet view, tray, live
screenshots) is a planned follow-up on top of the same core.

## Prerequisites

- Apple-silicon Mac (uses Apple's Virtualization.framework via `tart`).
- [`tart`](https://github.com/cirruslabs/tart): `brew install cirruslabs/cli/tart`
- [`uv`](https://github.com/astral-sh/uv) for Python dependency management.

## Setup

```bash
make setup   # uv sync --extra dev
```

## Baking the golden image

VMs are cloned from a single provisioned image, `mf-golden`, so per-VM boot is fast.
Bake it once per host:

```bash
scripts/bake.sh
```

This clones the base image, boots it, copies your SSH key in, and runs the guest
provisioning (public DNS, `cua-computer-server` installed under a launchd unit on
`:8000`). It then prints a reminder for the one manual step that can't be scripted:
connect via VNC and grant **Accessibility + Screen Recording** (TCC) to the
computer-server helper, once. Every VM cloned from `mf-golden` afterwards inherits
that grant. Finish with `tart stop mf-golden`.

## CLI usage

```bash
uv run macfleet up web              # clone mf-golden -> mf-web and boot it
uv run macfleet ssh web "uname -a"  # run a command on mf-web over SSH
uv run macfleet ls                  # list fleet VMs and their state
uv run macfleet down web            # stop mf-web
uv run macfleet nuke web            # stop + delete mf-web
uv run macfleet bake                # print the golden-image bake checklist
uv run macfleet serve               # start the local API (for the future desktop app)
```

`up` returns as soon as `tart run` is launched — it does not wait for SSH to come up.
The guest takes roughly 30s to boot, so an `ssh` run immediately after `up` may need a
short wait/retry (this is why `scripts/bake.sh` sleeps before `ssh-copy-id`).

## Computer-use safety gate

Computer-use control (screenshot/click/type via `Fleet.computer()`) is disabled by
default. It requires `MACFLEET_ALLOW_CONTROL=1` in the environment, and it only ever
targets fleet VMs over their guest IP — never the host. Without the flag,
`Fleet.computer()` raises.

## Verification ladder (L0-L3)

- **L0 — offline, no hardware.** Unit + integration tests against injectable
  fakes (no real `tart`/SSH). Run with `make test` or `make demo`
  (`tests/test_integration_l0.py`, a scripted list -> up -> list flow through the API).
- **L1 — tart reachable.** After `scripts/bake.sh`, run `tart list` and confirm
  `mf-golden` is listed.
- **L2 — up + SSH.** `uv run macfleet up web && uv run macfleet ssh web "sw_vers -productVersion"`
  should print the guest macOS version.
- **L3 — computer-use control.** With the golden image's TCC grant in place:
  `MACFLEET_ALLOW_CONTROL=1 uv run python -c "from macfleet.connect import Fleet; print(len(Fleet().computer('web').screenshot()))"`
  should print a nonzero byte count (a PNG frame).

L1-L3 require an Apple-silicon host with a baked `mf-golden` image and are run
manually; they are verification steps, not part of the automated test suite.

## Design docs

- [`docs/superpowers/specs/`](docs/superpowers/specs/) — design spec.
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — implementation plan.
