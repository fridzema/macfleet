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


def test_plist_writes_log_file():
    from macfleet.provision import render_provision_script, SERVER_LOG
    s = render_provision_script()
    assert SERVER_LOG in s
    assert "StandardOutPath" in s
