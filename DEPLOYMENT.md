# Deployment

Three pieces: the static client on Cloudflare Pages, the API on a one-node GKE cluster, and a Cloudflare Tunnel between them so nothing on the node listens to the internet. Postgres is a StatefulSet on the same node, with a nightly dump to a GCS bucket. The whole thing idles at about $20 a month and sleeps for about $1.

```
app.example.com  (Cloudflare Pages, static Next export)  --fetch/SSE-->  api.example.com
                                                                              |  Cloudflare Tunnel
                                                                              v
GKE Standard, zonal (control plane free for one cluster per billing account)
+-- default-pool: 1x e2-small on demand, 30 GB pd-balanced boot disk
|   +-- postgres StatefulSet (10 Gi pd-balanced PVC)
|   +-- api Deployment (HPA min 1, max 6)
|   +-- cloudflared Deployment
|   +-- sweep CronJob (every 5 min), pg-backup CronJob (nightly, to GCS)
+-- burst: e2-small Spot, autoscaled 0 to 3, tainted; only api pods go there
```

## What it costs

| Mode | What's running | About |
|---|---|---|
| Idle | the core node, its public IP, two disks | $20/month |
| Busy | plus each Spot node for as long as the HPA wants it | $4 to $7 per Spot node-month, billed per second |
| Asleep (`deploy/scripts/sleep.sh`) | the Postgres disk and the bucket | $1/month |

Idle breakdown: e2-small $12.23, external IPv4 $3.65, 30 GB boot disk about $3, 10 Gi data disk about $1. Artifact Registry, GCS, Secret Manager, and Cloud Logging stay inside their free tiers at this size. These are us-central1 list prices from October 2026. Every flag that costs money in `deploy/gcp/bootstrap.sh` has its price in a comment next to it. After the first full week, compare the billing report with this table and fix the numbers here.

The $30 budget alert is the real safety net. The bootstrap script creates it before anything else.

## Before you start

- `gcloud`, plus `gcloud components install kubectl gke-gcloud-auth-plugin`
- A GCP project with billing enabled, and your billing account id from `gcloud billing accounts list`
- A Cloudflare account with your domain on it (the free plan is enough)
- A Resend API key with your sending domain verified
- Optional: a free healthchecks.io check, for the "did the backup run" alarm

## 1. Create the tunnel

Cloudflare dashboard > Zero Trust > Networks > Tunnels > Create a tunnel > Cloudflared. Name it `messenger`. The install step shows a command with a long `--token` value; copy the token and ignore the command, the cluster runs cloudflared for you. Under Public hostname add `api` on your domain, type HTTP, URL `api.messenger.svc.cluster.local:80`. That is the in-cluster Service; the tunnel pod resolves it.

## 2. Create the secrets

They live in Secret Manager and get copied into the cluster once by the bootstrap script. The passwords are hex on purpose, because the Postgres one ends up inside a connection URL.

```sh
gcloud config set project YOUR_PROJECT_ID
gcloud services enable secretmanager.googleapis.com
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create messenger-postgres-password --data-file=-
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create messenger-jwt-secret --data-file=-
printf '%s' 're_...' | gcloud secrets create messenger-resend-api-key --data-file=-
printf '%s' 'eyJ...' | gcloud secrets create messenger-cloudflare-tunnel-token --data-file=-
printf '%s' 'https://hc-ping.com/...' | gcloud secrets create messenger-healthchecks-url --data-file=-   # optional
```

## 3. Bootstrap GCP

```sh
PROJECT_ID=YOUR_PROJECT_ID BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX deploy/gcp/bootstrap.sh
```

About ten minutes, most of it cluster creation. In order: enables APIs, checks the secrets exist, creates the budget, the Artifact Registry repo with a keep-5-images cleanup policy, the backup bucket, the cluster with its single on-demand node, the Spot `burst` pool, deletes the default SSH and RDP firewall rules, binds the `pg-backup` Kubernetes service account to the bucket, sets up Workload Identity Federation for GitHub Actions, and writes the secrets into the `messenger` namespace. Every step checks before it creates, so rerun it after a failure or to re-copy rotated secrets. `REGION`, `ZONE`, `CLUSTER`, `NAMESPACE`, `AR_REPO`, `BUCKET`, `GITHUB_REPO`, and `BUDGET_USD` can be overridden the same way as `PROJECT_ID`.

No service account keys anywhere: GitHub Actions and the backup job both authenticate through Workload Identity Federation.

## 4. Tell GitHub about it

Repo > Settings > Secrets and variables > Actions > Variables (not secrets; neither value is sensitive). The script prints both at the end.

- `GCP_PROJECT_ID`
- `GCP_WIF_PROVIDER`, like `projects/123456789/locations/global/workloadIdentityPools/github/providers/github`

