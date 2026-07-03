#!/usr/bin/env bash
# Bake mf-golden from the base image. Requires: tart, host SSH key.
set -euo pipefail
BASE="ghcr.io/cirruslabs/macos-tahoe-base:latest"
tart clone "$BASE" mf-golden
tart run mf-golden --no-graphics & sleep 40
IP="$(tart ip mf-golden)"
ssh-copy-id "admin@$IP"
uv run python -c "from macfleet.provision import render_provision_script as r; print(r())" \
  | ssh admin@"$IP" 'bash -s'
echo ">> Now grant Accessibility + Screen Recording via VNC (one time), then:"
echo ">>   tart stop mf-golden"
