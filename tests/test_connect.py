import base64
import json
import subprocess
import urllib.error
import pytest
from macfleet.connect import ssh_cmd, scp_push_cmd, Fleet, GuestControl, SSH_OPTS
from macfleet.vm import Tart


def fake_runner(script):
    def run(argv):
        return subprocess.CompletedProcess(argv, 0, stdout=script(argv), stderr="")
    return run


def test_ssh_cmd_shape():
    cmd = ssh_cmd("192.168.64.4", "uptime")
    assert cmd[0] == "ssh"
    assert "admin@192.168.64.4" in cmd
    assert cmd[-1] == "uptime"
    for opt in SSH_OPTS:
        assert opt in cmd


def test_scp_push_cmd_shape():
    cmd = scp_push_cmd("192.168.64.4", "a.txt", "/tmp/a.txt")
    assert cmd[0] == "scp"
    assert cmd[-2] == "a.txt"
    assert cmd[-1] == "admin@192.168.64.4:/tmp/a.txt"


def test_up_clones_golden_and_starts():
    seen = []
    def tart_run(argv):
        seen.append(argv)
        return subprocess.CompletedProcess(argv, 0, "[]" if argv[:2] == ["tart", "list"] else "", "")
    fleet = Fleet(tart=Tart(run=tart_run), spawn=seen.append)
    fleet.up("web")
    assert ["tart", "clone", "mf-golden", "mf-web"] in seen
    assert ["tart", "run", "mf-web", "--no-graphics"] in seen


def test_computer_blocked_without_env(monkeypatch):
    monkeypatch.delenv("MACFLEET_ALLOW_CONTROL", raising=False)
    fleet = Fleet(tart=Tart(run=fake_runner(lambda argv: "")))
    with pytest.raises(RuntimeError, match="MACFLEET_ALLOW_CONTROL"):
        fleet.computer("web")


# --- GuestControl: drives the in-guest computer-server over /cmd ---


class _FakeResp:
    def __init__(self, text):
        self._t = text

    def read(self):
        return self._t.encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _opener(response_text, captured):
    def open_(req, timeout=None):
        captured.append((req.full_url, json.loads(req.data.decode())))
        return _FakeResp(response_text)
    return open_


def test_guest_screenshot_decodes_image_data():
    png = b"\x89PNG\r\n\x1a\nDATA"
    b64 = base64.b64encode(png).decode()
    cap = []
    gc = GuestControl("http://vm:8000", opener=_opener(f'data: {{"success": true, "image_data": "{b64}"}}', cap))
    assert gc.screenshot() == png
    assert cap[0][0] == "http://vm:8000/cmd"
    assert cap[0][1] == {"command": "screenshot", "params": {}}


def test_guest_click_sends_left_click_coords():
    cap = []
    gc = GuestControl("http://vm:8000", opener=_opener('data: {"success": true}', cap))
    gc.click(12, 34)
    assert cap[0][1] == {"command": "left_click", "params": {"x": 12, "y": 34}}


def test_guest_type_sends_text():
    cap = []
    gc = GuestControl("http://vm:8000", opener=_opener('data: {"success": true}', cap))
    gc.type("hi there")
    assert cap[0][1] == {"command": "type_text", "params": {"text": "hi there"}}


def test_guest_key_combo_uses_hotkey_single_uses_press_key():
    cap = []
    gc = GuestControl("http://vm:8000", opener=_opener('data: {"success": true}', cap))
    gc.key("cmd+space")
    assert cap[0][1] == {"command": "hotkey", "params": {"keys": ["cmd", "space"]}}
    gc.key("escape")
    assert cap[1][1] == {"command": "press_key", "params": {"key": "escape"}}


def test_guest_command_failure_raises_runtimeerror():
    gc = GuestControl("http://vm:8000", opener=_opener('data: {"success": false, "error": "boom"}', []))
    with pytest.raises(RuntimeError, match="boom"):
        gc.click(1, 1)


def test_guest_unreachable_raises_runtimeerror():
    def boom(req, timeout=None):
        raise urllib.error.URLError("connection refused")
    gc = GuestControl("http://vm:8000", opener=boom)
    with pytest.raises(RuntimeError, match="unreachable"):
        gc.screenshot()
