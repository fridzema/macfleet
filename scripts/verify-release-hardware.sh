#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_dir}"

check_vm="releasecheck"
check_copy="releasecopy"
check_snapshot="releasecheck-ready"

local_vm_exists() {
  # Do not use grep -q here: with pipefail it may close the pipe early, making tart's
  # otherwise-successful listing look like a failure because of SIGPIPE.
  tart list --source local --quiet | grep -Fx "$1" >/dev/null
}

cleanup() {
  set +e
  for _attempt in 1 2 3; do
    local_vm_exists "mf-${check_copy}" || break
    uv run macfleet nuke "${check_copy}" >/dev/null 2>&1
    sleep 2
  done
  for _attempt in 1 2 3; do
    local_vm_exists "mfsnap-${check_snapshot}" || break
    MACFLEET_RELEASE_SNAPSHOT_ID="${check_snapshot}" uv run python -c \
      'import os; from macfleet.connect import Fleet; Fleet().delete_snapshot(os.environ["MACFLEET_RELEASE_SNAPSHOT_ID"])' \
      >/dev/null 2>&1
    sleep 2
  done
  for _attempt in 1 2 3; do
    local_vm_exists "mf-${check_vm}" || break
    uv run macfleet nuke "${check_vm}" >/dev/null 2>&1
    sleep 2
  done
}

trap cleanup EXIT
trap 'exit 130' INT TERM

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "hardware check requires an Apple-silicon Mac" >&2
  exit 1
fi
command -v tart >/dev/null 2>&1 || { echo "tart is not installed" >&2; exit 1; }
local_vm_exists mf-golden || { echo "mf-golden is missing; run scripts/bake.sh" >&2; exit 1; }

for candidate in "mf-${check_vm}" "mf-${check_copy}" "mfsnap-${check_snapshot}"; do
  if local_vm_exists "${candidate}"; then
    echo "refusing to overwrite pre-existing ${candidate}" >&2
    exit 1
  fi
done

echo "L1: tart $(tart --version), mf-golden present"

echo "L2: clone, boot, SSH, guest exec, computer-use readiness, and snapshot"
uv run macfleet up "${check_vm}"
uv run macfleet ssh "${check_vm}" "sw_vers -productVersion"
uv run macfleet exec "${check_vm}" "sw_vers"
MACFLEET_RELEASE_VM="${check_vm}" MACFLEET_ALLOW_CONTROL=1 uv run python - <<'PY'
import os
import time

from macfleet.connect import Fleet


deadline = time.monotonic() + 180
last_error: Exception | None = None
while time.monotonic() < deadline:
    try:
        screenshot = Fleet().computer(os.environ["MACFLEET_RELEASE_VM"]).screenshot()
        if screenshot.startswith(b"\x89PNG\r\n\x1a\n"):
            print(f"computer-use ready: {len(screenshot)}-byte PNG")
            break
        last_error = RuntimeError("screenshot response was not a PNG")
    except RuntimeError as exc:
        last_error = exc
    time.sleep(3)
else:
    raise RuntimeError(f"computer-use did not become ready within 180s: {last_error}")
PY
uv run macfleet snapshot "${check_vm}" ready

echo "L3: MCP stdio, snapshot clone, guest exec, screenshot, and delete"
MACFLEET_RELEASE_VM="${check_vm}" \
MACFLEET_RELEASE_COPY="${check_copy}" \
MACFLEET_RELEASE_SNAPSHOT_ID="${check_snapshot}" \
MACFLEET_ALLOW_CONTROL=1 \
uv run --extra mcp python - <<'PY'
import asyncio
import os

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def require_ok(tool: str, result) -> None:
    if result.isError:
        raise RuntimeError(f"MCP {tool} failed: {result.content}")


async def main() -> None:
    server = StdioServerParameters(
        command="uv",
        args=["run", "--extra", "mcp", "macfleet-mcp"],
        env={**os.environ, "MACFLEET_AGENT": "release-check"},
    )
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            result = await session.call_tool("list_vms")
            require_ok("list_vms", result)

            result = await session.call_tool(
                "create_from_snapshot",
                {
                    "snapshot_id": os.environ["MACFLEET_RELEASE_SNAPSHOT_ID"],
                    "name": os.environ["MACFLEET_RELEASE_COPY"],
                },
            )
            require_ok("create_from_snapshot", result)
            created = True
            try:
                result = await session.call_tool(
                    "exec",
                    {"name": os.environ["MACFLEET_RELEASE_COPY"], "command": "uptime"},
                )
                require_ok("exec", result)

                # A restored macOS session can accept tart exec before its window server
                # and screenshot backend are ready. Keep the release gate bounded while
                # allowing that normal startup gap.
                for _attempt in range(10):
                    result = await session.call_tool(
                        "screenshot", {"name": os.environ["MACFLEET_RELEASE_COPY"]}
                    )
                    if not result.isError:
                        break
                    await asyncio.sleep(3)
                require_ok("screenshot", result)
                images = [
                    block for block in result.content if getattr(block, "type", None) == "image"
                ]
                if not images or not images[0].data:
                    raise RuntimeError("MCP screenshot returned no image data")
            finally:
                if created:
                    result = await session.call_tool(
                        "delete_vm", {"name": os.environ["MACFLEET_RELEASE_COPY"]}
                    )
                    require_ok("delete_vm", result)


asyncio.run(main())
PY

cleanup
trap - EXIT INT TERM

for candidate in "mf-${check_vm}" "mf-${check_copy}" "mfsnap-${check_snapshot}"; do
  if local_vm_exists "${candidate}"; then
    echo "cleanup failed: ${candidate} still exists" >&2
    exit 1
  fi
done

echo "L1-L3 hardware release check passed; temporary VMs and snapshot removed"
