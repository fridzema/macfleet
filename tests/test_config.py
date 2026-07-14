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


def test_unlocked_reads_never_observe_a_half_written_file(tmp_path):
    # default_preset() takes no lock (like leases.py's reads); it relies on _save's
    # temp-file + os.replace to make each write land atomically. Writers serialize on
    # state_lock, so the race only shows up when a reader runs *during* the storm rather
    # than after it. If _save wrote in place, the reader would catch a truncated file,
    # _load would swallow the JSONDecodeError, and default_preset() would report
    # "standard" — a value no thread here ever writes.
    path = tmp_path / "config.json"
    c = Config(str(path))
    c.set_default_preset("light")
    stop = threading.Event()
    seen = set()

    def reader():
        while not stop.is_set():
            seen.add(c.default_preset())

    def writer(value):
        for _ in range(50):
            c.set_default_preset(value)

    r = threading.Thread(target=reader)
    r.start()
    writers = [threading.Thread(target=writer, args=(v,)) for v in ("light", "heavy", "light", "heavy")]
    for t in writers:
        t.start()
    for t in writers:
        t.join()
    stop.set()
    r.join()

    assert seen, "reader never ran"
    assert seen <= {"light", "heavy"}, f"reader saw a value nobody wrote: {seen}"
