#!/usr/bin/env bash
# Build + push the queuepilot image to your registry, then redeploy the app.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="ghcr.io/sawtaytoes/queuepilot:latest"

docker build -t "$IMAGE" .
docker push "$IMAGE"
echo "built + pushed $IMAGE"
echo "redeploy the TrueNAS 'queuepilot' custom app to pull the new image."
