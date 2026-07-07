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

    def up(self, name):
        if self._up_error is not None:
            raise self._up_error
        self.calls.append(("up", name))

    def down(self, name):
        self.calls.append(("down", name))

    def nuke(self, name):
        self.calls.append(("nuke", name))

    def computer(self, name):
        if self._computer_error is not None:
            raise self._computer_error
        return self._computer_obj

    def create(self, name, from_snapshot=None, ttl=None):
        self.calls.append(("create", name, from_snapshot, ttl))

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


def test_list_vms_marks_health():
    client = TestClient(build_app(FakeFleet()))
    r = client.get("/vms")
    assert r.status_code == 200
    body = r.json()
    assert body[0]["name"] == "mf-a"
    assert body[0]["healthy"] is True


def test_list_marks_non_running_unhealthy():
    fleet = FakeFleet(vms=[VmInfo("mf-b", "stopped", "local")], healthy=("b",))
    body = TestClient(build_app(fleet)).get("/vms").json()
    assert body[0]["healthy"] is False


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
    assert r.headers.get("access-control-allow-origin") == "*"
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
    assert ("create", "web", "base", 60) in fake.calls


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
