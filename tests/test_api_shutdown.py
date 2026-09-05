"""Real-process regression: an open fleet stream must not prevent suspend-on-exit."""

import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

import pytest


@pytest.mark.parametrize("entrypoint", ["sidecar", "cli"])
def test_open_fleet_stream_does_not_block_shutdown(entrypoint):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    code = f"""
from macfleet import api
class Fleet:
    def list_vms(self): return []
    def provisioning(self): return {{}}
    def reap(self): return []
    def suspend_all(self): print('SUSPEND_ON_EXIT_COMPLETED', flush=True)
original = api.build_app
api.build_app = lambda **kwargs: original(fleet=Fleet(), **kwargs)
if {entrypoint!r} == 'sidecar':
    from macfleet.sidecar import main
    main()
else:
    from macfleet.cli import serve
    serve(port={port})
"""
    process = subprocess.Popen(
        [sys.executable, "-c", code, "--port", str(port)],
        env={
            **os.environ,
            "MACFLEET_API_TOKEN": "shutdown-test",
            "MACFLEET_SUSPEND_VMS_ON_EXIT": "1",
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stream = None
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                stream = urllib.request.urlopen(
                    urllib.request.Request(
                        f"http://127.0.0.1:{port}/fleet/events",
                        headers={"X-Macfleet-Token": "shutdown-test"},
                    ),
                    timeout=2,
                )
                break
            except urllib.error.URLError:
                if time.monotonic() >= deadline or process.poll() is not None:
                    raise
                time.sleep(0.1)
        assert stream.readline().startswith(b"data:")
        # Deliberately leave the response open while the server receives SIGTERM.
        started = time.monotonic()
        process.terminate()
        stdout, stderr = process.communicate(timeout=12)
        elapsed = time.monotonic() - started
        assert "SUSPEND_ON_EXIT_COMPLETED" in stdout, stderr
        assert "Application shutdown complete" in stderr
        # The stream ends itself on the exit signal, so the drain must not run to its
        # five-second deadline and Uvicorn must not cancel the response mid-flight.
        assert elapsed < 4, f"shutdown took {elapsed:.1f}s: {stderr}"
        assert "CancelledError" not in stderr, stderr
        assert "Traceback" not in stderr, stderr
    finally:
        if stream is not None:
            stream.close()
        if process.poll() is None:
            process.kill()
            process.communicate()
