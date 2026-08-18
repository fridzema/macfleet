# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do not open a public issue.**

Instead, use [GitHub Security Advisories](https://github.com/fridzema/macfleet/security/advisories/new) to privately report the vulnerability.

You should receive a response within 48 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.x     | Yes       |

Only the latest 0.x release receives fixes; there are no maintained release branches.

## Security Practices

- **The local API is never unauthenticated.** `macfleet serve` binds `127.0.0.1` and generates
  a random token when `MACFLEET_API_TOKEN` is unset or empty; the desktop app passes its own
  per-run token on an ephemeral port. Every route — including reads — requires the token,
  compared in constant time.
- **Computer-use is gated twice.** Host-side it needs `MACFLEET_ALLOW_CONTROL=1`; guest-side
  the privileged `/cmd` endpoint needs a token that rotates on every guest boot and is
  readable only over SSH (mode 0600), so posting straight at a guest IP cannot bypass the gate.
- **No shell interpolation.** `tart`, `ssh`, and `scp` are invoked with argument vectors, never
  through a shell; VM names and snapshot labels are validated against a strict character set.
  Shell-outs are bounded in both runtime and captured output.
- **The golden base image is digest-pinned** in `scripts/bake.sh`, so a re-bake cannot silently
  pick up a different privileged image.
- Dependencies are audited in CI on every push and pull request: `pip-audit` (Python),
  `bun audit` (JS), `cargo audit` (Rust).
- Tauri capabilities follow least-privilege principles, and a Content Security Policy is
  enabled by default.

## Threat Model

macfleet is a **single-user tool for a trusted host**. It assumes the person running it owns
the machine and everything on the fleet network. Read the
[Security model](README.md#security-model) section of the README before exposing it to
anything else — in particular, guest VMs deliberately run with SIP disabled and TCC
pre-granted, and are not a security boundary.
