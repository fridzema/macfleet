from fastapi.testclient import TestClient
from macfleet.api import build_app
from macfleet.vm import VmInfo


class FakeFleet:
    def __init__(self):
        self.tart = self
        self.calls = []

    def list(self):  # stands in for tart.list()
        return [VmInfo("mf-a", "running", "local")]

    def status(self, name):
        return name == "a"

    def up(self, name):
        self.calls.append(("up", name))


def test_list_vms_marks_health():
    client = TestClient(build_app(FakeFleet()))
    r = client.get("/vms")
    assert r.status_code == 200
    body = r.json()
    assert body[0]["name"] == "mf-a"
    assert body[0]["healthy"] is True


def test_up_endpoint():
    fake = FakeFleet()
    client = TestClient(build_app(fake))
    r = client.post("/vms/web/up")
    assert r.status_code == 200
    assert ("up", "web") in fake.calls
