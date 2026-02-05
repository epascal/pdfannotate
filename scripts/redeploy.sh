#!/usr/bin/env bash
# Rebuild les images et met à jour les services de la stack pdfannotate (Docker Swarm).
# Usage: ./scripts/redeploy.sh [--no-cache]

set -e
cd "$(dirname "$0")/.."

STACK_NAME="pdfannotate"
COMPOSE_FILE="docker-compose.yml"

NO_CACHE=""
if [[ "${1:-}" == "--no-cache" ]]; then
  NO_CACHE="--no-cache"
fi

echo "=== Build des images Docker ==="
docker compose -f "$COMPOSE_FILE" build $NO_CACHE

echo "=== Mise à jour forcée des services ==="
for svc in $(docker stack services "$STACK_NAME" --format '{{.Name}}'); do
  echo "Update --force $svc"
  docker service update --force "$svc"
done

echo "=== Services de la stack ==="
docker stack services "$STACK_NAME"
