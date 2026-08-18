from macfleet.doctor import TCC_SCREENSHOT_TIMEOUT, run_checks
from macfleet.vm import VmInfo


class FakeLeases:
    def __init__(self, expiries=None):
        self._expiries = expiries or {}

    def expiries(self):
        return dict(self._expiries)


class FakeComputer:
    def __init__(self, data=b"PNG"):
        self._data = data

    def screenshot(self, timeout=None):
        self.timeout = timeout
        return self._data


class FakeFleet:
    def __init__(self, vms=(), expiries=None, computer_obj=None, computer_error=None):
        self.tart = self
        self._vms = list(vms)
        self.leases = FakeLeases(expiries)
        self._computer_obj = computer_obj or FakeComputer()
        self._computer_error = computer_error

    def list(self):
        self.list_calls = getattr(self, "list_calls", 0) + 1
        return self._vms

    def computer(self, name):
        if self._computer_error is not None:
            raise self._computer_error
        return self._computer_obj


def by_id(checks):
    return {c["id"]: c for c in checks}


def test_every_check_reports_a_known_shape():
    checks = run_checks(FakeFleet())
    assert checks
    for c in checks:
        assert set(c) == {"id", "label", "status", "detail", "fix"}
        assert c["status"] in ("ok", "warn", "fail", "skip")


def test_arch_ok_on_apple_silicon(monkeypatch):
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    assert by_id(run_checks(FakeFleet()))["arch"]["status"] == "ok"


def test_arch_fails_on_intel(monkeypatch):
    monkeypatch.setattr("platform.machine", lambda: "x86_64")
    c = by_id(run_checks(FakeFleet()))["arch"]
    assert c["status"] == "fail"
    assert "Apple silicon" in c["detail"]


def test_tart_fails_when_not_on_path(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: None)
    c = by_id(run_checks(FakeFleet()))["tart"]
    assert c["status"] == "fail"
    assert c["fix"]


def test_tart_ok_when_present(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: "/opt/homebrew/bin/tart")
    c = by_id(run_checks(FakeFleet()))["tart"]
    assert c["status"] == "ok"
    assert "/opt/homebrew/bin/tart" in c["detail"]


def test_golden_fails_when_absent():
    c = by_id(run_checks(FakeFleet()))["golden"]
    assert c["status"] == "fail"
    assert c["fix"] == "macfleet bake"


def test_golden_ok_when_present():
    fleet = FakeFleet(vms=[VmInfo("mf-golden", "suspended", "local")])
    assert by_id(run_checks(fleet))["golden"]["status"] == "ok"


def test_golden_warm_ok_when_suspended():
    fleet = FakeFleet(vms=[VmInfo("mf-golden", "suspended", "local")])
    assert by_id(run_checks(fleet))["golden_warm"]["status"] == "ok"


def test_golden_warm_warns_when_merely_stopped():
    fleet = FakeFleet(vms=[VmInfo("mf-golden", "stopped", "local")])
    c = by_id(run_checks(fleet))["golden_warm"]
    assert c["status"] == "warn"
    assert c["fix"] == "macfleet warm"


def test_golden_warm_skips_when_golden_absent():
    assert by_id(run_checks(FakeFleet()))["golden_warm"]["status"] == "skip"


def test_tcc_skips_when_computer_use_gate_off(monkeypatch):
    # Gate off means TCC is untested, not broken — even with a running VM to test against.
    monkeypatch.delenv("MACFLEET_ALLOW_CONTROL", raising=False)
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local")])
    c = by_id(run_checks(fleet))["tcc_screenshot"]
    assert c["status"] == "skip"
    assert "MACFLEET_ALLOW_CONTROL" in c["detail"]


def test_tcc_skips_with_no_running_vm(monkeypatch):
    monkeypatch.setenv("MACFLEET_ALLOW_CONTROL", "1")
    fleet = FakeFleet(vms=[VmInfo("mf-web", "stopped", "local")])
    assert by_id(run_checks(fleet))["tcc_screenshot"]["status"] == "skip"


