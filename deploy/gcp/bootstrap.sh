#!/usr/bin/env bash
# One-time GCP setup. Safe to rerun after a partial failure; every step checks before it creates.
# Lines that cost money carry a price comment. Prices are us-central1 list prices, October 2026.
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID to your GCP project id}"
: "${BILLING_ACCOUNT:?set BILLING_ACCOUNT (gcloud billing accounts list) so the budget alert can be created}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-us-central1-a}"
CLUSTER="${CLUSTER:-messenger}"
NAMESPACE="${NAMESPACE:-messenger}"
AR_REPO="${AR_REPO:-messenger}"
BUCKET="${BUCKET:-messenger-backups-$PROJECT_ID}"
GITHUB_REPO="${GITHUB_REPO:-tylermorrisford/messenger}"
BUDGET_USD="${BUDGET_USD:-30}"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling APIs"
gcloud services enable \
  container.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  billingbudgets.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  storage.googleapis.com \
  compute.googleapis.com

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

echo "==> Checking Secret Manager secrets (free under 6 active secret versions)"
missing=0
for secret in messenger-postgres-password messenger-jwt-secret messenger-resend-api-key messenger-cloudflare-tunnel-token; do
  if ! gcloud secrets describe "$secret" >/dev/null 2>&1; then
    echo "missing secret: $secret" >&2
    missing=1
  fi
done
if [ "$missing" -eq 1 ]; then
  cat >&2 <<'EOT'

Create the missing secrets, then rerun this script:
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets create messenger-postgres-password --data-file=-
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets create messenger-jwt-secret --data-file=-
  printf '%s' 're_...' | gcloud secrets create messenger-resend-api-key --data-file=-
  printf '%s' '<token from Cloudflare Zero Trust > Networks > Tunnels>' | gcloud secrets create messenger-cloudflare-tunnel-token --data-file=-
Optional (backup failure alerts):
  printf '%s' 'https://hc-ping.com/<uuid>' | gcloud secrets create messenger-healthchecks-url --data-file=-
EOT
  exit 1
fi

echo "==> Budget: \$$BUDGET_USD/month, emails billing admins at 50%, 90%, and 100%"
if ! gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" --format='value(displayName)' | grep -qx messenger-monthly; then
  gcloud billing budgets create \
    --billing-account="$BILLING_ACCOUNT" \
    --display-name=messenger-monthly \
    --budget-amount="${BUDGET_USD}USD" \
    --threshold-rule=percent=0.5 \
    --threshold-rule=percent=0.9 \
    --threshold-rule=percent=1.0 \
    --filter-projects="projects/$PROJECT_NUMBER"
fi

echo "==> Artifact Registry repo $AR_REPO (\$0.10/GB/month after the first 0.5 GB; the cleanup policy keeps 5 images per name)"
if ! gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$AR_REPO" --location="$REGION" --repository-format=docker
fi
gcloud artifacts repositories set-cleanup-policies "$AR_REPO" \
  --location="$REGION" \
  --policy="$(dirname "$0")/cleanup-policy.json" \
  --no-dry-run

echo "==> Backup bucket gs://$BUCKET (\$0.02/GB/month; a week of dumps of a small DB rounds to zero)"
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" \
    --location="$REGION" \
    --uniform-bucket-level-access \
    --public-access-prevention
fi

echo "==> GKE cluster $CLUSTER in $ZONE"
echo "    zonal control plane: free for one cluster per billing account"
echo "    default-pool, the core pool: 1x e2-small on demand, ~\$12.23/month, plus 30 GB pd-balanced boot disk, ~\$3/month"
if ! gcloud container clusters describe "$CLUSTER" --zone="$ZONE" >/dev/null 2>&1; then
  gcloud container clusters create "$CLUSTER" \
    --zone="$ZONE" \
    --release-channel=regular \
    --num-nodes=1 \
    --machine-type=e2-small \
    --disk-type=pd-balanced \
    --disk-size=30 \
    --workload-pool="$PROJECT_ID.svc.id.goog" \
    --enable-ip-alias \
    --autoscaling-profile=optimize-utilization \
    --no-enable-managed-prometheus \
    --monitoring=SYSTEM \
    --logging=SYSTEM,WORKLOAD \
    --addons=HorizontalPodAutoscaling,GcePersistentDiskCsiDriver
