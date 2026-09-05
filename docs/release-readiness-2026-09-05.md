# macfleet 0.5.0 release-readiness report

Assessment date: 5 September 2026. Baseline commit: `9b6e586`, plus the local changes described below.

## Release decision

**Do not publish this build as a finished public macOS release yet.** Core automated checks and the real VM verification ladder pass after fixes. The built application launches and operates locally, but its distribution signature fails Gatekeeper verification and it has no stapled notarization ticket. A newly created guest also displays a macOS screen-access consent prompt, so unattended computer-use readiness is not established by a successful screenshot alone.

No release, tag, upload, or signing-account change was performed. These results cover this Apple-silicon Mac, not every supported OS or a clean customer installation.

## Environment and method

- Host: macOS 26.6.2, arm64; guest: macOS 26.5, build 25F71.
- Python 3.14.7; uv 0.12.10; Cargo 1.95.0; Tart 2.32.1; local Bun 1.4.2.
- Also verified frozen installation with the repository's pinned Bun 1.3.8.
- Started from a clean Git working tree. Existing VMs and snapshots were inventoried before hardware tests.
- Executed Python and frontend suites, Chromium/Firefox/WebKit browser journeys, Rust tests and static checks, dependency audits, a production frontend and native app build, real HTTP checks against the packaged engine, the real L1–L3 hardware script, and native UI inspection.
- Browser tests intercept API requests. They are not evidence of real virtualization. The hardware and native app checks supply separate integration evidence.
- The in-app Browser connection failed with `privileged native pipe bridge is not available; browser-client is not trusted`. Existing Playwright tests ran through the repository runner. Native UI inspection used the Computer Use skill and the newly built application path, not the previously installed application.

## Test results

| Area | Result | Evidence and limits |
| --- | --- | --- |
| Python suite | PASS: 295 tests | `uv run --extra mcp pytest -q`; one Starlette/httpx deprecation warning |
| Vue unit tests | PASS: 446 tests, 37 files | `bun run test:unit:coverage` |
| Frontend coverage | PASS configured thresholds | Statements 93.79%; branches 91.51%; functions 89.27%; lines 95.90% |
| Browser E2E | PASS: 54 tests | 18 scenarios on each of Chromium, Firefox, and WebKit; final run 19.6 seconds, no retries |
| Rust | PASS: 13 tests | `cargo test --manifest-path desktop/src-tauri/Cargo.toml` |
| Python static checks | PASS | Ruff lint and formatting |
| Frontend static checks | PASS | ESLint, Biome lint/format, Vue/TypeScript build |
| Rust static checks | PASS | `cargo fmt -- --check`; Clippy all targets with warnings denied |
| Frozen JS install | PASS | Both local Bun and pinned Bun 1.3.8 accept the updated lockfile |
| Production frontend | PASS | Vite production bundle built successfully |
| Native release build | PASS | `bunx tauri build --bundles app`; optimized arm64 `.app` with bundled engine |
| Packaged engine HTTP | PASS | New repeatable smoke script checks actual executable from the app bundle; startup approximately 0.42 seconds on this warm local machine |
| Real hardware L1–L3 | PASS after SSH fix | Clone, cold boot, SSH, guest execution, PNG screenshot, snapshot, MCP snapshot clone/execution/screenshot/delete, cleanup |
| Native UI | PASS with guest-consent/resume caveats | Launch, fleet loading, settings, doctor, engine log, command palette, real VM creation, live image, terminal, suspend, eventual resume, and corrected Quit |
| JS dependency audit | PASS after updates | Initially eight advisories; final audit finds none across 450 packages |
| Python runtime and build audits | PASS | Both exported pinned graphs checked with pip-audit; runtime export includes MCP |
| Rust dependency audit | CONDITIONAL | Unfiltered audit fails on three already documented advisories; existing CI exclusions pass, with warnings remaining |
| Public distribution verification | FAIL | Ad-hoc signature, no TeamIdentifier; Gatekeeper signature failure; no stapled ticket |

There are **808 passing automated tests** across Python, Vue, Rust, and browser suites. Hardware and packaged-engine checks are additional, not included in that count.

### Browser scenarios exercised

1. Direct navigation to About.
2. Fleet list rendering and selecting a VM.
3. Command palette keyboard shortcut and command execution.
4. Default resource preset change and persistence across reload.
5. Doctor result and remediation-hint rendering.
6. Settings back navigation.
7. Brand navigation back to the fleet.
8. VM creation with snapshot source, resource preset, and TTL selected.
9. Snapshot dialog and resulting sidebar entry.
10. Two-step VM deletion.
11. Screen image display, including successful image decoding.
12. Terminal command and exit-code display.
13. Log display.
14. CPU, RAM, disk and live metric rendering.
15. Connection information and successful clipboard feedback.
16. Rejected creation: engine error displayed, failed pending row removed, successful retry possible.
17. Cancelled deletion: VM preserved and no delete request sent.
18. Shared folders: add read-only, switch to read-write, and remove.

