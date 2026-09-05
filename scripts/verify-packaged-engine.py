"""Smoke-test a built engine over real HTTP without changing fleet configuration or VMs.

Usage: python scripts/verify-packaged-engine.py /path/to/macfleet-engine
"""

from __future__ import annotations

import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def main() -> None:
    binary = Path(sys.argv[1]).resolve(strict=True)
    token = secrets.token_urlsafe(32)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = {**os.environ, "MACFLEET_API_TOKEN": token, "MACFLEET_SUSPEND_VMS_ON_EXIT": "0"}
    process = subprocess.Popen([str(binary), "--port", str(port)], env=env)

    def request(
        path: str, *, authenticated: bool = True, method: str = "GET", data=None, headers=None
    ):
        headers = dict(headers or {})
        if authenticated:
            headers["X-Macfleet-Token"] = token
        body = None if data is None else json.dumps(data).encode()
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}", data=body, headers=headers, method=method
        )
        try:
            return urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as exc:
            return exc

    started = time.monotonic()
    try:
        while True:
            if process.poll() is not None:
                raise RuntimeError(f"engine exited during startup: {process.returncode}")
            try:
                with request("/config", authenticated=False) as response:
                    assert response.status == 401
                break
            except urllib.error.URLError:
                if time.monotonic() - started > 30:
                    raise RuntimeError("engine did not start within 30s") from None
                time.sleep(0.2)
        print(f"Packaged engine ready in {time.monotonic() - started:.2f}s", flush=True)

        for path in ("/config", "/host"):
            with request(path) as response:
                assert response.status == 200
                assert isinstance(json.load(response), dict)
            with request(path, authenticated=False) as response:
                assert response.status == 401

        with request(
            "/vms", authenticated=False, method="POST", data={"name": "never-created"}
        ) as response:
            assert response.status == 401
        # Validation rejects this before calling Fleet.create; no VM can be created.
        with request("/vms", method="POST", data={"name": "never-created", "ttl": -1}) as response:
            assert response.status == 422
        for origin, expected in (("tauri://localhost", 200), ("https://untrusted.invalid", 400)):
            with request(
                "/config",
                authenticated=False,
                method="OPTIONS",
                headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
            ) as response:
                assert response.status == expected
        print("PASS: real HTTP reads, authentication, input validation, and CORS", flush=True)
    finally:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise RuntimeError("engine failed graceful shutdown") from None
    # Uvicorn re-raises SIGTERM after completing its lifespan shutdown.
    assert process.returncode in (0, -signal.SIGTERM), process.returncode
    print("PASS: bounded SIGTERM shutdown without suspend-on-exit", flush=True)


if __name__ == "__main__":
    main()
