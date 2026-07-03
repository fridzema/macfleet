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


def test_bake_steps_mention_tcc():
    steps = bake_steps()
    assert any("TCC" in s or "Accessibility" in s for s in steps)