### Engine and security coverage

The Python suite exercises CLI and MCP dispatch; Tart command construction; name and snapshot validation; lifecycle and provisioning; snapshot/restore behavior; lease expiry and retry; shared-folder state; configuration persistence; logs; guest-control gating; API resource and TTL bounds; authentication on reads and mutations; CORS; and shutdown behavior. Most of these use injected runners or fake fleet objects. The L0 test is offline integration, not a real VM test.

The packaged-engine smoke test uses real HTTP against the compiled executable. It verifies authenticated `/config` and `/host` reads, 401 responses for missing authentication, rejection of an unauthenticated creation request, 422 for an invalid TTL before creation can execute, allowed Tauri preflight, rejected foreign-origin preflight, and bounded SIGTERM termination. It does not intentionally modify fleet configuration or create a VM.

### Real hardware and native findings

The initial hardware run failed directly after `up`: `tart ip mf-releasecheck failed: no IP address found`. Its cleanup removed the owned temporary VM. After the fix, the complete script passed, including a 3,334,532-byte PNG and MCP-driven snapshot-clone lifecycle. The script verified that its two VMs and snapshot were removed.

The built native application loaded the existing fleet, rendered settings and doctor checks, read its engine log, and opened/dismissed the command palette using Command-K/Escape. Creating the dedicated `releasenative` VM through the native form advanced through cloning, resources, boot, guest health, and Running. The Screen tab displayed the actual guest desktop. The Terminal tab executed `sw_vers -productVersion`, displayed `26.5`, and reported exit 0.

The guest image included a dialog stating that `python3.12` was requesting permission to bypass the system private window picker and access screen/audio. Capture itself worked, but this is contrary to an assumption of fully unattended, prompt-free guest setup. The screenshot-byte hardware gate cannot detect this. No consent or OS security-setting change was made during the test.

Native Suspend reached Suspended. Resume eventually reached Running and SSH worked, but guest `uptime` reported only 12 seconds after the cycle. This suggests a cold boot rather than preserved execution state; the code has a deliberate cold-boot fallback for a known Tart/VZ restore error. The exact fallback diagnostic was not retained, so this run does not certify state-preserving native resume or the UI's approximately two-second resume claim.

The original native Quit check exposed an actual shutdown hang: the engine logged `Waiting for connections to close` while its fleet stream remained open. The temporary VM was deleted through the CLI; after an additional interrupt did not stop the old engine, the owned test processes were explicitly terminated. The fix and regression test are described below.

Cleanup restored the original inventory: `cua-tahoe`, `mf-blah`, `mf-carl`, `mf-golden`, `mf-test`, `mf-test-light`, and the pre-existing `mfsnap-vm-cc0e-20260709.193334`. Original running/stopped/suspended states were preserved. Only disposable release-test VMs and the release-test snapshot were deleted; those test resources are not recoverable. The application launch rotated its normal engine log and test lifecycle actions added normal activity records.

## Fixes and why

### Native quit blocked by an open fleet stream

Changed both API launch entrypoints, `macfleet/cli.py` and `macfleet/sidecar.py`, to set Uvicorn's graceful connection-drain timeout to five seconds. Previously Uvicorn could wait indefinitely for the authenticated SSE connection before entering the lifespan shutdown that suspends the fleet. The native host would eventually hit its own 330-second kill deadline, potentially skipping that suspension.

Added `tests/test_api_shutdown.py`: two real subprocess tests launch the actual CLI/sidecar entrypoints with an injected fake fleet, hold an HTTP event stream open, send SIGTERM, and verify that the suspend-on-exit callback and application shutdown complete. Both pass. The timeout bounds connection draining, not the subsequent VM suspension work. A long-running in-flight API response can be cancelled during quit; the existing fleet shutdown phase still gets to run.

Rebuilt the full `.app`, launched it, confirmed an active `/fleet/events` connection, and invoked Command-Q again. This time both native and engine processes exited in approximately five seconds and the engine logged `Application shutdown complete`. Uvicorn logs an expected cancellation traceback when the drain deadline expires; graceful stream signalling would be a useful follow-up to avoid that noise. The final native quit retest had no running VMs; actual invocation of suspend-on-exit is verified by the subprocess regressions.

### Cold-boot SSH discovery race

Changed `macfleet/connect.py`. SSH previously retried a small set of connection errors, but neither of Tart's missing-IP responses. It also defaulted to only three attempts, insufficient for a normal cold boot. SSH now retries empty-IP and `no IP address found` discovery failures and defaults to 30 attempts with two-second backoff. Discovery matching is scoped to IP lookup, so remote command output mentioning a missing IP does not cause a retry.

