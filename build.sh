#!/usr/bin/env bash
# Build + push the plex-channels image to your registry, then redeploy the app.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="registry.example.com/plex-channels:latest"

docker build -t "$IMAGE" .
docker push "$IMAGE"
echo "built + pushed $IMAGE"
echo "redeploy the TrueNAS 'plex-channels' custom app to pull the new image."
