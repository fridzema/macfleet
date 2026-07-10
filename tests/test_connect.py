import base64
import json
import subprocess
import urllib.error
import pytest
from macfleet.connect import ssh_cmd, scp_push_cmd, Fleet, GuestControl, SSH_OPTS
from macfleet.leases import Leases
from macfleet.shares import Shares
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
            # Full config so `resources()`'s strict getter doesn't raise on missing
            # keys; State reflects the matching VM's actual listed state (falling
            # back to "running" for VMs not passed into `vms=`, preserving the
            # snapshot/duplicate tests' assumption that an unlisted target is live).
            vm = next((v for v in listing if v.name == argv[2]), None)
            state = vm.state if vm else "running"
            return subprocess.CompletedProcess(argv, 0, json.dumps(
                {"State": state, "CPU": 4, "Memory": 8192, "Disk": 50, "Display": "x"}), "")
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


def test_create_with_preset_sets_resources_before_run(tmp_path):
    events = []

    def run(argv):
        events.append(("run", argv))
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, "[]", "")
        if argv[:2] == ["tart", "get"]:
            return subprocess.CompletedProcess(argv, 0, '{"Disk": 80}', "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    def spawn(argv):
        events.append(("spawn", argv))

    fleet = Fleet(tart=Tart(run=run), run=run, spawn=spawn,
                  leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    fleet.create("web", cpu=4, memory=8192, disk=100)  # 100 > cloned base's 80GB -> grows
    set_idx = events.index(
        ("run", ["tart", "set", "mf-web", "--cpu", "4", "--memory", "8192", "--disk-size", "100"])
    )
    run_idx = events.index(("spawn", ["tart", "run", "mf-web", "--no-graphics"]))
    assert set_idx < run_idx


def test_create_without_preset_skips_set(tmp_path):
    fleet, calls, _, _ = _fleet(tmp_path)
    fleet.create("web")
    assert not any(c[:2] == ["tart", "set"] for c in calls)


def test_create_existing_running_name_skips_clone_and_set(tmp_path):
    # Re-creating a name that's already a running VM (no expired lease) must NOT re-clone
    # and must NOT `tart set` — set on a running VM fails and previously surfaced as a
    # spurious "failed to create" 409. It just re-issues `tart run` (idempotent).
    fleet, calls, spawned, _ = _fleet(
        tmp_path, vms=[VmInfo("mf-web", "running", "local")])
    fleet.create("web", cpu=8, memory=16384)
    assert not any(c[:2] == ["tart", "clone"] for c in calls)
    assert not any(c[:2] == ["tart", "set"] for c in calls)
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned


def test_create_reclaims_expired_target_name(tmp_path):
    # The target name is held by a VM whose lease already expired: reclaim it (stop+delete)
    # then clone fresh over the name.
    fleet, calls, _, lease = _fleet(
        tmp_path, vms=[VmInfo("mf-web", "running", "local")], clock_val=2000.0)
    lease.record("mf-web", ttl=-1)  # expired at t=2000
    fleet.create("web")
    assert calls.index(["tart", "delete", "mf-web"]) < calls.index(
        ["tart", "clone", "mf-golden", "mf-web"])


def test_create_does_not_reap_unrelated_expired_vm(tmp_path):
    # An unrelated expired VM must NOT block create with its (slow) graceful stop — the
    # background reap loop sweeps it, not create. Creating "web" leaves "mf-old" untouched.
    fleet, calls, _, lease = _fleet(
        tmp_path, vms=[VmInfo("mf-old", "running", "local")], clock_val=2000.0)
    lease.record("mf-old", ttl=-1)  # expired, but unrelated to "web"
    fleet.create("web")
    assert not any(c[:2] == ["tart", "delete"] for c in calls)
    assert not any(c[:3] == ["tart", "stop", "mf-old"] for c in calls)


def test_ip_is_cached_and_invalidated_on_stop(tmp_path):
    calls = []

    def run(argv):
        calls.append(argv)
        if argv[:2] == ["tart", "ip"]:
            return subprocess.CompletedProcess(argv, 0, "192.168.64.7\n", "")
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, "[]", "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    fleet = Fleet(tart=Tart(run=run), run=run, spawn=lambda a: None,
                  leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    assert fleet.ip("web") == "192.168.64.7"
    assert fleet.ip("web") == "192.168.64.7"
    assert len([c for c in calls if c[:2] == ["tart", "ip"]]) == 1  # second call cached
    fleet.down("web")  # stopping the VM invalidates the cached IP
    fleet.ip("web")
    assert len([c for c in calls if c[:2] == ["tart", "ip"]]) == 2  # re-resolved after stop


def test_warm_golden_suspends_when_guest_becomes_healthy(tmp_path, monkeypatch):
    calls = []

    def run(argv):
        calls.append(argv)
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, json.dumps(
                [{"Name": "mf-golden", "State": "stopped", "Source": "local"}]), "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    spawned = []
    fleet = Fleet(tart=Tart(run=run), run=run, spawn=spawned.append,
                  leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0), clock=lambda: 0.0)
    monkeypatch.setattr(fleet, "status", lambda name: True)  # guest reachable immediately
    slept = []
    assert fleet.warm_golden(sleep=slept.append) is True
    assert ["tart", "run", "mf-golden", "--no-graphics"] in spawned
    assert ["tart", "suspend", "mf-golden"] in calls
    assert slept == []  # healthy on the first poll, never slept


def test_warm_golden_times_out_without_suspending(tmp_path, monkeypatch):
    calls = []

    def run(argv):
        calls.append(argv)
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, json.dumps(
                [{"Name": "mf-golden", "State": "stopped", "Source": "local"}]), "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    now = {"t": 0.0}
    fleet = Fleet(tart=Tart(run=run), run=run, spawn=lambda a: None,
                  leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0),
                  clock=lambda: now["t"])
    monkeypatch.setattr(fleet, "status", lambda name: False)  # never reachable

    def sleep(p):
        now["t"] += p

    assert fleet.warm_golden(timeout=10.0, poll=3.0, sleep=sleep) is False
    assert not any(c[:2] == ["tart", "suspend"] for c in calls)


