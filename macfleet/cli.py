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
def reap() -> None:
    """Delete VMs whose TTL lease has expired."""
    for name in _fleet().reap():
        typer.echo(name)


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
def warm() -> None:
    """Boot mf-golden, wait for the guest, then suspend it so new VMs resume in ~2s
    instead of cold-booting. One-time (re-run after re-baking golden)."""
    typer.echo("Warming mf-golden (boot + wait for guest, then suspend)…")
    if _fleet().warm_golden():
        typer.echo("mf-golden is warm — new VMs now resume in ~2s")
    else:
        typer.echo("golden guest never became reachable; left running for inspection")
        raise typer.Exit(1)


@app.command()
def suspend(name: str) -> None:
    """Suspend mf-<name> (freeze running state)."""
    _fleet().suspend(name)


@app.command()
def resume(name: str) -> None:
    """Resume a suspended mf-<name>."""
    _fleet().resume(name)


@app.command()
def snapshot(name: str, label: str) -> None:
    """Snapshot mf-<name>; prints the snapshot id."""
    typer.echo(_fleet().snapshot(name, label))


@app.command()
def snapshots() -> None:
    """List snapshots."""
    for s in _fleet().snapshots():
        typer.echo(f"{s['id']:24} {s['size']}G")


@app.command()
def clone(snapshot_id: str, name: str) -> None:
    """Create mf-<name> from a snapshot (resumes captured state)."""
    _fleet().create(name, from_snapshot=snapshot_id)
    typer.echo(f"up: mf-{name}")


@app.command()
def rename(old: str, new: str) -> None:
    """Rename mf-<old> to mf-<new>."""
    _fleet().rename(old, new)


@app.command()
def duplicate(name: str, new: str) -> None:
    """Duplicate mf-<name> to mf-<new>."""
    _fleet().duplicate(name, new)


@app.command()
def exec(name: str, command: str) -> None:
    """Run a shell command in mf-<name> via the guest agent."""
    out = _fleet().exec(name, command)
    typer.echo(out["stdout"], nl=False)
    raise typer.Exit(out["exit_code"])


@app.command()
def connect(name: str) -> None:
    """Print how to connect to mf-<name>."""
    for k, v in _fleet().connection_info(name).items():
        typer.echo(f"{k}: {v}")


@app.command()
def serve(port: int = 8765) -> None:
    """Start the local API for the desktop app."""
    import os

    import uvicorn

    from macfleet.api import build_app

    uvicorn.run(build_app(token=os.environ.get("MACFLEET_API_TOKEN")),
                host="127.0.0.1", port=port)


if __name__ == "__main__":
    app()
