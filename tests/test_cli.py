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