def test_spawn_detaches_into_new_session(monkeypatch):
    import macfleet.connect as connect_mod

    seen = {}

    class FakePopen:
        def __init__(self, argv, **kwargs):
            seen["argv"] = argv
            seen.update(kwargs)

    monkeypatch.setattr(connect_mod.subprocess, "Popen", FakePopen)
    connect_mod._spawn(["tart", "run", "mf-x", "--no-graphics"])
    # Must break out of the engine's process group so a group-SIGTERM on app quit
    # doesn't kill the VM.
    assert seen["start_new_session"] is True


def test_create_disk_shrink_is_guarded_grow_only(tmp_path):
    # tart's `--disk-size` is grow-only: shrinking raises RuntimeError. mf-golden clones
    # at ~80GB, so a preset requesting a smaller disk (e.g. Light's 40GB) must never
    # attempt a shrink — only apply --disk-size when it exceeds the current disk. This
    # fake raises on ANY `--disk-size`, modeling tart's shrink failure — since the guard
    # must skip the call entirely for a smaller disk, that raise must never be reached.
    def run_would_raise_on_shrink(argv):
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, "[]", "")
        if argv[:2] == ["tart", "get"]:
            return subprocess.CompletedProcess(argv, 0, '{"Disk": 80}', "")
        if argv[:2] == ["tart", "set"] and "--disk-size" in argv:
            raise RuntimeError("tart set --disk-size: cannot shrink disk")
        return subprocess.CompletedProcess(argv, 0, "", "")

    fleet = Fleet(tart=Tart(run=run_would_raise_on_shrink), run=run_would_raise_on_shrink,
                  spawn=lambda a: None, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    fleet.create("web", disk=40)  # smaller than current 80GB -> must not shrink, must not raise

    # Growing still emits --disk-size as before.
    events = []

    def run_grows(argv):
        events.append(argv)
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, "[]", "")
        if argv[:2] == ["tart", "get"]:
            return subprocess.CompletedProcess(argv, 0, '{"Disk": 80}', "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    fleet2 = Fleet(tart=Tart(run=run_grows), run=run_grows, spawn=lambda a: None,
                   leases=Leases(str(tmp_path / "s2.json"), clock=lambda: 0.0))
    fleet2.create("web2", disk=100)  # larger than current 80GB -> grows normally
    assert ["tart", "set", "mf-web2", "--disk-size", "100"] in events


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


