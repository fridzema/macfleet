from macfleet.leases import Leases


def _leases(tmp_path):
    clock = {"t": 1000.0}
    lease = Leases(str(tmp_path / "state.json"), clock=lambda: clock["t"])
    return lease, clock


def test_record_then_expired(tmp_path):
    lease, clock = _leases(tmp_path)
    lease.record("mf-a", ttl=60)
    assert lease.expired(clock["t"]) == []
    clock["t"] = 1000 + 61
    assert lease.expired(clock["t"]) == ["mf-a"]


def test_drop_removes_lease(tmp_path):
    lease, clock = _leases(tmp_path)
    lease.record("mf-a", ttl=1)
    lease.drop("mf-a")
    assert lease.expired(clock["t"] + 999) == []


def test_rename_moves_key(tmp_path):
    lease, clock = _leases(tmp_path)
    lease.record("mf-a", ttl=1)
    lease.rename("mf-a", "mf-b")
    assert lease.expired(clock["t"] + 999) == ["mf-b"]


def test_missing_or_corrupt_file_is_empty(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{ not json")
    lease = Leases(str(path), clock=lambda: 0.0)
    assert lease.expired(1e12) == []  # no crash
    lease.record("mf-a", ttl=1)  # recovers and writes clean state
    assert lease.expired(1e12) == ["mf-a"]


def test_bare_filename_with_no_dir_component_does_not_crash(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    lease = Leases("state.json", clock=lambda: 1000.0)
    lease.record("mf-a", ttl=1)
    assert lease.expired(1000 + 2) == ["mf-a"]


def test_expired_skips_entries_missing_expires_at(tmp_path):
    path = tmp_path / "state.json"
    path.write_text('{"leases": {"mf-a": {"created_at": 1000, "source": "api"}}}')
    lease = Leases(str(path), clock=lambda: 0.0)
    assert lease.expired(1e12) == []  # malformed entry skipped, no crash
