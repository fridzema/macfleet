from __future__ import annotations

import os

from mcp.server.fastmcp import FastMCP, Image

from macfleet.connect import Fleet


# --- Tool logic (fleet-injected, unit-testable) ---------------------------------

def mcp_list_vms(fleet) -> list[dict]:
    return fleet.list_vms()


def mcp_create_vm(fleet, name: str, from_snapshot: str | None = None,
                  ttl_seconds: int | None = None) -> dict:
    fleet.create(name, from_snapshot=from_snapshot, ttl=ttl_seconds)
    return {"ok": True, "name": name}


def mcp_snapshot(fleet, name: str, label: str) -> dict:
    return {"snapshot_id": fleet.snapshot(name, label)}


def mcp_exec(fleet, name: str, command: str) -> dict:
    return fleet.exec(name, command)


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
        return {"ok": True}

    @mcp.tool()
    def down(name: str) -> dict:
        """Stop a fleet VM."""
        fleet.down(name)
        return {"ok": True}

    @mcp.tool()
    def suspend(name: str) -> dict:
        """Suspend a fleet VM (freeze running state to disk)."""
        fleet.suspend(name)
        return {"ok": True}

    @mcp.tool()
    def resume(name: str) -> dict:
        """Resume a suspended fleet VM."""
        fleet.resume(name)
        return {"ok": True}

    @mcp.tool()
    def delete_vm(name: str) -> dict:
        """Stop and permanently delete a fleet VM. Irreversible."""
        fleet.nuke(name)
        return {"ok": True}

    @mcp.tool()
    def rename_vm(name: str, new: str) -> dict:
        """Rename a fleet VM."""
        fleet.rename(name, new)
        return {"ok": True}

    @mcp.tool()
    def duplicate_vm(name: str, new: str) -> dict:
        """Duplicate a fleet VM (stateful copy of its current running state)."""
        fleet.duplicate(name, new)
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
        return mcp_create_vm(fleet, name, snapshot_id, ttl_seconds)

    @mcp.tool()
    def delete_snapshot(snapshot_id: str) -> dict:
        """Delete a snapshot. Irreversible."""
        fleet.delete_snapshot(snapshot_id)
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
            return Image(data=fleet.computer(name).screenshot(), format="png")

        @mcp.tool()
        def click(name: str, x: int, y: int) -> dict:
            """Click at pixel (x, y) in the VM."""
            fleet.computer(name).click(x, y)
            return {"ok": True}

        @mcp.tool()
        def type_text(name: str, text: str) -> dict:
            """Type text into the VM."""
            fleet.computer(name).type(text)
            return {"ok": True}

        @mcp.tool()
        def key(name: str, combo: str) -> dict:
            """Press a key/combo (e.g. 'cmd+space') in the VM."""
            fleet.computer(name).key(combo)
            return {"ok": True}

    return mcp


def main() -> None:
    build_server().run()
