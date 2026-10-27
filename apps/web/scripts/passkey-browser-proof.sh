#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then
  echo 'Usage: passkey-browser-proof.sh RUN (from verify-adrive/control.py new)' >&2
  exit 2
fi
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
repo_dir="$(cd -- "$script_dir/../../.." && pwd)"
run_dir="$(realpath -- "$1")"
"$repo_dir/.agents/skills/verify-adrive/control.py" doctor "$run_dir"
docker run --rm --init --network host --ipc=private --shm-size=512m \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$script_dir,dst=/proof,readonly" \
  --mount "type=bind,src=$run_dir/evidence,dst=/evidence" \
  mcr.microsoft.com/playwright:v1.56.1-noble \
  bash -c 'npm install --prefix /tmp/pw --cache /tmp/npm-cache --no-audit --no-fund playwright@1.56.1 && node /proof/passkey-virtual-authenticator.mjs /evidence'
