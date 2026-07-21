#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"
profile="${GCP_BENCH_PROFILE:-global}"
focused_corridor="${GCP_BENCH_CORRIDOR:-virginia}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${BENCHMARK_PROJECT_CONFIRM:-}" != "$project" ]]; then
  echo "Set BENCHMARK_PROJECT_CONFIRM to the same value as GCP_PROJECT" >&2
  exit 1
fi
if [[ "$profile" != "global" && "$profile" != "focused" ]]; then
  echo "Unsupported GCP_BENCH_PROFILE: $profile" >&2
  exit 1
fi
if [[ "$focused_corridor" != "virginia" && "$focused_corridor" != "frankfurt" && "$focused_corridor" != "tokyo" ]]; then
  echo "Unsupported GCP_BENCH_CORRIDOR: $focused_corridor" >&2
  exit 1
fi

instances=(
  "transport-bench-publisher-west:us-west2-a"
  "transport-bench-relay-west:us-west2-a"
)
if [[ "$profile" == "global" ]]; then
  instances+=(
    "transport-bench-sub-virginia:us-east4-a"
    "transport-bench-sub-frankfurt:europe-west3-a"
    "transport-bench-sub-tokyo:asia-northeast1-b"
  )
else
  case "$focused_corridor" in
    virginia) instances+=("transport-bench-sub-virginia:us-east4-a") ;;
    frankfurt) instances+=("transport-bench-sub-frankfurt:europe-west3-a") ;;
    tokyo) instances+=("transport-bench-sub-tokyo:asia-northeast1-b") ;;
  esac
fi

# Let gcloud create and publish its SSH key before parallel connections start.
# Without this preflight, first use can race four ssh-keygen processes.
gcloud compute ssh transport-bench-publisher-west \
  --project="$project" \
  --zone=us-west2-a \
  --quiet \
  --command=true

sync_instance() {
  local spec="$1"
  local name="${spec%%:*}"
  local zone="${spec##*:}"

  gcloud compute ssh "$name" --project="$project" --zone="$zone" --quiet --command \
    'until sudo test -f /var/lib/transport-bench-ready; do sleep 10; done; mkdir -p ~/independent-benchmark/media ~/independent-benchmark/moq-agent/src ~/independent-benchmark/gcp ~/independent-benchmark/patches'

  gcloud compute scp --project="$project" --zone="$zone" --quiet \
    "$root_dir/package.json" \
    "$root_dir/package-lock.json" \
    "$root_dir/benchmark.mjs" \
    "$root_dir/distributed-agent.mjs" \
    "$root_dir/analyze.mjs" \
    "$root_dir/analyze-distributed.mjs" \
    "$root_dir/analyze-media.mjs" \
    "$root_dir/analyze-moq.mjs" \
    "$root_dir/correlate.mjs" \
    "$name:~/independent-benchmark/"

  gcloud compute scp --project="$project" --zone="$zone" --quiet --recurse \
    "$root_dir/media" \
    "$name:~/independent-benchmark/"

  gcloud compute scp --project="$project" --zone="$zone" --quiet --recurse \
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

  gcloud compute ssh "$name" --project="$project" --zone="$zone" --quiet --command \
    'cd ~/independent-benchmark && npm ci && export PATH=/opt/cargo/bin:$PATH RUSTUP_HOME=/opt/rustup && cargo build --release --manifest-path moq-agent/Cargo.toml'
}

pids=()
for instance in "${instances[@]}"; do
  sync_instance "$instance" &
  pids+=("$!")
done

for pid in "${pids[@]}"; do
  wait "$pid"
done
