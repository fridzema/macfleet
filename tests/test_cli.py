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


def test_reap_command(monkeypatch):
    class FakeFleet:
        def reap(self):
            return ["mf-old", "mf-stale"]

    monkeypatch.setattr(cli, "_fleet", lambda: FakeFleet())
    result = runner.invoke(cli.app, ["reap"])
    assert result.exit_code == 0
    assert result.stdout == "mf-old\nmf-stale\n"


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
