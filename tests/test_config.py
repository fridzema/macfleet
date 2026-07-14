import json
import threading

import pytest

from macfleet.config import DEFAULT_PRESET, PRESETS, Config, validate_preset


def test_missing_file_reads_default(tmp_path):
    assert Config(str(tmp_path / "config.json")).default_preset() == DEFAULT_PRESET


def test_corrupt_file_reads_default(tmp_path):
    p = tmp_path / "config.json"
    p.write_text("{not json")
    assert Config(str(p)).default_preset() == DEFAULT_PRESET


def test_unknown_preset_on_disk_reads_default(tmp_path):
    # A hand-edited config must never make the engine unstartable.
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"default_preset": "gigantic"}))
    assert Config(str(p)).default_preset() == DEFAULT_PRESET


def test_set_and_read_roundtrip(tmp_path):
    c = Config(str(tmp_path / "config.json"))
    c.set_default_preset("heavy")
    assert c.default_preset() == "heavy"
    assert Config(str(tmp_path / "config.json")).default_preset() == "heavy"


def test_set_unknown_preset_raises(tmp_path):
    c = Config(str(tmp_path / "config.json"))
    with pytest.raises(RuntimeError, match="unknown preset"):
        c.set_default_preset("gigantic")


def test_read_returns_default_and_table(tmp_path):
    c = Config(str(tmp_path / "config.json"))
    c.set_default_preset("light")
    assert c.read() == {"default_preset": "light", "presets": PRESETS}


def test_reset_drops_file(tmp_path):
    p = tmp_path / "config.json"
    c = Config(str(p))
    c.set_default_preset("heavy")
    c.reset()
    assert not p.exists()
    assert c.default_preset() == DEFAULT_PRESET


def test_reset_missing_file_is_noop(tmp_path):
    Config(str(tmp_path / "config.json")).reset()


def test_validate_preset_lists_valid_names():
    with pytest.raises(RuntimeError, match="light, standard, heavy|heavy, light, standard"):
        validate_preset("nope")


def test_presets_have_cpu_and_memory_only():
    # Disk is deliberately absent: `tart set --disk-size` is grow-only.
    for p in PRESETS.values():
        assert set(p) == {"cpu", "memory_gb"}


def test_concurrent_writes_always_leave_a_parseable_file(tmp_path):
    # Config has one key and one mutator, so there is no lost-update to test — any
    # interleaving yields some writer's value. What IS at stake is atomicity: _save writes
    # to a temp file and os.replace()s it, so a reader never sees a half-written file. An
    # in-place write would let _load hit a JSONDecodeError and silently report "standard" —
    # a value no thread ever wrote.
    path = tmp_path / "config.json"
    c = Config(str(path))
    start = threading.Barrier(8)
    written = ["light", "heavy"] * 4

    def worker(value):
        start.wait()  # maximize overlap on the read-modify-write
        c.set_default_preset(value)

    threads = [threading.Thread(target=worker, args=(v,)) for v in written]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert c.default_preset() in ("light", "heavy")
    assert json.loads(path.read_text())["default_preset"] in ("light", "heavy")
