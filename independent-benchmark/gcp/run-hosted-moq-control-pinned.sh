#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"
corridor="${GCP_BENCH_CORRIDOR:-virginia}"
run_prefix="${HOSTED_MOQ_RUN_PREFIX:-hosted-pinned}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${BENCHMARK_PROJECT_CONFIRM:-}" != "$project" ]]; then echo "Set BENCHMARK_PROJECT_CONFIRM to the same value as GCP_PROJECT" >&2; exit 1; fi
if [[ ! "$run_prefix" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then echo "Invalid run prefix" >&2; exit 1; fi
case "$corridor" in
  virginia) subscriber="transport-bench-sub-virginia"; subscriber_zone="us-east4-a" ;;
  frankfurt) subscriber="transport-bench-sub-frankfurt"; subscriber_zone="europe-west3-a" ;;
  tokyo) subscriber="transport-bench-sub-tokyo"; subscriber_zone="asia-northeast1-b" ;;
  *) echo "Invalid corridor" >&2; exit 1 ;;
esac

publisher="transport-bench-publisher-west"
publisher_zone="us-west2-a"
backup="/tmp/transport-hosts-${run_prefix}-${corridor}"

ssh_command() {
  local name="$1" zone="$2" command="$3"
  gcloud compute ssh "$name" --project="$project" --zone="$zone" --quiet --command="$command"
}

publisher_cdn_ip="$(ssh_command "$publisher" "$publisher_zone" "getent ahostsv4 cdn.moq.dev | sed -n '1s/ .*//p'")"
if [[ ! "$publisher_cdn_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "Could not resolve publisher's moq.dev IPv4 ingress" >&2
  exit 1
fi

restore_hosts() {
  ssh_command "$subscriber" "$subscriber_zone" \
    "if sudo test -f '$backup'; then sudo cp '$backup' /etc/hosts; sudo rm -f '$backup'; fi" \
    >/dev/null 2>&1 || true
}
trap restore_hosts EXIT INT TERM

ssh_command "$subscriber" "$subscriber_zone" \
  "sudo cp /etc/hosts '$backup' && printf '%s cdn.moq.dev # transport-benchmark-same-ingress\n' '$publisher_cdn_ip' | sudo tee -a /etc/hosts >/dev/null"

env \
  GCP_PROJECT="$project" \
  GCP_BENCH_CORRIDOR="$corridor" \
  HOSTED_MOQ_RUN_PREFIX="$run_prefix" \
  HOSTED_MOQ_SKIP_MEDIA=1 \
  "$root_dir/gcp/run-hosted-moq.sh"
