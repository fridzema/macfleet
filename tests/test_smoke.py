import macfleet


def test_version_present():
    assert isinstance(macfleet.__version__, str)
    assert macfleet.__version__
