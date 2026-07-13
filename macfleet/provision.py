from __future__ import annotations

DNS_SERVERS = "1.1.1.1 8.8.8.8"
NET_SERVICE = "Ethernet"
SERVER_LOG = "/Users/admin/Library/Logs/macfleet-computerserver.log"
UV_VERSION = "0.11.28"
COMPUTER_SERVER_VERSION = "0.3.42"
# cua-computer-server requires Python >=3.12,<3.14, but the base image's default `python3` is
# 3.9. Pin the venv's interpreter so `uv venv` fetches a managed 3.12 instead of picking up the
# system 3.9 (which makes the cua-computer-server install unsatisfiable and the bake fail).
PYTHON_VERSION = "3.12"

_GATEWAY_PATH = "/Users/admin/cs-venv/macfleet_gateway.py"

# Authenticated gateway: the privileged computer server is loopback-only on :8001. The
# gateway exposes /status for health checks but requires a boot-rotated secret for /cmd.
# The host retrieves that 0600 token over SSH; callers cannot bypass MACFLEET_ALLOW_CONTROL
# by posting directly to the guest IP. It also rescales incoming mouse coordinates from the
# screenshot's pixel space (what the desktop clicks against) to the display's logical points
# (what CGWarpMouseCursorPosition — cua's cursor backend — actually uses), which differ on a
# HiDPI guest and which cua does not reconcile itself.
_GATEWAY = r'''from __future__ import annotations

import base64
import http.server
import json
import os
import re
import secrets
import signal
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

TOKEN_PATH = os.path.expanduser("~/.macfleet-control-token")
LOG_PATH = os.path.expanduser("~/Library/Logs/macfleet-computerserver.log")
TOKEN = secrets.token_urlsafe(32)
with open(TOKEN_PATH, "w") as fh:
    fh.write(TOKEN + "\n")
os.chmod(TOKEN_PATH, 0o600)

backend = subprocess.Popen(
    [sys.executable, "-m", "computer_server", "--host", "127.0.0.1", "--port", "8001"]
)

# cua moves the cursor with CGWarpMouseCursorPosition, which takes points in the display's logical
# bounds (CGDisplayBounds), while the desktop maps clicks against the larger screenshot pixels; cua
# applies no scaling and ignores --width/--height. Rescale mouse coordinates from screenshot space
# to the click space. The ratio is resolved lazily on first use (once cua can screenshot) and
# cached — screenshot and display dimensions are stable for a boot.
_MOUSE_COMMANDS = {"left_click", "right_click", "middle_click", "double_click",
                   "move_cursor", "mouse_down", "mouse_up", "drag_to"}
_scale_lock = threading.Lock()
_click_scale = None  # (sx, sy) once resolved


def backend_cmd(command, params=None):
    body = json.dumps({"command": command, "params": params or {}}).encode()
    req = urllib.request.Request("http://127.0.0.1:8001/cmd", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as response:
        raw = response.read().decode()
    result = {}
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if line.startswith("{"):
            result = json.loads(line)
    if not result.get("success", True):
        raise RuntimeError(result.get("error", command + " failed"))
    return result


def resolve_click_scale():
    global _click_scale
    with _scale_lock:
        if _click_scale is None:
            import Quartz
            bounds = Quartz.CGDisplayBounds(Quartz.CGMainDisplayID())
            png = base64.b64decode(backend_cmd("screenshot")["image_data"])
            shot_w, shot_h = struct.unpack(">II", png[16:24])  # PNG IHDR width/height
            _click_scale = (float(bounds.size.width) / shot_w,
                            float(bounds.size.height) / shot_h)
        return _click_scale


def scale_mouse_body(body):
    try:
        payload = json.loads(body)
        params = payload.get("params") or {}
        if payload.get("command") in _MOUSE_COMMANDS and \
                isinstance(params.get("x"), (int, float)) and \
                isinstance(params.get("y"), (int, float)):
            sx, sy = resolve_click_scale()
            params["x"] = round(params["x"] * sx)
            params["y"] = round(params["y"] * sy)
            payload["params"] = params
            return json.dumps(payload).encode()
    except Exception:
        pass  # forward unchanged if the body isn't a scalable mouse command
    return body


metrics_lock = threading.Lock()
metrics_cached_at = 0.0
metrics_cache = {"cpu_pct": 0.0, "mem_used_mb": 0, "mem_total_mb": 0}
metrics_total_mb = 0


class Gateway(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _authorized(self) -> bool:
        supplied = self.headers.get("X-Macfleet-Guest-Token", "")
        if secrets.compare_digest(supplied, TOKEN):
            return True
        self.send_error(401, "invalid or missing guest token")
        return False

    def _send(self, status: int, payload: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _backend_command(self, command: str) -> dict:
        return backend_cmd(command)

    def _screenshot(self) -> None:
        if not self._authorized():
            return
        try:
            png = base64.b64decode(self._backend_command("screenshot")["image_data"])
            self._send(200, png, "image/png")
        except Exception as exc:
            self._send(502, json.dumps({"detail": str(exc)}).encode(), "application/json")

    def _logs(self, query: dict[str, list[str]]) -> None:
        if not self._authorized():
            return
        try:
            size = os.path.getsize(LOG_PATH)
            cursor_raw = query.get("cursor", [""])[0]
            if cursor_raw:
                requested = max(int(cursor_raw), 0)
                reset = requested > size
                start = 0 if reset else requested
                with open(LOG_PATH, "rb") as fh:
                    fh.seek(start)
                    data = fh.read(1024 * 1024)
                cursor = start + len(data)
            else:
                reset = False
                # Initial tail: inspect at most 256 KiB, then retain the requested lines.
                count = min(max(int(query.get("lines", ["100"])[0]), 1), 5000)
                start = max(0, size - 256 * 1024)
                with open(LOG_PATH, "rb") as fh:
                    fh.seek(start)
                    data = fh.read()
                if start and b"\n" in data:
                    data = data.split(b"\n", 1)[1]
                data = b"\n".join(data.splitlines()[-count:])
                if data:
                    data += b"\n"
                cursor = size
            payload = json.dumps({
                "lines": data.decode("utf-8", errors="replace"), "cursor": cursor,
                "reset": reset,
            }).encode()
            self._send(200, payload, "application/json")
        except FileNotFoundError:
            self._send(200, b'{"lines":"","cursor":0}', "application/json")
        except Exception as exc:
            self._send(500, json.dumps({"detail": str(exc)}).encode(), "application/json")

    def _metrics(self) -> None:
        if not self._authorized():
            return
        global metrics_cached_at, metrics_cache, metrics_total_mb
        try:
            with metrics_lock:
                now = time.monotonic()
                if now - metrics_cached_at >= 2:
                    output = subprocess.run(
                        ["/usr/bin/top", "-l1", "-n0"], capture_output=True,
                        text=True, timeout=5, check=True,
                    ).stdout
                    cpu_pct = 0.0
                    mem_used_mb = 0
                    cpu = re.search(r"([\d.]+)%\s+idle", output)
                    memory = re.search(r"PhysMem:\s+([\d.]+)([MG])\s+used", output)
                    if cpu:
                        cpu_pct = round(100 - float(cpu.group(1)), 1)
                    if memory:
                        value = float(memory.group(1))
                        mem_used_mb = int(value * 1024) if memory.group(2) == "G" else int(value)
                    if not metrics_total_mb:
                        metrics_total_mb = int(subprocess.run(
                            ["/usr/sbin/sysctl", "-n", "hw.memsize"], capture_output=True,
                            text=True, timeout=2, check=True,
                        ).stdout.strip()) // (1024 * 1024)
                    metrics_cache = {
                        "cpu_pct": cpu_pct, "mem_used_mb": mem_used_mb,
                        "mem_total_mb": metrics_total_mb,
                    }
                    metrics_cached_at = now
                payload = json.dumps(metrics_cache).encode()
            self._send(200, payload, "application/json")
        except Exception as exc:
            self._send(502, json.dumps({"detail": str(exc)}).encode(), "application/json")

    def _proxy(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/macfleet/screenshot":
            self._screenshot()
            return
        if parsed.path == "/macfleet/logs":
            self._logs(query)
            return
        if parsed.path == "/macfleet/metrics":
            self._metrics()
            return
        if parsed.path != "/status" and not self._authorized():
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else None
        if parsed.path == "/cmd" and body:
            body = scale_mouse_body(body)
        req = urllib.request.Request(
            "http://127.0.0.1:8001" + self.path,
            data=body,
            method=self.command,
            headers={"Content-Type": self.headers.get("Content-Type", "application/json")},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                payload = response.read()
                status = response.status
                content_type = response.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            status = exc.code
            content_type = exc.headers.get("Content-Type", "application/json")
        except Exception as exc:
            payload = json.dumps({"detail": f"computer server unavailable: {exc}"}).encode()
            status = 502
            content_type = "application/json"
        self._send(status, payload, content_type)

    do_GET = _proxy
    do_POST = _proxy

    def log_message(self, _format: str, *_args: object) -> None:
        pass


def shutdown(_signum: int, _frame: object) -> None:
    backend.terminate()
    raise SystemExit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)
try:
    http.server.ThreadingHTTPServer(("0.0.0.0", 8000), Gateway).serve_forever()
finally:
    backend.terminate()
    backend.wait(timeout=10)
'''

_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.macfleet.computerserver</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/admin/cs-venv/bin/python</string>
    <string>/Users/admin/cs-venv/macfleet_gateway.py</string>
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
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | env UV_VERSION={UV_VERSION} sh
export PATH="$HOME/.local/bin:$PATH"
# 3. cua-computer-server venv (idempotent). `uv venv` has no pip; install via `uv pip`.
test -d "$HOME/cs-venv" || uv venv --python {PYTHON_VERSION} "$HOME/cs-venv"
uv pip install --python "$HOME/cs-venv/bin/python" --quiet \
  "cua-computer-server=={COMPUTER_SERVER_VERSION}"
# 4. authenticated gateway + launchd unit -> :8000 at boot
mkdir -p "$HOME/Library/LaunchAgents"
cat > "{_GATEWAY_PATH}" <<'PY'
{_GATEWAY}PY
chmod 700 "{_GATEWAY_PATH}"
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
        "macfleet warm  (boots golden, waits for the guest, then SUSPENDS it) — clones of a "
        "suspended golden resume in ~2s instead of cold-booting macOS for ~30-60s",
    ]
