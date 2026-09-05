from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[1] / "scripts" / "verify-release-hardware.sh"


def _write_executable(directory: Path, name: str, source: str) -> None:
    path = directory / name
    path.write_text(source)
    path.chmod(0o755)


def _fake_environment(
    tmp_path: Path, inventory: str, uv_source: str
) -> tuple[dict[str, str], Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    state = tmp_path / "inventory"
    state.write_text(inventory)
    log = tmp_path / "uv.log"
    _write_executable(bin_dir, "uname", "#!/usr/bin/env bash\necho arm64\n")
    _write_executable(
        bin_dir,
        "tart",
        """#!/usr/bin/env bash
if [[ "$1" == "list" ]]; then
  cat "$MACFLEET_TEST_STATE"
elif [[ "$1" == "--version" ]]; then
  echo "tart fake"
else
  exit 2
fi
""",
    )
    _write_executable(bin_dir, "uv", uv_source)
    _write_executable(bin_dir, "sleep", "#!/usr/bin/env bash\nexit 0\n")
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "MACFLEET_TEST_STATE": str(state),
        "MACFLEET_TEST_LOG": str(log),
    }
    return env, log


@pytest.mark.parametrize(
    "reserved",
    ["mf-releasecheck", "mf-releasecopy", "mfsnap-releasecheck-ready"],
)
def test_hardware_check_never_cleans_up_a_preexisting_reserved_name(
    tmp_path: Path, reserved: str
) -> None:
    env, log = _fake_environment(
        tmp_path,
        f"mf-golden\n{reserved}\n",
        """#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MACFLEET_TEST_LOG"
exit 99
""",
    )

    result = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env=env)

    assert result.returncode == 1
    assert f"refusing to overwrite pre-existing {reserved}" in result.stderr
    assert reserved in Path(env["MACFLEET_TEST_STATE"]).read_text().splitlines()
    assert not log.exists(), "preflight failure must not invoke cleanup through uv"


def test_hardware_check_cleans_up_a_vm_created_by_a_failed_run(tmp_path: Path) -> None:
    env, log = _fake_environment(
        tmp_path,
        "mf-golden\n",
        """#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MACFLEET_TEST_LOG"
if [[ "$*" == "run macfleet up releasecheck" ]]; then
  echo mf-releasecheck >> "$MACFLEET_TEST_STATE"
  exit 1
fi
if [[ "$*" == "run macfleet nuke releasecheck" ]]; then
  grep -Fvx mf-releasecheck "$MACFLEET_TEST_STATE" > "$MACFLEET_TEST_STATE.tmp"
  mv "$MACFLEET_TEST_STATE.tmp" "$MACFLEET_TEST_STATE"
  exit 0
fi
exit 99
""",
    )

    result = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env=env)

    assert result.returncode == 1
    assert Path(env["MACFLEET_TEST_STATE"]).read_text().splitlines() == ["mf-golden"]
    assert "run macfleet nuke releasecheck" in log.read_text().splitlines()
