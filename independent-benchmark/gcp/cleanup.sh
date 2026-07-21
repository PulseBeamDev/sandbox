#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"

if [[ "${BENCHMARK_PROJECT_CONFIRM:-}" != "$project" ]]; then
  echo "Set BENCHMARK_PROJECT_CONFIRM to the same value as GCP_PROJECT" >&2
  exit 1
fi
if [[ "${1:-}" != "--yes" ]]; then
  echo "Usage: $0 --yes" >&2
  exit 2
fi

while IFS=$'\t' read -r name zone; do
  [[ -z "$name" ]] && continue
  gcloud compute instances delete "$name" --project="$project" --zone="$zone" --quiet
done < <(gcloud compute instances list \
  --project="$project" \
  --filter='labels.purpose=transport-benchmark AND labels.managed-by=benchmark-harness' \
  --format='value(name,zone.basename())')

for rule in transport-bench-relays transport-bench-ssh transport-bench-internal transport-bench-moq; do
  if gcloud compute firewall-rules describe "$rule" --project="$project" >/dev/null 2>&1; then
    gcloud compute firewall-rules delete "$rule" --project="$project" --quiet
  fi
done

for spec in \
  transport-bench-us-west2:us-west2 \
  transport-bench-us-east4:us-east4 \
  transport-bench-europe-west3:europe-west3 \
  transport-bench-asia-northeast1:asia-northeast1; do
  name="${spec%%:*}"
  region="${spec##*:}"
  if gcloud compute networks subnets describe "$name" --region="$region" --project="$project" >/dev/null 2>&1; then
    gcloud compute networks subnets delete "$name" --region="$region" --project="$project" --quiet
  fi
done

if gcloud compute networks describe transport-bench --project="$project" >/dev/null 2>&1; then
  gcloud compute networks delete transport-bench --project="$project" --quiet
fi
