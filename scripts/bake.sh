#!/usr/bin/env bash
# Bake mf-golden from the base image. Hands-off except one guest-password prompt.
# TCC (Screen Recording + Accessibility) is seeded by the provision script itself
# (SIP is disabled in the base image), so there is no manual VNC step.
# Requires: tart, uv, a host SSH key (~/.ssh/id_*.pub).
set -euo pipefail

# Digest-pinned so a rebuild cannot silently pick up a different privileged base image.
# Override deliberately when upgrading, and review the new image before committing it.
BASE="${MACFLEET_BASE_IMAGE:-ghcr.io/cirruslabs/macos-tahoe-base@sha256:a8e1c8305758643f513fdccdd829c2243687c60791083dea42f73f0b7aeb435c}"
PUBKEY="$(ls "$HOME"/.ssh/id_*.pub 2>/dev/null | head -1 || true)"
[ -n "$PUBKEY" ] || { echo "no SSH public key in ~/.ssh — run ssh-keygen first"; exit 1; }
KEY="${PUBKEY%.pub}"

tart clone "$BASE" mf-golden
tart run mf-golden --no-graphics >/dev/null 2>&1 &

# Wait for the guest to boot and open SSH (~30s), instead of a fixed sleep.
IP=""
for _ in $(seq 1 40); do
  IP="$(tart ip mf-golden 2>/dev/null || true)"
  [ -n "$IP" ] && nc -z -G 3 "$IP" 22 2>/dev/null && break
  sleep 3
done
[ -n "$IP" ] || { echo "mf-golden never came up"; exit 1; }

# Install the host key. Password-only login avoids 'too many authentication failures'
# when the ssh-agent offers many keys. Default guest password on the base image: admin.
echo ">> mf-golden at $IP — copying SSH key (guest password, default: admin)"
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password \
    -o StrictHostKeyChecking=accept-new "admin@$IP" \
    'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys' < "$PUBKEY"

SSH=(ssh -o IdentitiesOnly=yes -i "$KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes)

# Provision: DNS + computer-server + launchd + TCC grants.
uv run python -c "from macfleet.provision import render_provision_script as r; print(r())" \
  | "${SSH[@]}" "admin@$IP" 'bash -s'

# Verify the server is up and TCC actually lets it capture the screen.
"${SSH[@]}" "admin@$IP" 'curl -s -m 5 http://127.0.0.1:8000/status' | grep -q '"status":"ok"' \
  && echo ">> computer-server healthy on :8000"
"${SSH[@]}" "admin@$IP" \
  'TOKEN="$(cat ~/.macfleet-control-token)"; curl -s -m 15 -X POST http://127.0.0.1:8000/cmd -H "content-type: application/json" -H "X-Macfleet-Guest-Token: $TOKEN" -d "{\"command\":\"screenshot\",\"params\":{}}" | head -c 200' \
  | grep -q '"success": true' \
  && echo ">> screenshot OK — TCC granted" \
  || echo ">> WARN: screenshot check failed — TCC may not be seeded (is SIP disabled?)"

# Preserve the fully booted state. Clones now resume in a few seconds instead of cold-booting
# macOS for 30–60 seconds; no separate `macfleet warm` step is required after a normal bake.
tart suspend mf-golden
echo ">> mf-golden baked and warm-suspended — clone it with: uv run macfleet up <name>"
