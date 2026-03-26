#!/bin/bash

docker run -d \
  --name k8s-admin \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ~/.aws:/root/.aws:ro \
  -v "$(cd "$(dirname "$0")" && pwd)"/.env:/app/.env:ro \
  twwch/k8s-admin:latest
