import json
import subprocess
from macfleet.vm import Tart, VmInfo, fullname, shortname


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
