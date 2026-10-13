#!/usr/bin/env bash
# Stops the proxy and deletes the kind cluster created by setup.sh.
#
# Usage:
#   ./down.sh
set -uo pipefail
cd "$(dirname "$0")"

export KIND_EXPERIMENTAL_PROVIDER=podman

if [ -f proxy.pid ]; then
  kill "$(cat proxy.pid)" 2>/dev/null || true
  rm -f proxy.pid
fi
kind delete cluster --name donly-manual
