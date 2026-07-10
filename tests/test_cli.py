from typer.testing import CliRunner
import macfleet.cli as cli

runner = CliRunner()


class FakeFleet:
    def __init__(self):
        self.calls = []

    def up(self, name): self.calls.append(("up", name))
    def nuke(self, name): self.calls.append(("nuke", name))


def test_up_invokes_fleet(monkeypatch):
    fake = FakeFleet()
    monkeypatch.setattr(cli, "_fleet", lambda: fake)
    result = runner.invoke(cli.app, ["up", "web"])
    assert result.exit_code == 0
    assert ("up", "web") in fake.calls


def test_bake_prints_checklist():
    result = runner.invoke(cli.app, ["bake", "--help"])
    assert result.exit_code == 0


def test_resolve_api_token_uses_env_when_set():
    assert cli._resolve_api_token("supplied") == ("supplied", False)


def test_resolve_api_token_generates_when_unset_or_empty():
    for env in (None, ""):
        token, generated = cli._resolve_api_token(env)
        assert generated is True
        assert token  # non-empty, so the API is never left unauthenticated


def test_warm_command_success(monkeypatch):
    class FakeFleet:
        def warm_golden(self):
            return True

    monkeypatch.setattr(cli, "_fleet", lambda: FakeFleet())
    result = runner.invoke(cli.app, ["warm"])
    assert result.exit_code == 0
    assert "warm" in result.stdout.lower()


def test_warm_command_timeout_exits_nonzero(monkeypatch):
    class FakeFleet:
        def warm_golden(self):
            return False

    monkeypatch.setattr(cli, "_fleet", lambda: FakeFleet())
    result = runner.invoke(cli.app, ["warm"])
    assert result.exit_code == 1


def test_reap_command(monkeypatch):
    class FakeFleet:
        def reap(self):
            return ["mf-old", "mf-stale"]

    monkeypatch.setattr(cli, "_fleet", lambda: FakeFleet())
    result = runner.invoke(cli.app, ["reap"])
    assert result.exit_code == 0
    assert result.stdout == "mf-old\nmf-stale\n"


def test_restore_command(monkeypatch):
    calls = {}

    class FakeFleet:
        def restore(self, name, snapshot_id):
            calls["restore"] = (name, snapshot_id)

    monkeypatch.setattr(cli, "_fleet", lambda: FakeFleet())
    result = runner.invoke(cli.app, ["restore", "web", "web-clean"])
    assert result.exit_code == 0
    assert calls["restore"] == ("web", "web-clean")


def test_snapshot_command(monkeypatch):
    calls = {}

    class FakeFleet:
        tart = None
        def snapshot(self, name, label):
            calls["snap"] = (name, label)
            return f"{name}-{label}"

    monkeypatch.setattr(cli, "_fleet", lambda: FakeFleet())
    result = runner.invoke(cli.app, ["snapshot", "web", "clean"])
    assert result.exit_code == 0
    assert calls["snap"] == ("web", "clean")
    assert "web-clean" in result.stdout


def test_restart_command(monkeypatch):
    calls = {}

    class FakeFleet:
        def restart(self, name):
            calls["restart"] = name

    monkeypatch.setattr(cli, "_fleet", lambda: FakeFleet())
    result = runner.invoke(cli.app, ["restart", "web"])
    assert result.exit_code == 0
    assert calls["restart"] == "web"
