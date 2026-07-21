#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"
corridor="${GCP_BENCH_CORRIDOR:-virginia}"
reuse_base="${MOQ_REUSE_BASE:-0}"
skip_managed="${MOQ_SKIP_MANAGED:-0}"
hosted_only="${MOQ_HOSTED_ONLY:-0}"
managed_only="${MOQ_MANAGED_ONLY:-0}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${BENCHMARK_PROJECT_CONFIRM:-}" != "$project" ]]; then
  echo "Set BENCHMARK_PROJECT_CONFIRM to the same value as GCP_PROJECT" >&2
  exit 1
fi
case "$corridor" in
  virginia) subscriber="transport-bench-sub-virginia"; subscriber_zone="us-east4-a" ;;
  frankfurt) subscriber="transport-bench-sub-frankfurt"; subscriber_zone="europe-west3-a" ;;
  tokyo) subscriber="transport-bench-sub-tokyo"; subscriber_zone="asia-northeast1-b" ;;
  *) echo "GCP_BENCH_CORRIDOR must be virginia, frankfurt, or tokyo" >&2; exit 1 ;;
esac
if [[ "$skip_managed" != "0" && "$skip_managed" != "1" ]]; then
  echo "MOQ_SKIP_MANAGED must be 0 or 1" >&2
  exit 1
fi
if [[ "$hosted_only" != "0" && "$hosted_only" != "1" ]]; then
  echo "MOQ_HOSTED_ONLY must be 0 or 1" >&2
  exit 1
fi
if [[ "$managed_only" != "0" && "$managed_only" != "1" ]]; then
  echo "MOQ_MANAGED_ONLY must be 0 or 1" >&2
  exit 1
fi
if [[ "$managed_only" == "1" && "$skip_managed" == "1" ]]; then
  echo "MOQ_MANAGED_ONLY=1 conflicts with MOQ_SKIP_MANAGED=1" >&2
  exit 1
fi

if [[ "$reuse_base" == "1" ]]; then
  instances=("$subscriber:$subscriber_zone")
elif [[ "$hosted_only" == "1" ]]; then
  instances=(
    "transport-bench-publisher-west:us-west2-a"
    "$subscriber:$subscriber_zone"
  )
else
  instances=(
    "transport-bench-publisher-west:us-west2-a"
    "transport-bench-relay-west:us-west2-a"
    "$subscriber:$subscriber_zone"
  )
fi

gcloud compute ssh transport-bench-publisher-west \
  --project="$project" --zone=us-west2-a --quiet --command=true

sync_one() {
  local spec="$1" name="${1%%:*}" zone="${1##*:}"
  local managed_build='./gcp/build-cloudflare-managed-moq-client.sh'
  if [[ "$skip_managed" == "1" ]]; then
    managed_build=true
  fi
  local managed_agent_build='cargo build --locked --release --manifest-path moq-managed-agent/Cargo.toml'
  if [[ "$skip_managed" == "1" || "$hosted_only" == "1" ]]; then
    managed_agent_build=true
  fi
  local comparison_build='cargo build --locked --release --manifest-path moq-agent/Cargo.toml; ./gcp/build-moq-fair-variant.sh; ./gcp/build-hosted-moq-clients.sh'
  if [[ "$managed_only" == "1" ]]; then
    comparison_build=true
  elif [[ "$hosted_only" == "1" ]]; then
    comparison_build='./gcp/build-hosted-moq-clients.sh'
  fi

  gcloud compute ssh "$name" --project="$project" --zone="$zone" --quiet --command \
    'until sudo test -f /var/lib/transport-bench-ready; do sleep 10; done; mkdir -p ~/independent-benchmark/media ~/independent-benchmark/gcp ~/independent-benchmark/patches ~/independent-benchmark/moq-agent/src ~/independent-benchmark/moq-managed-agent/src ~/independent-benchmark/moq-dev-agent/src'

  gcloud compute scp --project="$project" --zone="$zone" --quiet \
    "$root_dir/package.json" \
    "$root_dir/package-lock.json" \
    "$root_dir/analyze-media.mjs" \
    "$root_dir/analyze-resources.mjs" \
    "$root_dir/analyze-moq.mjs" \
    "$name:~/independent-benchmark/"

  gcloud compute scp --project="$project" --zone="$zone" --quiet --recurse \
    "$root_dir/media" \
    "$root_dir/gcp" \
    "$root_dir/patches" \
    "$name:~/independent-benchmark/"

  gcloud compute scp --project="$project" --zone="$zone" --quiet \
    "$root_dir/moq-agent/Cargo.toml" \
    "$root_dir/moq-agent/Cargo.lock" \
    "$name:~/independent-benchmark/moq-agent/"
  gcloud compute scp --project="$project" --zone="$zone" --quiet --recurse \
    "$root_dir/moq-agent/src" \
    "$name:~/independent-benchmark/moq-agent/"

  gcloud compute scp --project="$project" --zone="$zone" --quiet \
    "$root_dir/moq-managed-agent/Cargo.toml" \
    "$root_dir/moq-managed-agent/Cargo.lock" \
    "$name:~/independent-benchmark/moq-managed-agent/"
  gcloud compute scp --project="$project" --zone="$zone" --quiet --recurse \
    "$root_dir/moq-managed-agent/src" \
    "$name:~/independent-benchmark/moq-managed-agent/"

  gcloud compute scp --project="$project" --zone="$zone" --quiet \
    "$root_dir/moq-dev-agent/Cargo.toml" \
    "$root_dir/moq-dev-agent/Cargo.lock" \
    "$name:~/independent-benchmark/moq-dev-agent/"
  gcloud compute scp --project="$project" --zone="$zone" --quiet --recurse \
    "$root_dir/moq-dev-agent/src" \
    "$name:~/independent-benchmark/moq-dev-agent/"

  gcloud compute ssh "$name" --project="$project" --zone="$zone" --quiet --command \
    "set -euo pipefail; cd ~/independent-benchmark; npm ci; export PATH=/opt/cargo/bin:\$PATH RUSTUP_HOME=/opt/rustup; $comparison_build; $managed_agent_build; $managed_build; mkdir -p qualification; node media/qualify-workload.mjs > qualification/workload.json"
}

pids=()
for instance in "${instances[@]}"; do
  sync_one "$instance" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done

if [[ "$hosted_only" == "1" ]]; then
  echo "Pinned moq.dev hosted clients are installed for $corridor; unrelated client builds skipped."
elif [[ "$managed_only" == "1" ]]; then
  echo "Pinned Cloudflare managed draft-14 clients and control agent are installed for $corridor."
elif [[ "$skip_managed" == "1" ]]; then
  echo "Pinned moq-rs draft-16 and moq.dev clients are installed for $corridor; managed draft-14 build skipped."
else
  echo "Pinned moq-rs draft-16, moq.dev, and Cloudflare managed draft-14 clients are installed for $corridor."
fi
