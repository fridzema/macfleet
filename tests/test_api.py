import base64

from fastapi.testclient import TestClient

from macfleet.api import build_app
from macfleet.vm import VmInfo


class FakeComputer:
    def screenshot(self):
        return b"PNGBYTES"


class FakeFleet:
    def __init__(self, vms=None, healthy=("a",), computer_obj=None, computer_error=None,
                 up_error=None):
        self.tart = self
        self.calls = []
        self._vms = list(vms) if vms is not None else [VmInfo("mf-a", "running", "local")]
        self._healthy = set(healthy)
        self._computer_obj = computer_obj
        self._computer_error = computer_error
        self._up_error = up_error
        self.set_resources_error = None

    def list(self):  # stands in for tart.list()
        return self._vms

    def status(self, name):
        return name in self._healthy

    def list_vms(self):
        return [
            {"name": "mf-a", "state": "running", "source": "local", "healthy": True},
            {"name": "mf-b", "state": "stopped", "source": "local", "healthy": False},
        ]

    def up(self, name):
        if self._up_error is not None:
            raise self._up_error
        self.calls.append(("up", name))

    def down(self, name):
        self.calls.append(("down", name))

    def restore(self, name, snapshot_id):
        self.calls.append(("restore", name, snapshot_id))

    def nuke(self, name):
        self.calls.append(("nuke", name))

    def computer(self, name):
        if self._computer_error is not None:
            raise self._computer_error
        return self._computer_obj

    def create(self, name, from_snapshot=None, ttl=None, cpu=None, memory=None, disk=None):
        self.calls.append(("create", name, from_snapshot, ttl, cpu, memory, disk))

    def host_info(self):
        return {"total_mem_gb": 32, "cpu_count": 10, "name": "test-host"}

    def suspend(self, name):
        self.calls.append(("suspend", name))

    def resume(self, name):
        self.calls.append(("resume", name))

    def snapshot(self, name, label):
        self.calls.append(("snapshot", name, label))
        return f"{name}-{label}"

    def snapshots(self):
        return [{"id": "web-clean", "vm": "web", "label": "clean", "size": 1.0}]

    def delete_snapshot(self, sid):
        self.calls.append(("delete_snapshot", sid))

    def rename(self, old, new):
        self.calls.append(("rename", old, new))

    def duplicate(self, name, new):
        self.calls.append(("duplicate", name, new))

    def resources(self, name):
        return {"cpu": 4, "memory_mb": 8192, "disk_gb": 50, "display": "x", "state": "stopped"}

    def set_resources(self, name, cpu=None, memory=None, disk_size=None, display=None):
        if self.set_resources_error:
            raise self.set_resources_error
        self.calls.append(("set_resources", name, cpu, memory, disk_size, display))

    def connection_info(self, name):
        return {"ip": "1.2.3.4", "ssh": "ssh admin@1.2.3.4", "vnc": "open vnc://admin@1.2.3.4",
                "guest_server": "http://1.2.3.4:8000", "exec": True}

    def exec(self, name, command):
        return {"stdout": "ok", "exit_code": 0}

    def reap(self):
        self.calls.append(("reap",))
        return ["mf-old"]

    def activity_recent(self, limit=20):
        return [{"who": "claude-code", "action": "created", "target": "web", "ts": 5.0}][:limit]

    def metrics(self, name):
        return {"cpu_pct": 25.5, "mem_used_mb": 8029, "mem_total_mb": 8192}


def test_list_vms_delegates_to_fleet():
    # Health-marking logic itself is covered by Fleet.list_vms tests (test_connect.py);
    # the route is a thin passthrough to fleet.list_vms().
    client = TestClient(build_app(FakeFleet()))
    r = client.get("/vms")
    assert r.status_code == 200
    assert r.json() == FakeFleet().list_vms()
    body = r.json()
    assert body[0]["healthy"] is True   # running VM stays healthy
    assert body[1]["healthy"] is False  # stopped VM stays unhealthy


def test_up_endpoint():
    fake = FakeFleet()
    r = TestClient(build_app(fake)).post("/vms/web/up")
    assert r.status_code == 200
    assert ("up", "web") in fake.calls


def test_up_missing_golden_returns_409_with_cors():
    # `tart clone mf-golden ...` fails when the golden image isn't baked -> RuntimeError.
    # The app-level handler must turn it into a 409 that still carries the CORS header,
    # not a bare 500 (which drops CORS and shows up as an unhandled fetch error).
    fake = FakeFleet(up_error=RuntimeError('tart clone mf-golden mf-test failed: does not exist'))
    r = TestClient(build_app(fake)).post("/vms/test/up", headers={"Origin": "http://localhost:1420"})
    assert r.status_code == 409
    assert r.headers.get("access-control-allow-origin") == "http://localhost:1420"
    assert "mf-golden" in r.json()["detail"]


def test_down_endpoint():
    fake = FakeFleet()
    assert TestClient(build_app(fake)).post("/vms/web/down").json() == {"ok": True}
    assert ("down", "web") in fake.calls


def test_nuke_endpoint():
    fake = FakeFleet()
    assert TestClient(build_app(fake)).post("/vms/web/nuke").json() == {"ok": True}
    assert ("nuke", "web") in fake.calls


def test_status_endpoint():
    fake = FakeFleet(healthy=("web",))
    assert TestClient(build_app(fake)).get("/vms/web/status").json() == {"healthy": True}


