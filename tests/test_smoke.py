from importlib.metadata import version

import macfleet


def test_version_present():
    assert macfleet.__version__ == version("macfleet")
