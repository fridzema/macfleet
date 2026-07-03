from __future__ import annotations

import typer

from macfleet.connect import Fleet
from macfleet.provision import bake_steps

app = typer.Typer(help="macfleet — a fleet of macOS VMs, SSH-managed + computer-use-driven")


def _fleet() -> Fleet:
    return Fleet()


@app.command()
def up(name: str) -> None:
    """Clone mf-golden -> mf-<name> and boot it."""
    _fleet().up(name)
    typer.echo(f"up: mf-{name}")


@app.command()
def down(name: str) -> None:
    """Stop mf-<name>."""
    _fleet().down(name)


@app.command()
def nuke(name: str) -> None:
    """Stop + delete mf-<name>."""
    _fleet().nuke(name)


@app.command()
def ls() -> None:
    """List fleet VMs."""
    for v in _fleet().tart.list():
        typer.echo(f"{v.state:8} {v.name}")


@app.command()
def ssh(name: str, cmd: str) -> None:
    """Run a command on mf-<name> over SSH."""
    typer.echo(_fleet().ssh(name, cmd))


@app.command()
def bake() -> None:
    """Print the golden-image bake checklist (one-time TCC step included)."""
    for i, step in enumerate(bake_steps(), 1):
        typer.echo(f"{i}. {step}")


@app.command()
def serve(port: int = 8765) -> None:
    """Start the local API for the desktop app."""
    import uvicorn

    from macfleet.api import build_app

    uvicorn.run(build_app(), host="127.0.0.1", port=port)


if __name__ == "__main__":
    app()
