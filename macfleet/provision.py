from __future__ import annotations

DNS_SERVERS = "1.1.1.1 8.8.8.8"
NET_SERVICE = "Ethernet"

_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.macfleet.computerserver</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/admin/cs-venv/bin/python</string>
    <string>-m</string><string>computer_server</string>
    <string>--host</string><string>0.0.0.0</string>
    <string>--port</string><string>8000</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
"""


def render_provision_script(dns: str = DNS_SERVERS) -> str:
    return f"""#!/bin/bash
set -e
# 1. public DNS (NAT proxy is dead)
sudo networksetup -setdnsservers {NET_SERVICE} {dns}
sudo killall -HUP mDNSResponder || true
# 2. uv (idempotent)
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
# 3. cua-computer-server venv (idempotent). `uv venv` has no pip; install via `uv pip`.
test -d "$HOME/cs-venv" || uv venv "$HOME/cs-venv"
uv pip install --python "$HOME/cs-venv/bin/python" --quiet cua-computer-server
# 4. launchd unit -> server on :8000 at boot
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/com.macfleet.computerserver.plist" <<'PLIST'
{_PLIST}PLIST
launchctl unload "$HOME/Library/LaunchAgents/com.macfleet.computerserver.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.macfleet.computerserver.plist"
echo MACFLEET_PROVISIONED_OK
"""


def bake_steps() -> list[str]:
    return [
        "clone base image + boot",
        "ssh-copy-id admin@<ip>  (keyless SSH)",
        "run the provision script (DNS + computer-server + launchd)",
        "MANUAL (once, via VNC): grant Accessibility + Screen Recording (TCC) to the "
        "computer-server helper — cannot be scripted; all clones inherit it",
        "tart stop mf-golden  (snapshot template ready)",
    ]