Added regressions for both missing-IP forms, explicit retry-budget exhaustion, and a remote command failure containing the same text. Existing transient-connection and permanent-command-failure tests also pass. The real hardware script subsequently passed.

Tradeoff: an unreachable VM may now take longer to report failure. This is an attempt limit, not a 60-second total deadline; individual subprocess durations add to elapsed time. A future improvement is a shared wall-clock readiness budget.

### Vulnerable JavaScript tooling dependencies

Updated the lockfile within existing version ranges:

| Package | Before | After |
| --- | --- | --- |
| `@humanfs/node` | 0.16.7 | 0.16.8 |
| `browserslist` | 4.28.1 | 4.28.7 |
| `fast-uri` | 3.1.5 | 3.1.6 |
| `postcss-selector-parser` | 7.1.1 | 7.1.3 |

Their necessary transitive dependencies also changed. The original audit reported six high, one moderate, and one low advisory, through lint/coverage tooling. This does not establish exploitable application-runtime exposure; it does establish a failing CI audit and affected tooling dependencies. Final audit, installation, lint, unit tests, browser tests, and production build pass. The Browserslist patch is documented in the [upstream advisory](https://github.com/advisories/GHSA-c83g-rgw3-j3cx).

### Browser tests giving incomplete assurance

Changed the screenshot mock from invalid base64 JSON to a valid binary PNG matching the current API, and asserted decoded `naturalWidth`. During development, the replacement PNG fixture also needed correction for reliable cross-browser decoding; the final fixture passes all three browsers.

Added a catch-all network abort below the specific API mocks. Previously unmatched requests could reach a live engine despite the mock's comment claiming otherwise. Added mocking to the About test as well. Added the three regression journeys listed above, taking E2E coverage from 45 to 54 executions.

### Bundled-engine integration gap

Added `scripts/verify-packaged-engine.py` and a CI step immediately after building the sidecar. Previously the packaging script only checked `--help`. The new check verifies server startup and authenticated HTTP behavior, catching failures that import/build checks miss. Its signal assertion accepts Uvicorn's normal SIGTERM re-raise after shutdown.

## Remaining release gates

1. **Sign and notarize the actual distributable.** `codesign -dv --verbose=4` reports `Signature=adhoc`, `TeamIdentifier=not set`, and no sealed resources. `spctl --assess --type execute --verbose=2` reports “code has no resources but signature indicates they must be present”. `xcrun stapler validate` exits 65 because no ticket is stapled. Produce a Developer ID signed/notarized artifact with the release owner's credentials, then rerun signature, Gatekeeper, and ticket checks. See [Apple's notarization guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
2. **Resolve or explicitly document guest consent behavior.** Reproduce the observed screen-access dialog on a freshly baked golden image, establish the supported first-run permission process, and verify it across a reboot and snapshot clone. Do not advertise fully unattended setup until this is demonstrated.
   Also verify preservation of guest execution state across native suspend/resume; the observed short uptime after resume is not evidence of a successful warm restore.
3. **Test a clean installation of the final artifact.** This run built an `.app`; it did not validate a newly built DMG, quarantined download, clean machine without developer tools, upgrade from a prior release, or uninstall. A warm developer Mac cannot substitute for those checks.
4. **Complete the intended support matrix.** Only Python 3.14 and macOS 26.6.2 were executed locally. CI declares Python 3.12/3.13/3.14, but this report is not a claim that remote CI ran on these uncommitted changes. No Intel or other macOS-version certification was performed.
5. **Keep Rust risk exceptions explicit.** The unfiltered audit reports `RUSTSEC-2026-0194`, `0195` (quick-xml 0.39.4), and `0235` (rkyv 0.7.46). `cargo tree --target all` confirms quick-xml enters through the Linux Wayland scanner and rkyv has no active reverse dependency. Existing CI exclusions were preserved, not expanded. Nineteen audit warnings also remain, including unmaintained, unsoundness, and a yanked-version warning. Track upstream remediation; do not describe this as a clean unfiltered Rust audit.

The Python package still declares `Private :: Do Not Upload`. This is an intentional publication guard to resolve if PyPI distribution is part of the release plan; it does not prevent distributing source or the desktop app.

## Further optimization opportunities

| Priority | Opportunity | Evidence / benefit |
| --- | --- | --- |
| High | Preserve actionable error detail when the fleet is nonempty | Sidebar renders `store.error` only when there are no rows; several mutation toasts use generic text. Keep failures visible and offer a clear retry path. |
| High | Expand unattended guest readiness checks | PNG bytes prove capture returned data, not that permission prompts or login overlays are absent. |
| Medium | Add native integration for remaining OS features | Tray actions, folder picker, external VNC/SSH launch, clipboard failures, reset confirmations and updater/install flows need dedicated native or clean-machine coverage. |
| Medium | Exercise long-running and failure conditions | Host sleep/wake, repeated suspend/resume, sidecar crash recovery, low disk, simultaneous lifecycle operations, TTL expiration during use, and long screenshot sessions were not soak-tested. |
| Medium | Bound SSH readiness by elapsed time | Thirty attempts can exceed a minute when commands themselves time out. Use one deadline and pass remaining budgets to subprocess calls. |
| Medium | Improve targeted test coverage | ContextMenu: 44.44% branches; FoldersTab: 40% branches; useEngineLog: 68.75% statements; BulkPanel: 37.5% functions. Prioritize failure handling and native integrations over cosmetic coverage increases. |
| Medium | Formal accessibility and small-window review | No VoiceOver audit, measured contrast audit, or complete minimum-size layout review was performed. |
| Low | Measure capture load and UI responsiveness | The app polls multi-megabyte images; measure CPU, memory, screenshot latency and retained blobs under a realistic fleet. Existing visibility/in-flight guards are useful, but no endurance benchmark was run. |
| Low | Reduce dependency warning debt | Migrate deprecated Starlette test-client usage when the supported test stack is settled; monitor Rust warnings and existing exceptions. |
| Low | Improve release automation and evidence retention | Add final `.app`/DMG build verification, signed artifact checks, uploaded test traces and a clean-machine checklist to the release workflow. |

Current production measurements: main JavaScript chunk 145.15 kB (54.86 kB gzip); fleet page chunk 48.81 kB (13.39 kB gzip); CSS 31.77 kB (7.07 kB gzip). The app occupies approximately 48 MB locally, including the approximately 28 MB standalone engine. These are build sizes, not performance benchmarks.

## Reproduction

```sh
uv run --extra dev --extra mcp pytest -q
uv run ruff check .
uv run ruff format --check .
make verify-hardware
```

`make verify-hardware` creates and deletes only its reserved temporary resources and refuses pre-existing name collisions. It requires an Apple-silicon Mac, Tart, a golden image, and enough free resources.

```sh
cd desktop
bun install --frozen-lockfile
bun audit
bun run lint
bun run format:check
bun run test:unit:coverage
bun run test:e2e --reporter=line
bunx tauri build --bundles app
uv run --project .. python ../scripts/verify-packaged-engine.py src-tauri/binaries/macfleet-engine/macfleet-engine
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
cargo audit --file src-tauri/Cargo.lock
```

The final command intentionally shows the unfiltered Rust findings. The precise Python audit exports and existing Rust exception flags are recorded in `.github/workflows/ci.yml`.

## Addendum: follow-up fixes (5 September 2026, later the same day)

Verified on the same host with a disposable clone (`mf-relcheck2`, created and deleted; inventory and suspended set restored).

- **Guest consent prompt (gate 2).** Root cause: replayd's per-binary `ScreenCaptureApprovals.plist` carries a `kScreenCapturePrivacyHintDate` with a 30-day policy. The golden was baked on 13 July, the hint expired on 12 August, so every clone since re-prompts. The provision script now pushes that date to 2099 for both python paths. Reproduced the dialog on a fresh clone, applied the new section, rebooted, screenshot clean. **Re-bake golden (`macfleet bake`) to carry the fix into clones.**
- **Suspend race (gate 2, resume).** `tart suspend` returns before the VM leaves `running` (about ten seconds on this host). The engine now polls until `suspended` before resume, clone, or snapshot proceed. Previously a resume launched immediately after suspend hit `already running`.
- **Warm resume on this host.** Plain `tart run` on a settled suspended VM fails with VZ error 12 (`failed to restore … invalid argument`), independent of macfleet. The cold-boot fallback is therefore expected here; it now logs the VZ diagnostic and records a `coldboot-fallback` activity entry. Speed claims of "resume in ~2s" were softened in the CLI, doctor, README, and bake steps. State-preserving resume remains unverified on this host/Tart combination.
- **SSH readiness** is bounded by one wall-clock budget (60 s default) that also caps each subprocess, with an explicit "unreachable over SSH after Ns" error.
- **Engine quit** signals open fleet streams on SIGTERM so the drain finishes in milliseconds; the regression test asserts no cancellation traceback and shutdown under four seconds.
- **Failure toasts** carry the engine's reason; stop and delete failures now toast; the sidebar keeps the error banner visible when the fleet is not empty.
- **Rust audit** exceptions moved to `desktop/src-tauri/.cargo/audit.toml` so `cargo audit` gives the same verdict locally and in CI.
