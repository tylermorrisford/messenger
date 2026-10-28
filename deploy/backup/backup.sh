#!/usr/bin/env bash
# pg_dump to GCS, keep the newest $KEEP dumps, ping healthchecks.io. Runs from the pg-backup CronJob.
set -euo pipefail

: "${BUCKET:?BUCKET is required}"
KEEP="${KEEP:-7}"
HEALTHCHECKS_URL="${HEALTHCHECKS_URL:-}"

ping() {
  [ -z "$HEALTHCHECKS_URL" ] || curl -fsS -m 10 --retry 3 -o /dev/null "$HEALTHCHECKS_URL${1:-}" || true
}
trap 'ping /fail' ERR

ping /start
name="messenger-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --file="/tmp/$name"
# a dump that can't be listed can't be restored either
pg_restore --list "/tmp/$name" >/dev/null
gcloud storage cp "/tmp/$name" "gs://$BUCKET/$name"
# names sort by time, so everything after the newest KEEP is pruned
gcloud storage ls "gs://$BUCKET/messenger-*.dump" | sort -r | tail -n +"$((KEEP + 1))" | xargs -r gcloud storage rm
ping
echo "backed up $name ($(du -h "/tmp/$name" | cut -f1))"