def test_tcc_ok_when_screenshot_returns_bytes(monkeypatch):
    monkeypatch.setenv("MACFLEET_ALLOW_CONTROL", "1")
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local")])
    c = by_id(run_checks(fleet))["tcc_screenshot"]
    assert c["status"] == "ok"


def test_tcc_fails_on_empty_screenshot(monkeypatch):
    monkeypatch.setenv("MACFLEET_ALLOW_CONTROL", "1")
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local")],
                      computer_obj=FakeComputer(data=b""))
    c = by_id(run_checks(fleet))["tcc_screenshot"]
    assert c["status"] == "fail"
    assert "re-bake" in c["fix"]


def test_tcc_never_targets_golden(monkeypatch):
    monkeypatch.setenv("MACFLEET_ALLOW_CONTROL", "1")
    # golden is running but is not a fleet VM; there is nothing else to test against.
    fleet = FakeFleet(vms=[VmInfo("mf-golden", "running", "local")])
    assert by_id(run_checks(fleet))["tcc_screenshot"]["status"] == "skip"


def test_a_raising_check_becomes_a_fail_not_a_crash(monkeypatch):
    monkeypatch.setenv("MACFLEET_ALLOW_CONTROL", "1")
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local")],
                      computer_error=RuntimeError("computer-use disabled"))
    c = by_id(run_checks(fleet))["tcc_screenshot"]
    assert c["status"] == "fail"
    assert "computer-use disabled" in c["detail"]


def test_orphans_ok_when_none():
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local")])
    assert by_id(run_checks(fleet))["orphans"]["status"] == "ok"


def test_orphans_warns_and_names_leaks():
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local"),
                           VmInfo("mfbackup-abc", "stopped", "local"),
                           VmInfo("mftmp-def", "stopped", "local")])
    c = by_id(run_checks(fleet))["orphans"]
    assert c["status"] == "warn"
    assert "mfbackup-abc" in c["detail"]
    assert "mftmp-def" in c["detail"]


def test_stale_leases_ok_when_all_live():
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local")],
                      expiries={"mf-web": 123.0})
    assert by_id(run_checks(fleet))["stale_leases"]["status"] == "ok"


def test_stale_leases_warns_for_vanished_vm():
    fleet = FakeFleet(vms=[], expiries={"mf-gone": 123.0})
    c = by_id(run_checks(fleet))["stale_leases"]
    assert c["status"] == "warn"
    assert "mf-gone" in c["detail"]
    assert c["fix"] is None  # doctor diagnoses; it does not repair


def test_disk_warns_when_low(monkeypatch):
    import macfleet.doctor as doctor

    class St:
        f_bavail = 1
        f_frsize = 1_000_000_000  # 1GB free
    monkeypatch.setattr(doctor.os, "statvfs", lambda _: St())
    c = by_id(run_checks(FakeFleet()))["disk"]
    assert c["status"] == "warn"


def test_disk_ok_when_plentiful(monkeypatch):
    import macfleet.doctor as doctor

    class St:
        f_bavail = 500
        f_frsize = 1_000_000_000  # 500GB free
    monkeypatch.setattr(doctor.os, "statvfs", lambda _: St())
    assert by_id(run_checks(FakeFleet()))["disk"]["status"] == "ok"


def test_report_shells_out_to_tart_list_once(monkeypatch):
    # Five checks need the inventory; each used to spawn its own `tart list`.
    monkeypatch.setenv("MACFLEET_ALLOW_CONTROL", "1")
    fleet = FakeFleet(vms=[VmInfo("mf-golden", "suspended", "local"),
                          VmInfo("mf-web", "running", "local")])
    run_checks(fleet)
    assert fleet.list_calls == 1


def test_tcc_screenshot_is_bounded(monkeypatch):
    # /doctor holds a threadpool worker, so the probe must not wait out the client default.
    monkeypatch.setenv("MACFLEET_ALLOW_CONTROL", "1")
    computer = FakeComputer()
    fleet = FakeFleet(vms=[VmInfo("mf-web", "running", "local")], computer_obj=computer)
    assert by_id(run_checks(fleet))["tcc_screenshot"]["status"] == "ok"
    assert computer.timeout == TCC_SCREENSHOT_TIMEOUT
