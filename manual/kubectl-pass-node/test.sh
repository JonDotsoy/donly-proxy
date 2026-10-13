#!/usr/bin/env bash
# Sends a POST through the proxy to the echo-pod Service (only reachable from inside the
# cluster), checks the echoed response and shows the proxy log and the echo-pod log.
#
# Usage:
#   ./test.sh
set -euo pipefail
cd "$(dirname "$0")"

CONTEXT=kind-donly-manual
URL=http://echo-pod.donly-manual.svc.cluster.local/path?x=1

echo ">> POST $URL via http://127.0.0.1:8080"
RESPONSE=$(NO_PROXY= no_proxy= curl -sS --fail -i -x http://127.0.0.1:8080 -X POST -H 'x-custom: abc' -d payload "$URL")
echo "$RESPONSE"

echo "$RESPONSE" | grep -qi '^x-echo: yes' || { echo "FAIL: missing x-echo header"; exit 1; }
echo "$RESPONSE" | grep -q '"body":"payload"' || { echo "FAIL: body not echoed"; exit 1; }

echo; echo ">> proxy log (logs/proxy.ndjson)"
tail -n 4 logs/proxy.ndjson
echo; echo ">> echo-pod log"
kubectl --context "$CONTEXT" -n donly-manual logs echo-pod --tail=3
echo; echo "OK"
