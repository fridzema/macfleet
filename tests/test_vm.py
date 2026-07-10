import json
import subprocess
import pytest
from macfleet.vm import Tart, VmInfo, _run, _run_nocheck, fullname, shortname


def fake_runner(script):
    def run(argv):
        out = script(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")
    return run


def test_name_helpers():
    assert fullname("web") == "mf-web"
    assert fullname("mf-web") == "mf-web"
    assert shortname("mf-web") == "web"


def test_list_parses_json():
    payload = json.dumps([
        {"Name": "mf-golden", "State": "stopped", "Source": "oci"},
        {"Name": "mf-a", "State": "running", "Source": "local"},
    ])
    t = Tart(run=fake_runner(lambda argv: payload))
    assert t.list() == [
        VmInfo("mf-golden", "stopped", "oci"),
        VmInfo("mf-a", "running", "local"),
    ]


def test_clone_builds_command():
    seen = []
    t = Tart(run=fake_runner(lambda argv: (seen.append(argv), "")[1]))
    t.clone("mf-golden", "mf-a")
    assert seen[-1] == ["tart", "clone", "mf-golden", "mf-a"]


def test_ip_strips_whitespace():
    t = Tart(run=fake_runner(lambda argv: "192.168.64.4\n"))
    assert t.ip("mf-a") == "192.168.64.4"


def _capture():
    calls = []

    def run(argv):
        calls.append(argv)
        if argv[:2] == ["tart", "get"]:
            return subprocess.CompletedProcess(argv, 0, '{"CPU":4,"Memory":8192,"Disk":50,"Display":"1024x768","State":"stopped"}', "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    return calls, run


def test_suspend_and_rename_argv():
    calls, run = _capture()
    t = Tart(run=run)
    t.suspend("mf-a")
    t.rename("mf-a", "mf-b")
    assert ["tart", "suspend", "mf-a"] in calls
    assert ["tart", "rename", "mf-a", "mf-b"] in calls


def test_set_config_only_passes_given_flags():
    calls, run = _capture()
    Tart(run=run).set_config("mf-a", cpu=6, disk_size=80)
    assert calls[-1] == ["tart", "set", "mf-a", "--cpu", "6", "--disk-size", "80"]


def test_get_config_parses_json():
    _, run = _capture()
    cfg = Tart(run=run).get_config("mf-a")
    assert cfg["CPU"] == 4 and cfg["Memory"] == 8192 and cfg["State"] == "stopped"


def test_list_includes_size():
    def run(argv):
        return subprocess.CompletedProcess(argv, 0, '[{"Name":"mf-a","State":"running","Source":"local","Size":"12.5"}]', "")
    assert Tart(run=run).list()[0].size == 12.5


def test_run_nocheck_returns_nonzero_without_raising():
    # patch subprocess.run indirectly by calling a command that exits 1
    proc = _run_nocheck(["sh", "-c", "printf out; exit 3"])
    assert proc.returncode == 3 and proc.stdout == "out"


def test_run_passes_timeout_and_raises_on_expiry(monkeypatch):
    seen = {}

    def fake_run(argv, **kwargs):
        seen.update(kwargs)
        raise subprocess.TimeoutExpired(argv, kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="timed out"):
        _run(["tart", "exec", "mf-a", "sleep", "999"], timeout=5)
    assert seen["timeout"] == 5


def test_run_nocheck_raises_on_timeout():
    # A hung command is a genuine failure even though nonzero exits are not — it must not
    # return normally and pin a worker. Real child so the Popen+select timeout path is exercised.
    with pytest.raises(RuntimeError, match="timed out"):
        _run_nocheck(["sleep", "2"], timeout=0.3)


def test_run_nocheck_caps_stdout():
    # A firehose (`yes` prints forever) must be bounded, not buffered into memory unbounded.
    proc = _run_nocheck(["yes"], timeout=5, max_bytes=1000)
    assert len(proc.stdout.encode()) <= 1000 + 65536  # cap + at most one read chunk
    assert proc.returncode != 0  # killed once the ceiling was hit
