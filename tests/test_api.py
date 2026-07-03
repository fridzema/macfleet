import base64

from fastapi.testclient import TestClient

from macfleet.api import build_app
from macfleet.vm import VmInfo


class FakeComputer:
    def screenshot(self):
        return b"PNGBYTES"


class FakeFleet:
    def __init__(self, vms=None, healthy=("a",), computer_obj=None, computer_error=None):
        self.tart = self
        self.calls = []
        self._vms = list(vms) if vms is not None else [VmInfo("mf-a", "running", "local")]
        self._healthy = set(healthy)
        self._computer_obj = computer_obj
        self._computer_error = computer_error

    def list(self):  # stands in for tart.list()
        return self._vms

    def status(self, name):
        return name in self._healthy

    def up(self, name):
        self.calls.append(("up", name))

    def down(self, name):
        self.calls.append(("down", name))

    def nuke(self, name):
        self.calls.append(("nuke", name))

    def computer(self, name):
        if self._computer_error is not None:
            raise self._computer_error
        return self._computer_obj


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
