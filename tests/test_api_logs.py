from fastapi.testclient import TestClient
from macfleet.api import build_app
from macfleet.connect import Fleet
from macfleet.vm import Tart
import subprocess


def fake_tart(name="mf-a"):
    import json

    def run(argv):
        if argv[:2] == ["tart", "list"]:
            out = json.dumps([{"Name": name, "State": "running", "Source": "local"}])
        elif argv[:2] == ["tart", "ip"]:
            out = "192.168.64.4"  # a running VM has an IP; ip() now raises on empty
        else:
            out = ""
        return subprocess.CompletedProcess(argv, 0, out, "")
    return Tart(run=run)


def test_logs_endpoint_returns_tail():
    # Fleet.ssh is exercised through an injected runner that returns canned log text.
    def run(argv):
        if argv[0] == "ssh":
            return subprocess.CompletedProcess(argv, 0, "line1\nline2\n", "")
        return subprocess.CompletedProcess(argv, 0, "192.168.64.4\n", "")
    fleet = Fleet(tart=fake_tart(), run=run)
    client = TestClient(build_app(fleet))
    r = client.get("/vms/a/logs?lines=50")
    assert r.status_code == 200
    assert r.json() == {"lines": "line1\nline2\n"}


def test_logs_endpoint_maps_runtime_error_to_409_with_cors():
    # A non-fleet / stopped VM makes the guest unreachable -> ssh raises RuntimeError. The
    # route must return a clean 409 (not a bare 500), so the CORS header survives the middleware.
    def run(argv):
        raise RuntimeError("ssh: connect to host failed")
    fleet = Fleet(tart=fake_tart(), run=run)
    client = TestClient(build_app(fleet))
    r = client.get("/vms/cua-tahoe/logs?lines=100", headers={"Origin": "http://localhost:1420"})
    assert r.status_code == 409
    assert r.headers.get("access-control-allow-origin") == "http://localhost:1420"


def test_cors_header_present():
    fleet = Fleet(tart=fake_tart(), run=lambda argv: subprocess.CompletedProcess(argv, 0, "[]", ""))
    client = TestClient(build_app(fleet))
    r = client.get("/vms", headers={"Origin": "tauri://localhost"})
    assert r.headers.get("access-control-allow-origin") == "tauri://localhost"
