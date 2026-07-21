#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"
corridor="${1:-}"
if [[ "${BENCHMARK_PROJECT_CONFIRM:-}" != "$project" ]]; then
  echo "Set BENCHMARK_PROJECT_CONFIRM to the same value as GCP_PROJECT" >&2
  exit 1
fi
case "$corridor" in
  virginia) name="transport-bench-sub-virginia"; zone="us-east4-a" ;;
  frankfurt) name="transport-bench-sub-frankfurt"; zone="europe-west3-a" ;;
  tokyo) name="transport-bench-sub-tokyo"; zone="asia-northeast1-b" ;;
  *) echo "Usage: $0 virginia|frankfurt|tokyo" >&2; exit 2 ;;
esac

if gcloud compute instances describe "$name" --project="$project" --zone="$zone" >/dev/null 2>&1; then
  labels="$(gcloud compute instances describe "$name" --project="$project" --zone="$zone" --format='value(labels.purpose,labels.managed-by)')"
  if [[ "$labels" != $'transport-benchmark\tbenchmark-harness' ]]; then
    echo "Refusing to delete subscriber with unexpected labels: $name $labels" >&2
    exit 1
  fi
  gcloud compute instances delete "$name" --project="$project" --zone="$zone" --quiet
fi
