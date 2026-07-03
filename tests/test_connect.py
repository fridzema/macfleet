import subprocess
import pytest
from macfleet.connect import ssh_cmd, scp_push_cmd, Fleet, SSH_OPTS
from macfleet.vm import Tart


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
