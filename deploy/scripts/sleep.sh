#!/usr/bin/env bash
# Scale everything to zero nodes. Only the disks keep billing (about $4/month). wake.sh reverses it.
set -euo pipefail

CLUSTER="${CLUSTER:-messenger}"
ZONE="${ZONE:-us-central1-a}"
NAMESPACE="${NAMESPACE:-messenger}"

kubectl -n "$NAMESPACE" patch cronjob sweep -p '{"spec":{"suspend":true}}'
kubectl -n "$NAMESPACE" patch cronjob pg-backup -p '{"spec":{"suspend":true}}'
kubectl -n "$NAMESPACE" scale deployment api cloudflared --replicas=0
kubectl -n "$NAMESPACE" wait pod -l app=api --for=delete --timeout=120s
# postgres goes last so every in-flight write has finished
kubectl -n "$NAMESPACE" scale statefulset postgres --replicas=0
kubectl -n "$NAMESPACE" wait pod -l app=postgres --for=delete --timeout=120s

gcloud container clusters resize "$CLUSTER" --zone="$ZONE" --node-pool=burst --num-nodes=0 --quiet
gcloud container clusters resize "$CLUSTER" --zone="$ZONE" --node-pool=default-pool --num-nodes=0 --quiet
echo "asleep: 0 nodes. deploy/scripts/wake.sh brings it back."
