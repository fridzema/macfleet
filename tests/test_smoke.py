import macfleet

from importlib.metadata import version


def test_version_present():
    assert macfleet.__version__ == version("macfleet")
