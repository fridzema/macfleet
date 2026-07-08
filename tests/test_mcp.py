from macfleet import mcp as M


class _NoOpActivity:
    def record(self, who, action, target):
        pass


class FakeFleet:
    def __init__(self):
        self.calls = []
        self.activity = _NoOpActivity()

    def list_vms(self):
        return [{"name": "mf-a", "state": "running", "healthy": True}]

    def create(self, name, from_snapshot=None, ttl=None):
        self.calls.append(("create", name, from_snapshot, ttl))

    def snapshot(self, name, label):
        self.calls.append(("snapshot", name, label))
        return f"{name}-{label}"

    def snapshots(self):
        return [{"id": "a-clean", "vm": "a", "label": "clean", "size": 2.0}]

    def exec(self, name, command):
        self.calls.append(("exec", name, command))
        return {"stdout": "hi", "exit_code": 0}

    def resources(self, name):
        return {"cpu": 4, "memory_mb": 8192, "disk_gb": 50, "display": "x", "state": "running"}


def test_list_vms_tool():
    assert M.mcp_list_vms(FakeFleet())[0]["name"] == "mf-a"


def test_create_vm_tool_maps_ttl_seconds():
    fake = FakeFleet()
    M.mcp_create_vm(fake, name="web", from_snapshot="base", ttl_seconds=60)
    assert ("create", "web", "base", 60) in fake.calls


def test_snapshot_tool_returns_id():
    assert M.mcp_snapshot(FakeFleet(), name="web", label="clean") == {"snapshot_id": "web-clean"}


def test_exec_tool_returns_output():
    assert M.mcp_exec(FakeFleet(), name="web", command="uname") == {"stdout": "hi", "exit_code": 0}


def test_build_server_registers_tools():
    server = M.build_server(FakeFleet())
    names = {t.name for t in server._tool_manager.list_tools()}
    assert {"list_vms", "create_vm", "snapshot", "exec"} <= names


def test_create_vm_records_activity(monkeypatch):
    monkeypatch.setenv("MACFLEET_AGENT", "claude-code")
    fake = FakeFleet()
    recorded = []
    fake.activity = type("A", (), {"record": lambda self, who, action, target: recorded.append((who, action, target))})()
    M.mcp_create_vm(fake, name="web")
    assert recorded == [("claude-code", "created", "web")]


def test_list_vms_does_not_record(monkeypatch):
    fake = FakeFleet()
    recorded = []
    fake.activity = type("A", (), {"record": lambda self, w, a, t: recorded.append((w, a, t))})()
    M.mcp_list_vms(fake)
    assert recorded == []


def test_who_defaults_to_agent(monkeypatch):
    monkeypatch.delenv("MACFLEET_AGENT", raising=False)
    assert M._who() == "agent"