Add `GCP_REGION`, `GCP_ZONE`, or `GKE_CLUSTER` only if you changed those defaults. The Deploy workflow is skipped while `GCP_PROJECT_ID` is unset, which is why CI stayed green before the cluster existed.

## 5. Configure and deploy

Edit `deploy/k8s/overlays/prod/config.env`:

- `APP_ORIGIN`: the Pages URL from step 6, scheme and host, no trailing slash. CORS is pinned to it.
- `EMAIL_FROM`: a sender on your verified Resend domain
- `REGISTRATION_MODE`: `invite` (default) or `open`
- `BACKUP_BUCKET`: `messenger-backups-YOUR_PROJECT_ID`

Commit and push. CI runs, then Deploy builds the image, pushes it to Artifact Registry tagged with the commit sha, applies the manifests, and waits for the rollout. The `migrate` init container runs `prisma migrate deploy` before the API starts. A push that touches `deploy/backup/` also rebuilds the backup image; run that workflow by hand once (Actions > Backup image > Run workflow) so the CronJob has an image to pull.

```sh
gcloud container clusters get-credentials messenger --zone us-central1-a
kubectl -n messenger get pods
```

## 6. Publish the client

Cloudflare dashboard > Workers & Pages > Create > Pages > Connect to Git > this repo.

- Root directory: `client`. pnpm finds the workspace root on its own.
- Build command: `pnpm build`
- Build output directory: `out`
- Environment variables: `NEXT_PUBLIC_API_URL=https://api.yourdomain.com` and `NODE_VERSION=24`

`NEXT_PUBLIC_API_URL` is baked in at build time; change it and redeploy, not the other way round. Add `app.yourdomain.com` under Custom domains, put that origin in `APP_ORIGIN`, and replace `api.example.com` in `client/public/_headers` with your API hostname. The CSP there allows inline scripts because Next's static export inlines its hydration script, and `wasm-unsafe-eval` for libsodium. Phase 6 tightens it with hashes.

## 7. Check it works

1. `kubectl -n messenger get pods`: `postgres-0`, `api-*`, and `cloudflared-*` Running. `kubectl -n messenger get hpa` shows a CPU percentage, not `<unknown>`.
2. Invite yourself: `kubectl -n messenger exec deploy/api -- node dist/scripts/invite.js you@example.com`. Sign up from the link, open a second browser, chat both ways.
3. With a conversation open, `kubectl -n messenger delete pod -l app=api`. The thread reconnects within 15 seconds and nothing is lost.
4. Burst: `npx autocannon -c 50 -d 120 https://api.yourdomain.com/health`. The HPA adds pods, a Spot node shows up in `kubectl get nodes -w` within about two minutes, and it is gone about fifteen minutes after the load stops. To rehearse a preemption: `gcloud compute instances simulate-maintenance-event NODE_NAME --zone us-central1-a`; the pod reschedules and clients resync.
5. Backup: `kubectl -n messenger create job --from=cronjob/pg-backup backup-now`, then `kubectl -n messenger logs job/backup-now`, `gcloud storage ls gs://messenger-backups-YOUR_PROJECT_ID`, and a ping on healthchecks.io. Then the restore drill below.
6. Sleep and wake once, and look at the billing report the next day.

## Day to day

- Logs: `kubectl -n messenger logs deploy/api -f`. They also land in Cloud Logging (resource type `k8s_container`).
- Invite a friend: `kubectl -n messenger exec deploy/api -- node dist/scripts/invite.js friend@example.com`
- Deploy: push to main. Undo a bad one: `kubectl -n messenger rollout undo deployment/api`.
- Config change: edit `config.env` and push. Kustomize hashes the ConfigMap name, so the pods restart with the new values.
- Rotate a secret: `gcloud secrets versions add NAME --data-file=-`, rerun the bootstrap script, then `kubectl -n messenger rollout restart deployment/api` (or `cloudflared`). The Postgres image only reads its password on first init, so rotating that one also needs `ALTER USER msguser PASSWORD '...'` inside `kubectl -n messenger exec -it postgres-0 -- psql -U msguser messaging`.
- More capacity all the time: `minReplicas: 2` in `deploy/k8s/base/hpa.yaml`. Two replicas still fit on the core node.
- Node upgrades: the regular release channel upgrades the node on its own, and with one replica the API and Postgres are down for a minute or two while it happens. If that matters, set a maintenance window on the cluster.

## Backups

The `pg-backup` CronJob runs at 09:00 UTC. In order: `pg_dump` in custom format, `pg_restore --list` to prove the archive is readable, upload to `gs://messenger-backups-YOUR_PROJECT_ID/messenger-<utc timestamp>.dump`, then delete everything but the newest 7, then ping healthchecks.io. Upload comes before prune, so a failing night never deletes anything, and only successful uploads count toward the 7. If the ping stops, healthchecks.io emails you. The bucket keeps soft-deleted objects for 7 days, so a deleted dump can be brought back from the console.

