from __future__ import annotations

import os
import platform
import shutil
from collections.abc import Callable
from typing import Any

from macfleet.vm import GOLDEN, shortname

# Warn below this much free space. A single VM's disk is tens of GB, so "a few GB free"
# means the next create fails halfway through a clone.
LOW_DISK_GB = 20.0

# tart's temporary/backup clones. `restore` deliberately leaves a backup behind rather than
# delete user data (connect.py:1014), so these accumulate silently.
_ORPHAN_PREFIXES = ("mfbackup-", "mftmp-")

# (status, detail, fix) — `fix` is a human-readable hint, not an executable action.
CheckResult = tuple[str, str, "str | None"]

# A guest that is up but wedged can hold a screenshot open for the client's full default
# window. /doctor is a synchronous request occupying a threadpool worker, so bound it tighter.
TCC_SCREENSHOT_TIMEOUT = 10.0


class _Inventory:
    """One `tart list` per report, shared by every check that needs it.

    Five checks used to shell out separately, so a single /doctor spawned `tart list` five
    times. A failure is deliberately not cached: `tart list` raising IS the finding for each
    check that depends on it, and each still turns into its own `fail` row."""

    def __init__(self, fleet: Any) -> None:
        self._fleet = fleet
        self._vms: list | None = None

    def __call__(self) -> list:
        if self._vms is None:
            self._vms = self._fleet.tart.list()
        return self._vms


def _arch(_fleet: Any, _vms: Any) -> CheckResult:
    machine = platform.machine()
    if machine == "arm64":
        return "ok", machine, None
    return "fail", f"{machine} — macfleet needs Apple silicon (Virtualization.framework)", None


def _tart(_fleet: Any, _vms: Any) -> CheckResult:
    path = shutil.which("tart")
    if path is None:
        return "fail", "not found on PATH", "brew install cirruslabs/cli/tart"
    return "ok", path, None


def _golden(_fleet: Any, vms: Any) -> CheckResult:
    if any(v.name == GOLDEN for v in vms()):
        return "ok", f"{GOLDEN} present", None
    return "fail", f"{GOLDEN} not found", "macfleet bake"


def _golden_warm(_fleet: Any, vms: Any) -> CheckResult:
    for v in vms():
        if v.name == GOLDEN:
            if v.state == "suspended":
                return "ok", "suspended — new VMs resume in ~2s", None
            return "warn", f"state is {v.state!r} — new VMs will cold-boot (~30-60s)", "macfleet warm"
    return "skip", f"{GOLDEN} not present", "macfleet bake"


def _tcc_screenshot(fleet: Any, vms: Any) -> CheckResult:
    """The documented golden-image trap: without Screen Recording granted at bake time,
    every screenshot comes back empty. Only testable against a live fleet VM — never
    golden, which is the clone source and must not be driven."""
    if os.environ.get("MACFLEET_ALLOW_CONTROL") != "1":
        return "skip", "computer-use disabled — set MACFLEET_ALLOW_CONTROL=1 to test", None
    running = [v for v in vms()
               if v.state == "running" and v.name.startswith("mf-") and v.name != GOLDEN]
    if not running:
        return "skip", "no running VM to test against", None
    name = shortname(running[0].name)
    data = fleet.computer(name).screenshot(timeout=TCC_SCREENSHOT_TIMEOUT)
    if data:
        return "ok", f"captured {len(data)} bytes from {name}", None
    return "fail", f"{name} returned an empty screenshot", "re-bake golden — TCC not granted"


def _orphans(_fleet: Any, vms: Any) -> CheckResult:
    leaked = sorted(v.name for v in vms() if v.name.startswith(_ORPHAN_PREFIXES))
    if not leaked:
        return "ok", "none", None
    return ("warn", f"{len(leaked)} leaked: {', '.join(leaked)}",
            "Settings → Data → Remove all VMs & data")


def _stale_leases(fleet: Any, vms: Any) -> CheckResult:
    live = {v.name for v in vms()}
    stale = sorted(n for n in fleet.leases.expiries() if n not in live)
    if not stale:
        return "ok", "none", None
    # No fix hint: reap() only drops *expired* leases, and these are cleared by a data reset.
    return "warn", f"{len(stale)} for VMs tart no longer has: {', '.join(stale)}", None


def _disk(_fleet: Any, _vms: Any) -> CheckResult:
    target = os.path.expanduser("~/.tart")
    if not os.path.exists(target):
        target = os.path.expanduser("~")
    st = os.statvfs(target)
    free_gb = st.f_bavail * st.f_frsize / 1e9
    if free_gb < LOW_DISK_GB:
        return "warn", f"{free_gb:.0f}GB free — a VM disk is tens of GB", None
    return "ok", f"{free_gb:.0f}GB free", None


CHECKS: tuple[tuple[str, str, Callable[[Any, Any], CheckResult]], ...] = (
    ("arch", "Apple silicon", _arch),
    ("tart", "tart installed", _tart),
    ("golden", "Golden image present", _golden),
    ("golden_warm", "Golden image warm", _golden_warm),
    ("tcc_screenshot", "Screen recording permission", _tcc_screenshot),
    ("orphans", "No leaked temporary VMs", _orphans),
    ("stale_leases", "No stale leases", _stale_leases),
    ("disk", "Disk space", _disk),
)


def run_checks(fleet: Any) -> list[dict]:
    """Run every check, in order. A check that raises becomes a `fail` row rather than
    failing the whole report — a broken check must not leave the user with no diagnosis at
    exactly the moment they came looking for one."""
    results = []
    vms = _Inventory(fleet)
    for check_id, label, fn in CHECKS:
        try:
            status, detail, fix = fn(fleet, vms)
        except Exception as exc:  # noqa: BLE001 — a check's failure IS a finding
            status, detail, fix = "fail", str(exc), None
        results.append({"id": check_id, "label": label, "status": status,
                        "detail": detail, "fix": fix})
    return results
