from macfleet.shares import Shares


def test_set_get_roundtrip(tmp_path):
    s = Shares(str(tmp_path / "shares.json"))
    s.set("mf-web", [{"tag": "src", "host_path": "/x", "read_only": True}])
    assert s.get("mf-web") == [{"tag": "src", "host_path": "/x", "read_only": True}]


def test_unknown_reads_empty(tmp_path):
    assert Shares(str(tmp_path / "s.json")).get("mf-nope") == []


def test_set_empty_drops_key(tmp_path):
    s = Shares(str(tmp_path / "s.json"))
    s.set("mf-web", [{"tag": "a", "host_path": "/x", "read_only": False}])
    s.set("mf-web", [])
    assert s.get("mf-web") == []


def test_rename_moves(tmp_path):
    s = Shares(str(tmp_path / "s.json"))
    s.set("mf-web", [{"tag": "a", "host_path": "/x", "read_only": True}])
    s.rename("mf-web", "mf-prod")
    assert s.get("mf-prod")[0]["tag"] == "a"
    assert s.get("mf-web") == []


def test_corrupt_file_reads_empty(tmp_path):
    p = tmp_path / "s.json"
    p.write_text("not json")
    assert Shares(str(p)).get("mf-web") == []