fi

echo "==> burst node pool: Spot e2-small, 0 to 3 nodes, roughly \$4 to \$7/month per node, only while scaled up"
if ! gcloud container node-pools describe burst --cluster="$CLUSTER" --zone="$ZONE" >/dev/null 2>&1; then
  gcloud container node-pools create burst \
    --cluster="$CLUSTER" \
    --zone="$ZONE" \
    --spot \
    --machine-type=e2-small \
    --disk-type=pd-balanced \
    --disk-size=30 \
    --num-nodes=0 \
    --enable-autoscaling \
    --min-nodes=0 \
    --max-nodes=3 \
    --workload-metadata=GKE_METADATA
fi

echo "==> Removing the default SSH and RDP firewall rules (nothing here needs them)"
for rule in default-allow-ssh default-allow-rdp; do
  if gcloud compute firewall-rules describe "$rule" >/dev/null 2>&1; then
    gcloud compute firewall-rules delete "$rule" --quiet
  fi
done

echo "==> Letting the pg-backup Kubernetes service account write to the bucket (Workload Identity, no key file)"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="principal://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$PROJECT_ID.svc.id.goog/subject/ns/$NAMESPACE/sa/pg-backup" \
  --role=roles/storage.objectAdmin >/dev/null

echo "==> GitHub Actions identity for $GITHUB_REPO (Workload Identity Federation, no service account key)"
if ! gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
fi
if ! gcloud iam workload-identity-pools providers describe github --workload-identity-pool=github --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc github \
    --workload-identity-pool=github \
    --location=global \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository == '$GITHUB_REPO'"
fi
GITHUB_PRINCIPAL="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$GITHUB_REPO"
gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" \
  --location="$REGION" \
  --member="$GITHUB_PRINCIPAL" \
  --role=roles/artifactregistry.writer >/dev/null
# developer: kubectl apply; clusterAdmin: the sleep/wake workflows resize node pools
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$GITHUB_PRINCIPAL" --role=roles/container.developer >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$GITHUB_PRINCIPAL" --role=roles/container.clusterAdmin >/dev/null

echo "==> Kubernetes namespace and secrets (copied once from Secret Manager; rerun to rotate)"
gcloud container clusters get-credentials "$CLUSTER" --zone="$ZONE"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

PG_PASSWORD="$(gcloud secrets versions access latest --secret=messenger-postgres-password)"
kubectl -n "$NAMESPACE" create secret generic messenger-db \
  --from-literal=POSTGRES_PASSWORD="$PG_PASSWORD" \
  --from-literal=DATABASE_URL="postgresql://msguser:$PG_PASSWORD@postgres:5432/messaging" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" create secret generic messenger-api \
  --from-literal=JWT_SECRET="$(gcloud secrets versions access latest --secret=messenger-jwt-secret)" \
  --from-literal=RESEND_API_KEY="$(gcloud secrets versions access latest --secret=messenger-resend-api-key)" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" create secret generic cloudflared \
  --from-literal=TUNNEL_TOKEN="$(gcloud secrets versions access latest --secret=messenger-cloudflare-tunnel-token)" \
  --dry-run=client -o yaml | kubectl apply -f -
HEALTHCHECKS_URL="$(gcloud secrets versions access latest --secret=messenger-healthchecks-url 2>/dev/null || true)"
kubectl -n "$NAMESPACE" create secret generic pg-backup \
  --from-literal=HEALTHCHECKS_URL="$HEALTHCHECKS_URL" \
  --dry-run=client -o yaml | kubectl apply -f -

cat <<EOT

Done. Next:
  1. GitHub repo > Settings > Secrets and variables > Actions > Variables:
       GCP_PROJECT_ID    $PROJECT_ID
       GCP_WIF_PROVIDER  projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github
  2. Edit deploy/k8s/overlays/prod/config.env (APP_ORIGIN, EMAIL_FROM, BACKUP_BUCKET=$BUCKET), commit, push.
  3. Cloudflare Zero Trust > Networks > Tunnels > your tunnel > Public hostname:
       service  http://api.$NAMESPACE.svc.cluster.local
  4. Run the "Backup image" workflow once, then "Deploy".
EOT