def test_list_vms_reaps_first_and_marks_health(tmp_path):
    fleet, calls, _, lease = _fleet(
        tmp_path,
        vms=[VmInfo("mf-old", "running", "local"), VmInfo("mf-web", "stopped", "local")],
        clock_val=2000.0,
    )
    lease.record("mf-old", ttl=-1)  # already expired at t=2000
    vms = fleet.list_vms()
    # reap() ran first: the expired VM was stopped/deleted before the listing logic.
    assert ["tart", "delete", "mf-old"] in calls
    assert lease.expired(1e12) == []
    # structure: name/state/source/healthy for every VM `tart list` returned, minus
    # anything reap() just deleted.
    assert vms == [
        {"name": "mf-web", "state": "stopped", "source": "local", "healthy": False,
         "cpu": 4, "memory_mb": 8192, "disk_gb": 50},
    ]


def test_list_vms_shells_out_to_tart_list_once(tmp_path):
    # Hot path: list_vms() must not re-list after reap() already fetched the listing.
    fleet, calls, _, _ = _fleet(
        tmp_path,
        vms=[VmInfo("mf-web", "stopped", "local")],
        clock_val=2000.0,
    )
    fleet.list_vms()
    tart_list_calls = [c for c in calls if c[:2] == ["tart", "list"]]
    assert len(tart_list_calls) == 1


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


def test_snapshot_rejects_duplicate_id(tmp_path):
    fleet, _, _, _ = _fleet(tmp_path, vms=[
        VmInfo("mf-web", "stopped", "local"),
        VmInfo("mfsnap-web-clean", "stopped", "local"),
    ])
    with pytest.raises(RuntimeError, match="already exists"):
        fleet.snapshot("web", "clean")


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


def test_restore_stops_deletes_clones_runs_when_vm_exists(tmp_path):
    fleet, calls, spawned, _ = _fleet(tmp_path, vms=[
        VmInfo("mf-web", "running", "local"),
        VmInfo("mfsnap-web-clean", "stopped", "local"),
    ])
    fleet.restore("web", "web-clean")
    assert calls.index(["tart", "stop", "mf-web"]) \
        < calls.index(["tart", "delete", "mf-web"]) \
        < calls.index(["tart", "clone", "mfsnap-web-clean", "mf-web"])
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned


def test_restore_recreates_when_vm_absent(tmp_path):
    fleet, calls, spawned, _ = _fleet(
        tmp_path, vms=[VmInfo("mfsnap-web-clean", "stopped", "local")])
    fleet.restore("web", "web-clean")
    assert not any(c[:2] == ["tart", "delete"] for c in calls)
    assert ["tart", "clone", "mfsnap-web-clean", "mf-web"] in calls
    assert ["tart", "run", "mf-web", "--no-graphics"] in spawned


def test_restore_rejects_unknown_snapshot(tmp_path):
    fleet, _, _, _ = _fleet(tmp_path, vms=[VmInfo("mf-web", "running", "local")])
    with pytest.raises(RuntimeError, match="not found"):
        fleet.restore("web", "web-clean")


def test_restore_rejects_golden():
    fleet = Fleet(tart=Tart(run=fake_runner(lambda argv: "")))
    with pytest.raises(RuntimeError, match="protected template"):
        fleet.restore("golden", "web-clean")


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


def test_resources_missing_key_raises_runtime_error(tmp_path):
    def run(argv):
        return subprocess.CompletedProcess(argv, 0, "{}", "")
    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    with pytest.raises(RuntimeError, match="unexpected tart get output"):
        fleet.resources("web")


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


