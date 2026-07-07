import base64
import json
import subprocess
import urllib.error
import pytest
from macfleet.connect import ssh_cmd, scp_push_cmd, Fleet, GuestControl, SSH_OPTS
from macfleet.leases import Leases
from macfleet.vm import Tart, VmInfo


def fake_runner(script):
    def run(argv):
        return subprocess.CompletedProcess(argv, 0, stdout=script(argv), stderr="")
    return run


def test_ssh_cmd_shape():
    cmd = ssh_cmd("192.168.64.4", "uptime")
    assert cmd[0] == "ssh"
    assert "admin@192.168.64.4" in cmd
    assert cmd[-1] == "uptime"
    for opt in SSH_OPTS:
        assert opt in cmd


def test_scp_push_cmd_shape():
    cmd = scp_push_cmd("192.168.64.4", "a.txt", "/tmp/a.txt")
    assert cmd[0] == "scp"
    assert cmd[-2] == "a.txt"
    assert cmd[-1] == "admin@192.168.64.4:/tmp/a.txt"


def test_up_clones_golden_and_starts():
    seen = []
    def tart_run(argv):
        seen.append(argv)
        return subprocess.CompletedProcess(argv, 0, "[]" if argv[:2] == ["tart", "list"] else "", "")
    fleet = Fleet(tart=Tart(run=tart_run), spawn=seen.append)
    fleet.up("web")
    assert ["tart", "clone", "mf-golden", "mf-web"] in seen
    assert ["tart", "run", "mf-web", "--no-graphics"] in seen


def test_computer_blocked_without_env(monkeypatch):
    monkeypatch.delenv("MACFLEET_ALLOW_CONTROL", raising=False)
    fleet = Fleet(tart=Tart(run=fake_runner(lambda argv: "")))
    with pytest.raises(RuntimeError, match="MACFLEET_ALLOW_CONTROL"):
        fleet.computer("web")


# --- GuestControl: drives the in-guest computer-server over /cmd ---


class _FakeResp:
    def __init__(self, text):
        self._t = text

    def read(self):
        return self._t.encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _opener(response_text, captured):
    def open_(req, timeout=None):
        captured.append((req.full_url, json.loads(req.data.decode())))
        return _FakeResp(response_text)
    return open_


def test_guest_screenshot_decodes_image_data():
    png = b"\x89PNG\r\n\x1a\nDATA"
    b64 = base64.b64encode(png).decode()
    cap = []
    gc = GuestControl("http://vm:8000", opener=_opener(f'data: {{"success": true, "image_data": "{b64}"}}', cap))
    assert gc.screenshot() == png
    assert cap[0][0] == "http://vm:8000/cmd"
    assert cap[0][1] == {"command": "screenshot", "params": {}}


def test_guest_click_sends_left_click_coords():
    cap = []
    gc = GuestControl("http://vm:8000", opener=_opener('data: {"success": true}', cap))
    gc.click(12, 34)
    assert cap[0][1] == {"command": "left_click", "params": {"x": 12, "y": 34}}


def test_guest_type_sends_text():
    cap = []
    gc = GuestControl("http://vm:8000", opener=_opener('data: {"success": true}', cap))
    gc.type("hi there")
    assert cap[0][1] == {"command": "type_text", "params": {"text": "hi there"}}


def test_guest_key_combo_uses_hotkey_single_uses_press_key():
    cap = []
    gc = GuestControl("http://vm:8000", opener=_opener('data: {"success": true}', cap))
    gc.key("cmd+space")
    assert cap[0][1] == {"command": "hotkey", "params": {"keys": ["cmd", "space"]}}
    gc.key("escape")
    assert cap[1][1] == {"command": "press_key", "params": {"key": "escape"}}


def test_guest_command_failure_raises_runtimeerror():
    gc = GuestControl("http://vm:8000", opener=_opener('data: {"success": false, "error": "boom"}', []))
    with pytest.raises(RuntimeError, match="boom"):
        gc.click(1, 1)


def test_guest_unreachable_raises_runtimeerror():
    def boom(req, timeout=None):
        raise urllib.error.URLError("connection refused")
    gc = GuestControl("http://vm:8000", opener=boom)
    with pytest.raises(RuntimeError, match="unreachable"):
        gc.screenshot()


# --- Fleet lifecycle: suspend/resume, create, reap ---


