from macfleet.provision import render_provision_script, bake_steps


def test_script_sets_public_dns():
    s = render_provision_script()
    assert "networksetup -setdnsservers Ethernet 1.1.1.1 8.8.8.8" in s
    assert "killall -HUP mDNSResponder" in s


def test_script_installs_server_and_launchd():
    s = render_provision_script()
    assert "computer_server" in s
    assert "LaunchAgents" in s
    assert ":8000" in s or "--port 8000" in s
    assert "uv pip install" in s
    assert "-m pip install" not in s


def test_script_is_idempotent_guarded():
    s = render_provision_script()
    # re-runnable: guards before install so re-bake is safe
    assert "command -v uv" in s


def test_script_seeds_tcc_grants():
    s = render_provision_script()
    # TCC is granted headlessly via sqlite (SIP is off in the base image), not via VNC.
    assert "kTCCServiceScreenCapture" in s
    assert "kTCCServiceAccessibility" in s
    assert 'sqlite3 "$TCC_DB"' in s
    assert "csrutil status" in s  # guarded on SIP being disabled


def test_bake_steps_mention_tcc():
    steps = bake_steps()
    assert any("TCC" in s or "Accessibility" in s for s in steps)


def test_bake_steps_have_no_manual_gate():
    # the whole point: baking is hands-off now
    assert not any("MANUAL" in s for s in bake_steps())


def test_server_pinned_to_logical_display_size():
    # The launch gateway must pass --width/--height (the display's logical/point size) so
    # screenshots and click coordinates share one space — otherwise a Retina guest's clicks
    # land at ~2x the intended spot. See _GATEWAY.
    s = render_provision_script()
    assert "macfleet_gateway.py" in s
    assert "pyautogui" in s and "pyautogui.size()" in s
    assert "--width" in s and "--height" in s
    assert "127.0.0.1" in s and '"8001"' in s


def test_gateway_requires_boot_rotated_token_for_commands():
    from macfleet.provision import _GATEWAY

    s = render_provision_script()
    compile(_GATEWAY, "macfleet_gateway.py", "exec")
    assert "secrets.token_urlsafe" in s
    assert "X-Macfleet-Guest-Token" in s
    assert "compare_digest" in s
    assert 'parsed.path != "/status"' in s
    assert 'parsed.path == "/macfleet/screenshot"' in s
    assert 'parsed.path == "/macfleet/logs"' in s
    assert 'parsed.path == "/macfleet/metrics"' in s


def test_guest_dependencies_are_version_pinned():
    s = render_provision_script()
    assert "cua-computer-server==0.3.42" in s
    assert "UV_VERSION=0.11.28" in s


def test_plist_writes_log_file():
    from macfleet.provision import render_provision_script, SERVER_LOG
    s = render_provision_script()
    assert SERVER_LOG in s
    assert "StandardOutPath" in s