def test_host_info_parses_sysctl_and_hostname(tmp_path):
    def run(argv):
        # 17179869184 bytes == 16 GiB exactly — decimal (1e9) would misreport this as 17.
        if argv == ["sysctl", "-n", "hw.memsize", "hw.ncpu"]:
            return subprocess.CompletedProcess(argv, 0, "17179869184\n8\n", "")
        if argv == ["hostname"]:
            return subprocess.CompletedProcess(argv, 0, "mac-studio.local\n", "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    fleet = Fleet(run=run, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    assert fleet.host_info() == {"total_mem_gb": 16, "cpu_count": 8, "name": "mac-studio.local"}


def test_exec_returns_stdout_and_exit_code(tmp_path):
    def nocheck(argv):
        assert argv[:3] == ["tart", "exec", "mf-web"]
        assert argv[3:] == ["/bin/sh", "-lc", "echo hi"]
        return subprocess.CompletedProcess(argv, 2, "hi\n", "")
    from macfleet.leases import Leases
    fleet = Fleet(run=lambda a: subprocess.CompletedProcess(a, 0, "", ""),
                  run_nocheck=nocheck, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    assert fleet.exec("web", "echo hi") == {"stdout": "hi\n", "exit_code": 2}


# --- Fleet suspended tracking ---


def test_suspend_marks_and_resume_clears(tmp_path):
    fleet, calls, spawned, lease = _fleet(tmp_path)
    fleet.suspend("web")
    assert lease.suspended() == {"mf-web"}
    fleet.resume("web")
    assert lease.suspended() == set()


def test_down_and_nuke_clear_suspended(tmp_path):
    fleet, calls, _, lease = _fleet(tmp_path)
    lease.suspend("mf-web")
    fleet.down("web")
    assert lease.suspended() == set()
    lease.suspend("mf-web2")
    fleet.nuke("web2")
    assert lease.suspended() == set()


def test_list_vms_reports_suspended(tmp_path):
    fleet, _, _, lease = _fleet(tmp_path, vms=[VmInfo("mf-web", "running", "local")])
    lease.suspend("mf-web")
    row = next(r for r in fleet.list_vms() if r["name"] == "mf-web")
    assert row["state"] == "suspended"


def test_snapshot_resume_clears_stale_suspended_marker(tmp_path):
    # Source was user-suspended before the snapshot ran. snapshot() suspends it further
    # (or it's already suspended), clones, then resumes it via a raw `tart run` — that
    # resume must also clear the lease-store suspended marker, or list_vms() would keep
    # mislabeling the now-running source as "suspended" forever.
    fleet, calls, spawned, lease = _fleet(tmp_path)  # _state -> running
    lease.suspend("mf-web")
    fleet.snapshot("web", "v1")
    assert "mf-web" not in lease.suspended()


def test_duplicate_resume_clears_stale_suspended_marker(tmp_path):
    fleet, calls, spawned, lease = _fleet(tmp_path)  # _state -> running
    lease.suspend("mf-web")
    fleet.duplicate("web", "web2")
    assert "mf-web" not in lease.suspended()


# --- Fleet configured-resources cache ---


def test_list_vms_includes_cached_resources_and_fetches_once(tmp_path):
    fleet, calls, _, _ = _fleet(tmp_path, vms=[VmInfo("mf-web", "running", "local")])
    rows = fleet.list_vms()
    row = next(r for r in rows if r["name"] == "mf-web")
    assert "memory_mb" in row and "cpu" in row and "disk_gb" in row
    gets = [c for c in calls if c[:2] == ["tart", "get"]]
    fleet.list_vms()  # second call: cache hit
    gets2 = [c for c in calls if c[:2] == ["tart", "get"]]
    assert len(gets2) == len(gets)  # no additional tart get on cache hit


def test_list_vms_tolerates_tart_get_failure_for_one_vm(tmp_path):
    # A VM can vanish between `tart list` and `tart get` (concurrent delete/reap), so
    # `tart get` returns empty stdout for it. That must not blow up the whole listing —
    # the VM still gets a row with None resources, and it's left out of the cache so
    # it's retried on the next call instead of sticking with a bad value.
    def run(argv):
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, json.dumps(
                [{"Name": "mf-web", "State": "running", "Source": "local"}]), "")
        if argv[:2] == ["tart", "get"]:
            return subprocess.CompletedProcess(argv, 0, "", "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run,
                  leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    rows = fleet.list_vms()
    row = next(r for r in rows if r["name"] == "mf-web")
    assert row["cpu"] is None and row["memory_mb"] is None and row["disk_gb"] is None
    assert "mf-web" not in fleet._res_cache


def test_set_resources_invalidates_cache(tmp_path):
    fleet, calls, _, _ = _fleet(tmp_path, vms=[VmInfo("mf-web", "stopped", "local")])
    fleet.list_vms()
    fleet._res_cache["mf-web"] = {"cpu": 4, "memory_mb": 8192, "disk_gb": 50}
    fleet.set_resources("web", cpu=8)
    assert "mf-web" not in fleet._res_cache


def test_set_resources_never_shrinks_disk(tmp_path):
    # fake get_config: stopped VM with 50GB disk; a shrink to 40 must be dropped
    def run(argv):
        if argv[:2] == ["tart", "get"]:
            return subprocess.CompletedProcess(argv, 0, '{"State":"stopped","CPU":4,"Memory":8192,"Disk":50,"Display":"x"}', "")
        if argv[:2] == ["tart", "set"]:
            assert "--disk-size" not in argv  # shrink dropped
        return subprocess.CompletedProcess(argv, 0, "", "")
    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    fleet.set_resources("web", disk_size=40)  # would shrink -> must be dropped, no error


def test_metrics_parses_top(tmp_path):
    top = "CPU usage: 1.91% user, 23.56% sys, 74.52% idle\nPhysMem: 8029M used (1027M wired), 147M unused."
    def nocheck(argv):
        assert argv[:3] == ["tart", "exec", "mf-web"]
        return subprocess.CompletedProcess(argv, 0, top, "")
    def run(argv):  # for mem_total via resources()
        return subprocess.CompletedProcess(argv, 0, '{"State":"running","CPU":4,"Memory":8192,"Disk":50,"Display":"x"}', "")
    from macfleet.leases import Leases
    fleet = Fleet(tart=Tart(run=run), run=run, run_nocheck=nocheck,
                  leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    m = fleet.metrics("web")
    assert m["cpu_pct"] == 25.5           # 100 - 74.52 = 25.48 -> 25.5
    assert m["mem_used_mb"] == 8029
    assert m["mem_total_mb"] == 8192


def test_metrics_raises_when_exec_fails(tmp_path):
    def nocheck(argv):
        return subprocess.CompletedProcess(argv, 1, "", "vm not running")
    from macfleet.leases import Leases
    import pytest
    fleet = Fleet(run=lambda a: subprocess.CompletedProcess(a, 0, "", ""),
                  run_nocheck=nocheck, leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0))
    with pytest.raises(RuntimeError, match="metrics unavailable"):
        fleet.metrics("web")


def test_activity_recent_delegates(tmp_path):
    from macfleet.activity import Activity
    from macfleet.leases import Leases
    act = Activity(str(tmp_path / "a.jsonl"), clock=lambda: 5.0)
    act.record("claude-code", "created", "web")
    fleet = Fleet(run=lambda a: subprocess.CompletedProcess(a, 0, "", ""),
                  leases=Leases(str(tmp_path / "s.json"), clock=lambda: 0.0), activity=act)
    r = fleet.activity_recent()
    assert r[0]["who"] == "claude-code" and r[0]["action"] == "created"


def test_nuke_rejects_golden_template():
    # `nuke("golden")` resolves to mf-golden (the clone source); deleting it would break
    # every future create. Reject via both the short and full name; nothing is deleted.
    seen = []
    def tart_run(argv):
        seen.append(argv)
        return subprocess.CompletedProcess(argv, 0, "[]" if argv[:2] == ["tart", "list"] else "", "")
    fleet = Fleet(tart=Tart(run=tart_run), spawn=seen.append)
    for target in ("golden", "mf-golden"):
        with pytest.raises(RuntimeError, match="protected template"):
            fleet.nuke(target)
    assert not any(a[:2] == ["tart", "delete"] for a in seen)


def test_rename_rejects_golden_destination():
    fleet = Fleet(tart=Tart(run=fake_runner(lambda argv: "")))
    with pytest.raises(RuntimeError, match="protected template"):
        fleet.rename("web", "golden")


def test_golden_blocks_exec_ssh_computer_and_metrics(tmp_path, monkeypatch):
    # Command-execution and control paths must refuse mf-golden too, not just the
    # lifecycle mutations. No tart/ssh command should be issued for any of them.
    monkeypatch.setenv("MACFLEET_ALLOW_CONTROL", "1")
    fleet, calls, _, _ = _fleet(tmp_path)
    for call in (lambda: fleet.exec("golden", "rm -rf /"),
                 lambda: fleet.ssh("golden", "whoami"),
                 lambda: fleet.computer("golden"),
                 lambda: fleet.metrics("golden")):
        with pytest.raises(RuntimeError, match="protected template"):
            call()
    assert calls == []


def test_duplicate_rejects_golden_source():
    # duplicate() suspends/stops its source, so a golden *source* must be rejected, not
    # only a golden destination.
    fleet = Fleet(tart=Tart(run=fake_runner(lambda argv: "")))
    with pytest.raises(RuntimeError, match="protected template"):
        fleet.duplicate("golden", "copy")


def test_snapshots_parse_hyphenated_vm_name(tmp_path):
    # A VM named `web-api` with label `clean` must parse as vm=web-api, label=clean —
    # split on the LAST hyphen (labels forbid '-').
    fleet, _, _, _ = _fleet(tmp_path, vms=[VmInfo("mfsnap-web-api-clean", "stopped", "local", 1.0)])
    assert fleet.snapshots() == [{"id": "web-api-clean", "vm": "web-api", "label": "clean", "size": 1.0}]


def test_create_rejects_invalid_name():
    seen = []
    def tart_run(argv):
        seen.append(argv)
        return subprocess.CompletedProcess(argv, 0, "[]" if argv[:2] == ["tart", "list"] else "", "")
    fleet = Fleet(tart=Tart(run=tart_run), spawn=seen.append)
    for bad in ("we/b", "a?b", "x#y", ""):
        with pytest.raises(RuntimeError, match="invalid VM name"):
            fleet.create(bad)
    assert not any(a[:2] == ["tart", "clone"] for a in seen)


def test_snapshot_rejects_hyphenated_label(tmp_path):
    fleet, _, _, _ = _fleet(tmp_path, vms=[VmInfo("mf-web", "stopped", "local")])
    with pytest.raises(RuntimeError, match="invalid snapshot label"):
        fleet.snapshot("web", "not-clean")


# --- Shared folders: _run_argv, set_shares validation, rename/nuke propagation ---


def _fleet_with_shares(tmp_path, shares):
    calls = []
    spawned = []

    def run(argv):
        calls.append(argv)
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, "[]", "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    fleet = Fleet(tart=Tart(run=run), run=run, spawn=spawned.append,
                  leases=Leases(str(tmp_path / "l.json"), clock=lambda: 0.0),
                  shares=shares, clock=lambda: 0.0)
    return fleet, calls, spawned


def test_run_argv_appends_dir_flags(tmp_path):
    shares = Shares(str(tmp_path / "s.json"))
    shares.set("mf-web", [
        {"tag": "src", "host_path": "/h/src", "read_only": True},
        {"tag": "out", "host_path": "/h/out", "read_only": False},
    ])
    fleet, _, _ = _fleet_with_shares(tmp_path, shares)
    assert fleet._run_argv("mf-web") == [
        "tart", "run", "mf-web", "--no-graphics",
        "--dir=src:/h/src:ro", "--dir=out:/h/out",
    ]


def test_run_argv_base_when_no_shares(tmp_path):
    fleet, _, _ = _fleet_with_shares(tmp_path, Shares(str(tmp_path / "s.json")))
    assert fleet._run_argv("mf-web") == ["tart", "run", "mf-web", "--no-graphics"]


def test_create_boots_with_share_flags(tmp_path):
    shares = Shares(str(tmp_path / "s.json"))
    shares.set("mf-web", [{"tag": "src", "host_path": "/h", "read_only": True}])
    fleet, _, spawned = _fleet_with_shares(tmp_path, shares)
    fleet.create("web")
    assert ["tart", "run", "mf-web", "--no-graphics", "--dir=src:/h:ro"] in spawned


def test_set_shares_validates_and_normalizes(tmp_path):
    d = tmp_path / "share"
    d.mkdir()
    fleet, _, _ = _fleet_with_shares(tmp_path, Shares(str(tmp_path / "s.json")))
    fleet.set_shares("web", [{"tag": "src", "host_path": str(d)}])
    assert fleet.get_shares("web") == [{"tag": "src", "host_path": str(d), "read_only": True}]
    with pytest.raises(RuntimeError, match="not found"):
        fleet.set_shares("web", [{"tag": "x", "host_path": str(tmp_path / "missing")}])
    with pytest.raises(RuntimeError, match="invalid share tag"):
        fleet.set_shares("web", [{"tag": "bad/tag", "host_path": str(d)}])
    with pytest.raises(RuntimeError, match="duplicate share tag"):
        fleet.set_shares("web", [{"tag": "src", "host_path": str(d)},
                                 {"tag": "src", "host_path": str(d)}])


def test_set_shares_rejects_golden(tmp_path):
    fleet, _, _ = _fleet_with_shares(tmp_path, Shares(str(tmp_path / "s.json")))
    with pytest.raises(RuntimeError, match="protected template"):
        fleet.set_shares("golden", [])


def test_rename_and_nuke_propagate_to_shares(tmp_path):
    shares = Shares(str(tmp_path / "s.json"))
    shares.set("mf-web", [{"tag": "src", "host_path": "/h", "read_only": True}])
    fleet, _, _ = _fleet_with_shares(tmp_path, shares)
    fleet.rename("web", "prod")
    assert shares.get("mf-prod") and shares.get("mf-web") == []
    fleet.nuke("prod")
    assert shares.get("mf-prod") == []