RPO is 24 hours. The data that matters most (key bundles, conversation keys, memberships) changes rarely, and messages expire anyway.

### Restore drill

Do this once after the first backup, and again whenever you change anything here. It runs in the `messenger` namespace because that is where the service account with bucket access lives.

```sh
IMAGE=us-central1-docker.pkg.dev/YOUR_PROJECT_ID/messenger/pg-backup:latest
kubectl -n messenger run drill-db --image=postgres:16-alpine --env=POSTGRES_USER=msguser --env=POSTGRES_PASSWORD=drill --env=POSTGRES_DB=messaging
kubectl -n messenger expose pod drill-db --port=5432
kubectl -n messenger run drill --rm -it --restart=Never --image=$IMAGE \
  --overrides='{"apiVersion":"v1","spec":{"serviceAccountName":"pg-backup"}}' --command -- bash
```

Inside that shell:

```sh
gcloud storage ls gs://messenger-backups-YOUR_PROJECT_ID/
gcloud storage cp gs://messenger-backups-YOUR_PROJECT_ID/messenger-TIMESTAMP.dump /tmp/db.dump
PGPASSWORD=drill pg_restore --host=drill-db --username=msguser --dbname=messaging --no-owner /tmp/db.dump
PGPASSWORD=drill psql --host=drill-db --username=msguser --dbname=messaging -c 'select count(*) from users'
exit
```

The count should match production. Clean up with `kubectl -n messenger delete pod/drill-db svc/drill-db`.

Restoring into production is the same `pg_restore` pointed at `--host=postgres` with the real password, plus `--clean --if-exists`, after `kubectl -n messenger scale deployment api --replicas=0`. Scale `api` back to 1 afterwards; the HPA idles while the count is 0.

## Sleep and wake

`deploy/scripts/sleep.sh` suspends the CronJobs, scales the app and then Postgres to zero, and resizes both node pools to zero. `deploy/scripts/wake.sh` reverses it in three to five minutes. Both are also workflows (Actions > Sleep, Actions > Wake), so it works from a phone. While asleep the Pages site still loads but every request fails, because there is no tunnel pod to answer. The data disk, the bucket, and the images stay.

## When the database needs more

The single StatefulSet has no standby and no point-in-time recovery. When that stops being fine, the step up is the CloudNativePG operator: a primary with an optional streaming replica, continuous WAL archiving to the same bucket, and PITR. It wants about 300 MiB more memory than the core node has to spare, so it comes with a move to e2-medium (+$12/month). The migration is a `pg_dump` from the backup job, install the operator, create a `Cluster` resource, `pg_restore` into it, and point `DATABASE_URL` at the `-rw` service.

## The cheaper alternative

If the goal were only to run the app, Cloud Run plus a Neon Postgres would cost $0 to $5 a month and scale to zero. The Dockerfile works there as is. Two catches: `LISTEN/NOTIFY` needs Neon's direct connection string, not the pooled one, and an open SSE stream keeps a Cloud Run instance billed for as long as it lasts. The sweep becomes a Cloud Run job on a Cloud Scheduler trigger. This repo runs on GKE because learning Kubernetes was part of the point.

## Troubleshooting

- A pod is Pending with "Insufficient memory": the core node is full. Add a pool with `--machine-type=e2-medium`, drain `default-pool`, delete it, and rename the pool references in `deploy/scripts/*.sh`.
- `api` is stuck in `Init`: `kubectl -n messenger logs deploy/api -c migrate`. Usually Postgres is not ready yet and the next retry works; a failed migration shows up here as SQL.
- The browser shows CORS errors: `APP_ORIGIN` has to match the Pages origin exactly.
- `cloudflared` is crash-looping: the token is wrong or was revoked. Put the new one in Secret Manager, rerun bootstrap, `kubectl -n messenger rollout restart deployment/cloudflared`.
- The event stream drops every 100 seconds: Cloudflare closes idle responses at 100 seconds, which is why the server sends a comment every 25. Check `kubectl -n messenger logs deploy/api` for the stream opening at all.
- `pg-backup` is in `ImagePullBackOff`: run the Backup image workflow.
- Deploy fails in the auth step: `GCP_WIF_PROVIDER` is wrong, or the repo name in the bootstrap's `GITHUB_REPO` does not match this repo.
- Sign-up emails never arrive: `RESEND_API_KEY` is wrong or `EMAIL_FROM` is not on a verified domain. `kubectl -n messenger logs deploy/api | grep -i resend`.
