#!/usr/bin/env bash
# Undo sleep.sh. Takes 3 to 5 minutes, most of it waiting for the node.
set -euo pipefail

CLUSTER="${CLUSTER:-messenger}"
ZONE="${ZONE:-us-central1-a}"
NAMESPACE="${NAMESPACE:-messenger}"

gcloud container clusters resize "$CLUSTER" --zone="$ZONE" --node-pool=default-pool --num-nodes=1 --quiet
# the node object can lag the resize by a few seconds, and kubectl wait errors on an empty match
until [ "$(kubectl get nodes -l cloud.google.com/gke-nodepool=default-pool --no-headers 2>/dev/null | wc -l)" -ge 1 ]; do
  sleep 10
done
kubectl wait node -l cloud.google.com/gke-nodepool=default-pool --for=condition=Ready --timeout=300s

kubectl -n "$NAMESPACE" scale statefulset postgres --replicas=1
kubectl -n "$NAMESPACE" rollout status statefulset/postgres --timeout=300s
kubectl -n "$NAMESPACE" scale deployment api cloudflared --replicas=1
kubectl -n "$NAMESPACE" patch cronjob sweep -p '{"spec":{"suspend":false}}'
kubectl -n "$NAMESPACE" patch cronjob pg-backup -p '{"spec":{"suspend":false}}'
kubectl -n "$NAMESPACE" rollout status deployment/api --timeout=300s
kubectl -n "$NAMESPACE" rollout status deployment/cloudflared --timeout=300s
echo "awake"
