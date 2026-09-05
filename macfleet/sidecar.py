"""Minimal entry point for the packaged, self-contained desktop engine."""

from __future__ import annotations

import argparse
import os

import uvicorn

from macfleet.api import build_app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    token = os.environ["MACFLEET_API_TOKEN"]
    uvicorn.run(
        build_app(
            token=token,
            suspend_vms_on_exit=os.environ.get("MACFLEET_SUSPEND_VMS_ON_EXIT") == "1",
        ),
        host="127.0.0.1",
        port=args.port,
        # Fleet SSE connections are long-lived. Drain them before lifespan shutdown
        # so suspend-on-exit runs instead of waiting until the native host kills us.
        timeout_graceful_shutdown=5,
    )


if __name__ == "__main__":
    main()
