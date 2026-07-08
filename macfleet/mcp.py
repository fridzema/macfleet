from __future__ import annotations

import os

from mcp.server.fastmcp import FastMCP, Image

from macfleet.connect import Fleet


def _who() -> str:
    return os.environ.get("MACFLEET_AGENT", "agent")


# --- Tool logic (fleet-injected, unit-testable) ---------------------------------

def mcp_list_vms(fleet) -> list[dict]:
    return fleet.list_vms()


def mcp_create_vm(fleet, name: str, from_snapshot: str | None = None,
                  ttl_seconds: int | None = None) -> dict:
    fleet.create(name, from_snapshot=from_snapshot, ttl=ttl_seconds)
    fleet.activity.record(_who(), "created", name)
    return {"ok": True, "name": name}


def mcp_snapshot(fleet, name: str, label: str) -> dict:
    snapshot_id = fleet.snapshot(name, label)
    fleet.activity.record(_who(), "snapshotted", name)
    return {"snapshot_id": snapshot_id}


def mcp_exec(fleet, name: str, command: str) -> dict:
    result = fleet.exec(name, command)
    fleet.activity.record(_who(), "ran a command on", name)
    return result


# --- FastMCP server -------------------------------------------------------------

def build_server(fleet: Fleet | None = None) -> FastMCP:
    fleet = fleet or Fleet()
    mcp = FastMCP("macfleet")

    @mcp.tool()
    def list_vms() -> list[dict]:
        """List fleet VMs with state and health."""
        return mcp_list_vms(fleet)

    @mcp.tool()
    def create_vm(name: str, from_snapshot: str | None = None,
                  ttl_seconds: int | None = None) -> dict:
        """Create/clone a fleet VM and boot it. from_snapshot: a snapshot id from
        list_snapshots (resumes its captured state). ttl_seconds: auto-delete after N
        seconds (use for throwaway agent VMs)."""
        return mcp_create_vm(fleet, name, from_snapshot, ttl_seconds)

    @mcp.tool()
    def up(name: str) -> dict:
        """Boot a fleet VM (clone mf-golden if it doesn't exist)."""
        fleet.up(name)
        fleet.activity.record(_who(), "started", name)
        return {"ok": True}

    @mcp.tool()
    def down(name: str) -> dict:
        """Stop a fleet VM."""
        fleet.down(name)
        fleet.activity.record(_who(), "stopped", name)
        return {"ok": True}

    @mcp.tool()
    def suspend(name: str) -> dict:
        """Suspend a fleet VM (freeze running state to disk)."""
        fleet.suspend(name)
        fleet.activity.record(_who(), "suspended", name)
        return {"ok": True}

    @mcp.tool()
    def resume(name: str) -> dict:
        """Resume a suspended fleet VM."""
        fleet.resume(name)
        fleet.activity.record(_who(), "resumed", name)
        return {"ok": True}

    @mcp.tool()
    def delete_vm(name: str) -> dict:
        """Stop and permanently delete a fleet VM. Irreversible."""
        fleet.nuke(name)
        fleet.activity.record(_who(), "deleted", name)
        return {"ok": True}

    @mcp.tool()
    def rename_vm(name: str, new: str) -> dict:
        """Rename a fleet VM."""
        fleet.rename(name, new)
        fleet.activity.record(_who(), "renamed", name)
        return {"ok": True}

    @mcp.tool()
    def duplicate_vm(name: str, new: str) -> dict:
        """Duplicate a fleet VM (stateful copy of its current running state)."""
        fleet.duplicate(name, new)
        fleet.activity.record(_who(), "duplicated", name)
        return {"ok": True}

    @mcp.tool()
    def get_resources(name: str) -> dict:
        """Get a VM's cpu/memory/disk/display/state."""
        return fleet.resources(name)

    @mcp.tool()
    def set_resources(name: str, cpu: int | None = None, memory: int | None = None,
                      disk_size: int | None = None, display: str | None = None) -> dict:
        """Set a VM's resources. The VM must be stopped. Disk can only grow."""
        fleet.set_resources(name, cpu=cpu, memory=memory, disk_size=disk_size, display=display)
        fleet.activity.record(_who(), "resized", name)
        return {"ok": True}

    @mcp.tool()
    def snapshot(name: str, label: str) -> dict:
        """Snapshot a fleet VM's current state. Returns a snapshot id usable as
        create_vm(from_snapshot=...)."""
        return mcp_snapshot(fleet, name, label)

    @mcp.tool()
    def list_snapshots() -> list[dict]:
        """List snapshots."""
        return fleet.snapshots()

    @mcp.tool()
    def create_from_snapshot(snapshot_id: str, name: str, ttl_seconds: int | None = None) -> dict:
        """Create a new fleet VM from a snapshot; it resumes to the captured state."""
        fleet.create(name, from_snapshot=snapshot_id, ttl=ttl_seconds)
        fleet.activity.record(_who(), "created from snapshot", name)
        return {"ok": True, "name": name}

    @mcp.tool()
    def delete_snapshot(snapshot_id: str) -> dict:
        """Delete a snapshot. Irreversible."""
        fleet.delete_snapshot(snapshot_id)
        fleet.activity.record(_who(), "deleted snapshot", snapshot_id)
        return {"ok": True}

    @mcp.tool()
    def get_connection(name: str) -> dict:
        """Get connection info (ip, ssh command, vnc, guest server URL) for a VM."""
        return fleet.connection_info(name)

    @mcp.tool()
    def exec(name: str, command: str) -> dict:
        """Run a shell command inside a fleet VM via the guest agent. Returns
        {stdout, exit_code}. No SSH keys required."""
        return mcp_exec(fleet, name, command)

    if os.environ.get("MACFLEET_ALLOW_CONTROL") == "1":
        @mcp.tool()
        def screenshot(name: str) -> Image:
            """Capture the VM's screen as a PNG (computer-use)."""
            data = fleet.computer(name).screenshot()
            fleet.activity.record(_who(), "took a screenshot of", name)
            return Image(data=data, format="png")

        @mcp.tool()
        def click(name: str, x: int, y: int) -> dict:
            """Click at pixel (x, y) in the VM."""
            fleet.computer(name).click(x, y)
            fleet.activity.record(_who(), "clicked in", name)
            return {"ok": True}

        @mcp.tool()
        def type_text(name: str, text: str) -> dict:
            """Type text into the VM."""
            fleet.computer(name).type(text)
            fleet.activity.record(_who(), "typed into", name)
            return {"ok": True}

        @mcp.tool()
        def key(name: str, combo: str) -> dict:
            """Press a key/combo (e.g. 'cmd+space') in the VM."""
            fleet.computer(name).key(combo)
            fleet.activity.record(_who(), "pressed a key in", name)
            return {"ok": True}

    return mcp


def main() -> None:
    build_server().run()
