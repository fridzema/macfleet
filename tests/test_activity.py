from macfleet.activity import Activity


def _act(tmp_path):
    t = {"v": 100.0}
    return Activity(str(tmp_path / "activity.jsonl"), clock=lambda: t["v"], cap=3), t


def test_record_and_recent_newest_first(tmp_path):
    a, t = _act(tmp_path)
    a.record("claude-code", "created", "web")
    t["v"] = 101.0
    a.record("agent-7", "snapshotted", "ci")
    r = a.recent(10)
    assert [e["who"] for e in r] == ["agent-7", "claude-code"]
    assert r[0] == {"who": "agent-7", "action": "snapshotted", "target": "ci", "ts": 101.0}


def test_ring_buffer_caps_entries(tmp_path):
    a, t = _act(tmp_path)  # cap=3
    for i in range(5):
        t["v"] = 100.0 + i
        a.record("a", "did", f"vm{i}")
    r = a.recent(10)
    assert len(r) == 3
    assert [e["target"] for e in r] == ["vm4", "vm3", "vm2"]  # newest 3, newest-first


def test_limit(tmp_path):
    a, t = _act(tmp_path)
    for i in range(3):
        t["v"] = 100.0 + i
        a.record("a", "did", f"vm{i}")
    assert len(a.recent(2)) == 2


def test_missing_or_corrupt_reads_empty(tmp_path):
    path = tmp_path / "activity.jsonl"
    assert Activity(str(path)).recent() == []          # missing
    path.write_text('{"who":"a"}\nnot json\n')          # one good-ish + one corrupt line
    got = Activity(str(path)).recent()
    assert len(got) == 1 and got[0]["who"] == "a"        # corrupt line skipped
