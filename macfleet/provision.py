from __future__ import annotations

DNS_SERVERS = "1.1.1.1 8.8.8.8"
NET_SERVICE = "Ethernet"
SERVER_LOG = "/Users/admin/Library/Logs/macfleet-computerserver.log"

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
  <key>StandardOutPath</key><string>/Users/admin/Library/Logs/macfleet-computerserver.log</string>
  <key>StandardErrorPath</key><string>/Users/admin/Library/Logs/macfleet-computerserver.log</string>
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
# 5. pre-grant TCC so the headless helper can capture the screen and post events with
# no GUI/VNC step. The base image ships with SIP disabled, which makes the system
# TCC.db writable; every VM cloned from the golden image inherits these grants.
TCC_DB="/Library/Application Support/com.apple.TCC/TCC.db"
if csrutil status 2>/dev/null | grep -qi disabled; then
  PYS=("$HOME/cs-venv/bin/python" "$(readlink -f "$HOME/cs-venv/bin/python")")
  for svc in kTCCServiceScreenCapture kTCCServiceAccessibility kTCCServicePostEvent; do
    for py in "${{PYS[@]}}"; do
      sudo sqlite3 "$TCC_DB" "INSERT OR REPLACE INTO access \
        (service,client,client_type,auth_value,auth_reason,auth_version,indirect_object_identifier,boot_uuid) \
        VALUES ('$svc','$py',1,2,0,1,'UNUSED','UNUSED');"
    done
  done
  sudo killall tccd 2>/dev/null || true
  launchctl kickstart -k "gui/$(id -u)/com.macfleet.computerserver" 2>/dev/null || true
else
  echo "WARN: SIP enabled — TCC not seeded; grant Screen Recording + Accessibility by hand" >&2
fi
echo MACFLEET_PROVISIONED_OK
"""


def bake_steps() -> list[str]:
    return [
        "clone base image + boot",
        "ssh-copy-id admin@<ip>  (keyless SSH)",
        "run the provision script (DNS + computer-server + launchd + TCC grants)",
        "TCC (Accessibility + Screen Recording) is seeded automatically via sqlite — "
        "SIP is disabled in the base image, so no manual VNC step is needed; all clones "
        "inherit the grants",
        "tart stop mf-golden  (snapshot template ready)",
    ]
