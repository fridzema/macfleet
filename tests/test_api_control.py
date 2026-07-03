# tests/test_api_control.py
from fastapi.testclient import TestClient
from macfleet.api import build_app
from macfleet.vm import VmInfo


class FakeComputer:
    def __init__(self):
        self.events = []

    def click(self, x, y):
        self.events.append(("click", x, y))

    def type(self, text):
        self.events.append(("type", text))

    def key(self, combo):
        self.events.append(("key", combo))


class FakeFleet:
    def __init__(self, computer_obj=None, computer_error=None):
        self.tart = self
        self._computer_obj = computer_obj
        self._computer_error = computer_error

    def list(self):
        return [VmInfo("mf-a", "running", "local")]

    def status(self, name):
        return True

    def computer(self, name):
        if self._computer_error is not None:
            raise self._computer_error
        return self._computer_obj


def test_click_forwards_coords():
    comp = FakeComputer()
    client = TestClient(build_app(FakeFleet(computer_obj=comp)))
    r = client.post("/vms/web/click", json={"x": 12, "y": 34})
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert ("click", 12, 34) in comp.events


def test_type_forwards_text():
    comp = FakeComputer()
    client = TestClient(build_app(FakeFleet(computer_obj=comp)))
    assert client.post("/vms/web/type", json={"text": "hi"}).status_code == 200
    assert ("type", "hi") in comp.events


def test_key_forwards_combo():
    comp = FakeComputer()
    client = TestClient(build_app(FakeFleet(computer_obj=comp)))
    assert client.post("/vms/web/key", json={"combo": "cmd+s"}).status_code == 200
    assert ("key", "cmd+s") in comp.events


def test_click_returns_409_when_control_disabled():
    fleet = FakeFleet(computer_error=RuntimeError("computer-use disabled — set MACFLEET_ALLOW_CONTROL=1"))
    client = TestClient(build_app(fleet))
    assert client.post("/vms/web/click", json={"x": 1, "y": 2}).status_code == 409
