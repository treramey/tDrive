#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then
  echo "Usage: $0 RUN (from control.py new)" >&2
  exit 2
fi
skill_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
run_dir="$(realpath -- "$1")"
"$skill_dir/control.py" doctor "$run_dir"
# All browser dependencies live in an ephemeral container. No host sudo needed.
# --network host lets Chromium reach the two localhost app origins on Linux.
docker run --rm --init --network host --ipc=private --shm-size=512m \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$skill_dir,dst=/control,readonly" \
  --mount "type=bind,src=$run_dir/evidence,dst=/evidence" \
  mcr.microsoft.com/playwright:v1.56.1-noble \
  bash -c 'npm install --prefix /tmp/pw --cache /tmp/npm-cache --no-audit --no-fund playwright@1.56.1 && node /control/browser-proof.cjs /evidence'