def test_screenshot_success_returns_b64():
    fake = FakeFleet(computer_obj=FakeComputer())
    r = TestClient(build_app(fake)).post("/vms/web/screenshot")
    assert r.status_code == 200
    assert base64.b64decode(r.json()["png_b64"]) == b"PNGBYTES"


def test_screenshot_disabled_returns_409():
    fake = FakeFleet(computer_error=RuntimeError("computer-use disabled — set MACFLEET_ALLOW_CONTROL=1"))
    r = TestClient(build_app(fake)).post("/vms/web/screenshot")
    assert r.status_code == 409


def test_create_from_snapshot_with_ttl():
    fake = FakeFleet()
    r = TestClient(build_app(fake)).post("/vms", json={"name": "web", "from_snapshot": "base", "ttl": 60})
    assert r.status_code == 200
    assert ("create", "web", "base", 60, None, None, None) in fake.calls


def test_create_with_resource_preset_forwards_to_fleet():
    fake = FakeFleet()
    r = TestClient(build_app(fake)).post(
        "/vms", json={"name": "web", "cpu": 4, "memory": 8192, "disk": 100}
    )
    assert r.status_code == 200
    assert ("create", "web", None, None, 4, 8192, 100) in fake.calls


def test_host_endpoint():
    fake = FakeFleet()
    r = TestClient(build_app(fake)).get("/host")
    assert r.status_code == 200
    assert r.json() == {"total_mem_gb": 32, "cpu_count": 10, "name": "test-host"}


def test_suspend_resume_endpoints():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    assert client.post("/vms/web/suspend").json() == {"ok": True}
    assert client.post("/vms/web/resume").json() == {"ok": True}
    assert ("suspend", "web") in fake.calls and ("resume", "web") in fake.calls


def test_snapshot_endpoints():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    assert client.post("/vms/web/snapshot", json={"label": "clean"}).json() == {"snapshot_id": "web-clean"}
    assert client.get("/snapshots").json() == [{"id": "web-clean", "vm": "web", "label": "clean", "size": 1.0}]
    assert client.delete("/snapshots/web-clean").json() == {"ok": True}


def test_rename_duplicate_endpoints():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    assert client.post("/vms/web/rename", json={"new": "prod"}).json() == {"ok": True}
    assert client.post("/vms/web/duplicate", json={"new": "web2"}).json() == {"ok": True}


def test_resources_endpoints_and_409_when_running():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    assert client.get("/vms/web/resources").json()["cpu"] == 4
    assert client.put("/vms/web/resources", json={"cpu": 8}).json() == {"ok": True}
    fake.set_resources_error = RuntimeError("stop the VM before changing resources")
    assert client.put("/vms/web/resources", json={"cpu": 8}).status_code == 409


def test_connection_and_exec_endpoints():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    assert client.get("/vms/web/connection").json()["ssh"] == "ssh admin@1.2.3.4"
    assert client.post("/vms/web/exec", json={"command": "uname"}).json() == {"stdout": "ok", "exit_code": 0}


def test_reap_endpoint():
    fake = FakeFleet()
    r = TestClient(build_app(fake)).post("/reap")
    assert r.status_code == 200
    assert r.json() == {"reaped": ["mf-old"]}
    assert ("reap",) in fake.calls


def test_agents_activity_endpoint():
    r = TestClient(build_app(FakeFleet())).get("/agents/activity?limit=5")
    assert r.status_code == 200
    assert r.json()[0]["who"] == "claude-code"


def test_metrics_endpoint():
    r = TestClient(build_app(FakeFleet())).get("/vms/web/metrics")
    assert r.json() == {"cpu_pct": 25.5, "mem_used_mb": 8029, "mem_total_mb": 8192}


def test_cors_allows_tauri_origin_and_denies_others():
    client = TestClient(build_app(FakeFleet()))
    ok = client.get("/vms", headers={"Origin": "http://localhost:1420"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:1420"
    bad = client.get("/vms", headers={"Origin": "https://evil.example"})
    assert bad.headers.get("access-control-allow-origin") is None


def test_token_required_on_mutating_route():
    fake = FakeFleet()
    client = TestClient(build_app(fake, token="secret"))
    # No token -> 401, and the mutating op never reached Fleet.
    r = client.post("/vms/web/nuke")
    assert r.status_code == 401
    assert ("nuke", "web") not in fake.calls
    # Wrong token -> 401.
    assert client.post("/vms/web/nuke", headers={"X-Macfleet-Token": "nope"}).status_code == 401
    # Correct token -> passes through.
    assert client.post("/vms/web/nuke", headers={"X-Macfleet-Token": "secret"}).status_code == 200
    assert ("nuke", "web") in fake.calls


def test_token_required_on_reads_too():
    # GET /vms triggers reap() (a side effect), so reads are guarded as well.
    client = TestClient(build_app(FakeFleet(), token="secret"))
    assert client.get("/vms").status_code == 401
    assert client.get("/vms", headers={"X-Macfleet-Token": "secret"}).status_code == 200


def test_token_disabled_when_unset():
    # Default (no token) keeps the API unauthenticated for CLI/dev use.
    fake = FakeFleet()
    assert TestClient(build_app(fake)).post("/vms/web/nuke").status_code == 200


def test_restore_endpoint_calls_fleet():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    r = client.post("/vms/web/restore", json={"snapshot_id": "web-clean"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert ("restore", "web", "web-clean") in fake.calls
