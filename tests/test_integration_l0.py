from fastapi.testclient import TestClient
from macfleet.api import build_app
from macfleet.connect import Fleet
from macfleet.vm import Tart
import subprocess


def scripted_tart(state):
    import json

    def run(argv):
        if argv[:2] == ["tart", "list"]:
            return subprocess.CompletedProcess(argv, 0, json.dumps(state), "")
        return subprocess.CompletedProcess(argv, 0, "", "")
    return Tart(run=run)


def test_l0_list_then_up(monkeypatch):
    state = [{"Name": "mf-golden", "State": "stopped", "Source": "oci"}]
    fleet = Fleet(tart=scripted_tart(state))
    monkeypatch.setattr(fleet, "status", lambda name: False)
    # avoid launching a real `tart run` subprocess
    monkeypatch.setattr(fleet, "up", lambda name: state.append(
        {"Name": f"mf-{name}", "State": "running", "Source": "local"}))
    client = TestClient(build_app(fleet))

    assert len(client.get("/vms").json()) == 1
    assert client.post("/vms/web/up").json() == {"ok": True}
    fleet._invalidate_fleet()
    names = [v["name"] for v in client.get("/vms").json()]
    assert "mf-web" in names
