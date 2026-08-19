# Contributing to macfleet

Thanks for your interest in contributing. macfleet is two halves in one repo — a Python
**engine** (CLI, local API, MCP server) at the root, and a Tauri **desktop app** under
`desktop/` — and most changes touch only one of them.

## Prerequisites

- An Apple-silicon Mac. The engine drives Apple's Virtualization.framework through `tart`,
  so VM work cannot run anywhere else. Frontend-only changes build on any platform.
- [`tart`](https://github.com/cirruslabs/tart): `brew install cirruslabs/cli/tart`
- [`uv`](https://github.com/astral-sh/uv) — engine dependencies
- [`bun`](https://bun.sh/) and a stable [Rust](https://www.rust-lang.org/tools/install)
  toolchain plus the [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/)
  — desktop app only

## Setup

```bash
git clone https://github.com/fridzema/macfleet.git
cd macfleet
make setup          # engine venv (uv sync) + desktop deps (bun, Playwright, git hooks)
```

`make setup-engine` or `make setup-desktop` installs one half. Running the app against real
VMs also needs a baked golden image (`scripts/bake.sh`); see the
[README](README.md#baking-the-golden-image). The unit, e2e, and L0 integration suites all run
against fakes and mocks, so **no VM and no baked image are needed to develop or test.**

## Development workflow

1. Branch from `main`:

   ```bash
   git checkout -b feature/your-feature
   ```

2. Make the change and verify it:

   ```bash
   make dev                 # run the desktop app (auto-spawns the engine sidecar)
   make serve               # or just the engine API on :8765
   make test                # engine pytest + desktop vitest
   make lint                # ruff + eslint/biome/clippy
   ```

   Whole-project targets need both halves installed; use `make test-engine` /
   `make lint-desktop` etc. to run one. `make e2e` runs the Playwright suite against a mocked
   API. `make dev-frontend` serves the frontend in a plain browser; since there is no Tauri
   host to hand it the engine's per-run token, set `VITE_MACFLEET_TOKEN` (in `desktop/.env`)
   to the token `macfleet serve` prints on startup, or every request comes back 401. Before pushing, mirror CI: `make lint && make test && make e2e`, plus
   `make -C desktop rust-test` for Rust changes.

3. Commit using [Conventional Commits](https://www.conventionalcommits.org/). Commitlint
   enforces the format through a git hook.

   **Commit types:**

   | Type       | Description                                             |
   | ---------- | ------------------------------------------------------- |
   | `feat`     | A new feature                                           |
   | `fix`      | A bug fix                                               |
   | `docs`     | Documentation only changes                              |
   | `style`    | Formatting, missing semicolons, etc. (no logic)         |
   | `refactor` | Code change that neither fixes a bug nor adds a feature |
   | `perf`     | Performance improvement                                 |
   | `test`     | Adding or correcting tests                              |
   | `build`    | Changes to the build system or dependencies             |
   | `ci`       | Changes to CI configuration                             |
   | `chore`    | Other changes that don't modify src or test files       |
   | `revert`   | Reverts a previous commit                               |

   Scope the subject with the half you touched where it helps: `feat(engine):`,
   `fix(desktop):`.

   **Examples:**

   ```
   feat(desktop): add system tray support
   fix(engine): serialize concurrent suspend and resume
   docs: update installation instructions
   feat!: redesign the snapshot id scheme
   ```

   Use `!` after the type or a `BREAKING CHANGE:` footer for breaking changes.

4. Push and open a pull request against `main`. CI (`.github/workflows/ci.yml`) runs the
   engine and desktop jobs on `macos-15`, including `pip-audit`, `bun audit`, and
   `cargo audit`.

## Code style

- **Python**: Ruff lints and formats (`make lint-engine`, `make format-engine`), line length
  100, target 3.12. Type annotations everywhere; modules use `from __future__ import
  annotations`.
- **TypeScript/Vue**: ESLint + Biome (`make lint-desktop`, `make format-desktop`).
- **Rust**: Clippy with `-D warnings` + rustfmt (`make -C desktop rust-lint`,
  `make -C desktop rust-format`).
- Lefthook installs pre-commit hooks for the desktop half (eslint, biome, clippy, rustfmt) and
  a commit-msg hook for commitlint. There is **no** engine pre-commit hook — run
  `make lint-engine` yourself. Skip hooks with `LEFTHOOK=0 git commit`.

## Testing

| Command                       | Purpose                                     |
| ----------------------------- | ------------------------------------------- |
| `make test-engine`            | Engine unit + L0 integration tests (pytest) |
| `make test-desktop`           | Vitest unit tests                           |
| `make e2e`                    | Playwright e2e tests (mocked API)           |
| `make -C desktop rust-test`   | Rust unit tests                             |
| `make test`                   | Engine + desktop unit tests                 |
| `make demo`                   | The L0 integration demo test                |

Anything above L0 (real `tart`, real SSH, real computer-use) is manual — the ladder is
documented in the [README](README.md#verification-ladder-l0-l3). New engine behavior should
come with tests against the injectable fakes rather than a real VM.

## Project layout

| Path                 | What lives there                                          |
| -------------------- | --------------------------------------------------------- |
| `macfleet/`          | Engine: CLI, local API, MCP server, VM/fleet logic        |
| `tests/`             | Engine pytest suite                                       |
| `scripts/`           | Golden-image bake + engine sidecar build                  |
| `desktop/src/`       | Vue 3 frontend                                            |
| `desktop/src-tauri/` | Rust host (window, tray, engine sidecar supervision)      |
| `desktop/tests/`     | Vitest unit tests + Playwright e2e                        |
| `docs/`              | Design brief, specs, and implementation plans             |

## Reporting issues

Use GitHub Issues. Include:

- Steps to reproduce
- Expected vs actual behavior
- macOS version, chip, `tart --version`, and macfleet version
- Relevant output from `~/.macfleet/engine.log` and the engine's health checks
  (`GET /doctor`, or the desktop app's Settings page)

Security problems go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Releases

Releases are cut by hand today: bump the version in `pyproject.toml`,
`macfleet/__init__.py`, `desktop/package.json`, `desktop/src-tauri/tauri.conf.json`, and
`desktop/src-tauri/Cargo.toml`, add a `CHANGELOG.md` entry, run the L1-L3 hardware check,
tag `vX.Y.Z`, and publish the GitHub release. Conventional commits are still required — they
are what the changelog entry is written from, and what an automated release flow would
consume later.

Releases are GitHub-only and carry no Python or desktop binaries: the desktop app is not yet
code-signed or notarized, so it is built from source with `make build`. The Python project is
intentionally marked `Private :: Do Not Upload` to prevent an accidental PyPI publication.
