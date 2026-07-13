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


def test_logs_endpoint_returns_incremental_tail(monkeypatch):
    fleet = Fleet(tart=fake_tart())
    guest = type("Guest", (), {
        "logs": lambda self, lines, cursor: {"lines": "line1\nline2\n", "cursor": 42}
    })()
    monkeypatch.setattr(fleet, "_guest_client", lambda name: guest)
    client = TestClient(build_app(fleet))
    r = client.get("/vms/a/logs?lines=50")
    assert r.status_code == 200
    assert r.json() == {"lines": "line1\nline2\n", "cursor": 42}


def test_logs_endpoint_rejects_unbounded_line_counts():
    client = TestClient(build_app(Fleet(tart=fake_tart())))
    assert client.get("/vms/a/logs?lines=0").status_code == 422
    assert client.get("/vms/a/logs?lines=5001").status_code == 422
    assert client.get("/vms/a/logs?cursor=-1").status_code == 422


def test_logs_endpoint_maps_runtime_error_to_409_with_cors(monkeypatch):
    # A non-fleet / stopped VM makes the guest unreachable. The
    # route must return a clean 409 (not a bare 500), so the CORS header survives the middleware.
    fleet = Fleet(tart=fake_tart())
    monkeypatch.setattr(
        fleet, "_guest_client",
        lambda name: (_ for _ in ()).throw(RuntimeError("guest connection failed")),
    )
    client = TestClient(build_app(fleet))
    r = client.get("/vms/cua-tahoe/logs?lines=100", headers={"Origin": "http://localhost:1420"})
    assert r.status_code == 409
    assert r.headers.get("access-control-allow-origin") == "http://localhost:1420"


def test_cors_header_present():
    fleet = Fleet(tart=fake_tart(), run=lambda argv: subprocess.CompletedProcess(argv, 0, "[]", ""))
    client = TestClient(build_app(fleet))
    r = client.get("/vms", headers={"Origin": "tauri://localhost"})
    assert r.headers.get("access-control-allow-origin") == "tauri://localhost"