def _fleet(tmp_path, vms=(), clock_val=1000.0):
    calls = []
    listing = list(vms)

    def run(argv):
        calls.append(argv)
        if argv[:2] == ["tart", "list"]:
            import json as j
            return subprocess.CompletedProcess(argv, 0, j.dumps(
                [{"Name": v.name, "State": v.state, "Source": v.source, "Size": v.size} for v in listing]), "")
        if argv[:2] == ["tart", "get"]:
            return subprocess.CompletedProcess(argv, 0, '{"State":"running"}', "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    spawned = []
    lease = Leases(str(tmp_path / "state.json"), clock=lambda: clock_val)
    fleet = Fleet(tart=Tart(run=run), run=run, spawn=spawned.append,
                  leases=lease, clock=lambda: clock_val)
    return fleet, calls, spawned, lease


def test_suspend_resume(tmp_path):
    fleet, calls, spawned, _ = _fleet(tmp_path)
    fleet.suspend("web")
    fleet.resume("web")
    assert ["tart", "suspend", "mf-web"] in calls
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned


def test_create_clones_golden_and_records_ttl(tmp_path):
    fleet, calls, spawned, lease = _fleet(tmp_path)
    fleet.create("web", ttl=60)
    assert ["tart", "clone", "mf-golden", "mf-web"] in calls
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned
    assert lease.expired(1000 + 61) == ["mf-web"]


def test_create_from_snapshot(tmp_path):
    fleet, calls, _, _ = _fleet(tmp_path)
    fleet.create("web", from_snapshot="base-clean")
    assert ["tart", "clone", "mfsnap-base-clean", "mf-web"] in calls


def test_up_delegates_to_create(tmp_path):
    fleet, calls, _, _ = _fleet(tmp_path)
    fleet.up("web")
    assert ["tart", "clone", "mf-golden", "mf-web"] in calls


def test_reap_deletes_expired(tmp_path):
    fleet, calls, _, lease = _fleet(tmp_path, vms=[VmInfo("mf-old", "running", "local")], clock_val=2000.0)
    lease.record("mf-old", ttl=-1)  # already expired at t=2000
    reaped = fleet.reap()
    assert reaped == ["mf-old"]
    assert ["tart", "delete", "mf-old"] in calls
    assert lease.expired(1e12) == []


# --- Fleet snapshots: suspend->clone->resume, clean-disk fallback ---


def test_snapshot_running_vm_suspends_clones_resumes(tmp_path):
    fleet, calls, spawned, _ = _fleet(tmp_path)  # _state returns "running" via fake
    sid = fleet.snapshot("web", "clean")
    assert sid == "web-clean"
    assert calls.index(["tart", "suspend", "mf-web"]) < calls.index(["tart", "clone", "mf-web", "mfsnap-web-clean"])
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned  # resumed original


def test_snapshot_falls_back_to_stop_when_suspend_fails(tmp_path):
    calls = []

    def run(argv):
        calls.append(argv)
        if argv[:2] == ["tart", "get"]:
            return subprocess.CompletedProcess(argv, 0, '{"State":"running"}', "")
        if argv[:2] == ["tart", "suspend"]:
            raise RuntimeError("suspend unsupported")
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, "[]", "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, spawn=lambda a: None,
                  leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0), clock=lambda: 0.0)
    fleet.snapshot("web", "clean")
    assert ["tart", "stop", "mf-web"] in calls  # clean-disk fallback


def test_snapshots_lists_and_parses(tmp_path):
    fleet, _, _, _ = _fleet(tmp_path, vms=[
        VmInfo("mfsnap-web-clean", "stopped", "local", 3.2),
        VmInfo("mf-web", "running", "local"),
    ])
    snaps = fleet.snapshots()
    assert snaps == [{"id": "web-clean", "vm": "web", "label": "clean", "size": 3.2}]


def test_delete_snapshot(tmp_path):
    fleet, calls, _, _ = _fleet(tmp_path)
    fleet.delete_snapshot("web-clean")
    assert ["tart", "delete", "mfsnap-web-clean"] in calls


# --- Fleet identity, resources, access ---


def test_rename_moves_vm_and_lease(tmp_path):
    fleet, calls, _, lease = _fleet(tmp_path)
    lease.record("mf-web", ttl=999)
    fleet.rename("web", "prod")
    assert ["tart", "rename", "mf-web", "mf-prod"] in calls
    assert lease.expired(1e12) == ["mf-prod"]


def test_duplicate_stateful(tmp_path):
    fleet, calls, spawned, _ = _fleet(tmp_path)  # _state -> running
    fleet.duplicate("web", "web2")
    assert ["tart", "clone", "mf-web", "mf-web2"] in calls
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned
    assert ["tart", "run", "mf-web2", "--no-graphics"] in spawned


def test_resources_parses_get(tmp_path):
    def run(argv):
        return subprocess.CompletedProcess(argv, 0,
            '{"CPU":6,"Memory":16384,"Disk":80,"Display":"1920x1080","State":"stopped"}', "")
    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    assert fleet.resources("web") == {"cpu": 6, "memory_mb": 16384, "disk_gb": 80,
                                      "display": "1920x1080", "state": "stopped"}


def test_set_resources_rejects_running(tmp_path):
    def run(argv):
        return subprocess.CompletedProcess(argv, 0, '{"State":"running","CPU":4,"Memory":8192,"Disk":50,"Display":"x"}', "")
    from macfleet.leases import Leases
    import pytest
    fleet = Fleet(tart=Tart(run=run), run=run, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    with pytest.raises(RuntimeError, match="stop the VM"):
        fleet.set_resources("web", cpu=8)


def test_set_resources_sets_when_stopped(tmp_path):
    calls = []
    def run(argv):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, '{"State":"stopped","CPU":4,"Memory":8192,"Disk":50,"Display":"x"}', "")
    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    fleet.set_resources("web", cpu=8, memory=16384)
    assert calls[-1] == ["tart", "set", "mf-web", "--cpu", "8", "--memory", "16384"]


def test_connection_info(tmp_path):
    def run(argv):
        if argv[:2] == ["tart", "ip"]:
            return subprocess.CompletedProcess(argv, 0, "192.168.64.9\n", "")
        return subprocess.CompletedProcess(argv, 0, "", "")
    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    info = fleet.connection_info("web")
    assert info["ip"] == "192.168.64.9"
    assert info["ssh"] == "ssh admin@192.168.64.9"
    assert info["guest_server"] == "http://192.168.64.9:8000"
    assert info["exec"] is True


def test_exec_returns_stdout_and_exit_code(tmp_path):
    def nocheck(argv):
        assert argv[:3] == ["tart", "exec", "mf-web"]
        assert argv[3:] == ["/bin/sh", "-lc", "echo hi"]
        return subprocess.CompletedProcess(argv, 2, "hi\n", "")
    from macfleet.leases import Leases
    fleet = Fleet(run=lambda a: subprocess.CompletedProcess(a, 0, "", ""),
                  run_nocheck=nocheck, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    assert fleet.exec("web", "echo hi") == {"stdout": "hi\n", "exit_code": 2}
