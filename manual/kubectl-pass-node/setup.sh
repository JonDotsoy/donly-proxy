#!/usr/bin/env bash
# Prepares the manual test of `kubectl_pass` + `command_pass node`: creates a kind cluster on
# podman (kind-donly-manual), builds and loads the image, deploys conn-pod and echo-pod, and
# starts the proxy in the background on 127.0.0.1:8080.
#
# Usage:
#   ./setup.sh
#   ./test.sh
#   ./down.sh
set -euo pipefail
cd "$(dirname "$0")"

export KIND_EXPERIMENTAL_PROVIDER=podman
CLUSTER=donly-manual
CONTEXT=kind-$CLUSTER
NAMESPACE=donly-manual
IMAGE=localhost/donly-manual-echo:test
NODE_CONTAINER=$CLUSTER-control-plane
ROOT=$(cd ../.. && pwd)

if ! podman container exists "$NODE_CONTAINER"; then
  echo ">> creating kind cluster $CLUSTER (podman)"
  kind create cluster --name "$CLUSTER" --wait 120s
else
  echo ">> cluster $CLUSTER already exists"
fi

echo ">> building $IMAGE and loading it into the node"
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
printf 'FROM docker.io/library/node:alpine\n' >"$BUILD/Containerfile"
podman build -q -t "$IMAGE" "$BUILD" >/dev/null
podman save --format docker-archive "$IMAGE" | podman exec -i "$NODE_CONTAINER" ctr -n k8s.io images import - >/dev/null

echo ">> deploying conn-pod and echo-pod"
kubectl --context "$CONTEXT" delete namespace "$NAMESPACE" --ignore-not-found --wait=true >/dev/null
kubectl --context "$CONTEXT" apply -f pods.yaml >/dev/null
kubectl --context "$CONTEXT" -n "$NAMESPACE" wait --for=condition=Ready pod/conn-pod pod/echo-pod --timeout=120s

echo ">> waiting for the echo-pod Service"
for i in $(seq 60); do
  kubectl --context "$CONTEXT" -n "$NAMESPACE" exec conn-pod -- node -e \
    'fetch("http://echo-pod.donly-manual.svc.cluster.local/").then(()=>{},()=>process.exit(1))' && break
  sleep 1
done

echo ">> starting the proxy on 127.0.0.1:8080"
if [ -f proxy.pid ] && kill -0 "$(cat proxy.pid)" 2>/dev/null; then
  echo "proxy already running (pid $(cat proxy.pid))"
else
  mkdir -p logs
  nohup bun "$ROOT/src/cli/main.ts" manifest.donly >logs/proxy.out 2>&1 &
  echo $! >proxy.pid
  sleep 2
  kill -0 "$(cat proxy.pid)" || { cat logs/proxy.out; exit 1; }
fi
echo "ready: run ./test.sh"
