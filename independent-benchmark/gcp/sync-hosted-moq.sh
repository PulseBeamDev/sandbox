#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"
corridor="${GCP_BENCH_CORRIDOR:-virginia}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${BENCHMARK_PROJECT_CONFIRM:-}" != "$project" ]]; then echo "Set BENCHMARK_PROJECT_CONFIRM to the same value as GCP_PROJECT" >&2; exit 1; fi
case "$corridor" in
  virginia) subscriber="transport-bench-sub-virginia"; zone="us-east4-a" ;;
  frankfurt) subscriber="transport-bench-sub-frankfurt"; zone="europe-west3-a" ;;
  tokyo) subscriber="transport-bench-sub-tokyo"; zone="asia-northeast1-b" ;;
  *) echo "Invalid corridor" >&2; exit 1 ;;
esac
instances=("transport-bench-publisher-west:us-west2-a" "$subscriber:$zone")

gcloud compute ssh transport-bench-publisher-west --project="$project" --zone=us-west2-a --quiet --command=true

sync_one() {
  local spec="$1" name="${1%%:*}" instance_zone="${1##*:}"
  gcloud compute ssh "$name" --project="$project" --zone="$instance_zone" --quiet --command \
    'until sudo test -f /var/lib/transport-bench-ready; do sleep 10; done; mkdir -p ~/independent-benchmark/media ~/independent-benchmark/gcp ~/independent-benchmark/patches ~/independent-benchmark/moq-dev-agent/src'
  gcloud compute scp --project="$project" --zone="$instance_zone" --quiet \
    "$root_dir/package.json" "$root_dir/package-lock.json" "$root_dir/analyze-media.mjs" "$root_dir/analyze-resources.mjs" \
    "$name:~/independent-benchmark/"
  gcloud compute scp --project="$project" --zone="$instance_zone" --quiet --recurse \
    "$root_dir/media" "$root_dir/gcp" "$root_dir/patches" "$name:~/independent-benchmark/"
  gcloud compute scp --project="$project" --zone="$instance_zone" --quiet \
    "$root_dir/moq-dev-agent/Cargo.toml" "$root_dir/moq-dev-agent/Cargo.lock" \
    "$name:~/independent-benchmark/moq-dev-agent/"
  gcloud compute scp --project="$project" --zone="$instance_zone" --quiet --recurse \
    "$root_dir/moq-dev-agent/src" "$name:~/independent-benchmark/moq-dev-agent/"
  gcloud compute ssh "$name" --project="$project" --zone="$instance_zone" --quiet --command \
    'cd ~/independent-benchmark && npm ci && ./gcp/build-hosted-moq-clients.sh && mkdir -p qualification && node media/qualify-workload.mjs > qualification/workload.json'
}

pids=()
for instance in "${instances[@]}"; do sync_one "$instance" & pids+=("$!"); done
for pid in "${pids[@]}"; do wait "$pid"; done
