#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"
corridor="${GCP_BENCH_CORRIDOR:-virginia}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="${CF_MANAGED_ARTIFACT_DIR:-$root_dir/results-cloudflare-managed-moq-gcp-20260720}"
relay_url="${CF_MANAGED_RELAY_URL:-}"
samples="${CF_MANAGED_SAMPLES:-9000}"
repetitions="${CF_MANAGED_REPETITIONS:-3}"
warmup_frames="${CF_MANAGED_WARMUP_FRAMES:-150}"
cooldown_frames="${CF_MANAGED_COOLDOWN_FRAMES:-60}"
grace_ms="${CF_MANAGED_GRACE_MS:-8000}"
control_samples="${CF_MANAGED_CONTROL_SAMPLES:-36000}"
control_warmup="${CF_MANAGED_CONTROL_WARMUP:-1200}"
control_rate_hz="${CF_MANAGED_CONTROL_RATE_HZ:-120}"
run_prefix="${CF_MANAGED_RUN_PREFIX:-cfmanaged}"
continue_on_media_failure="${CF_MANAGED_CONTINUE_ON_MEDIA_FAILURE:-1}"
skip_media="${CF_MANAGED_SKIP_MEDIA:-0}"

if [[ "${BENCHMARK_PROJECT_CONFIRM:-}" != "$project" ]]; then echo "Set BENCHMARK_PROJECT_CONFIRM to the same value as GCP_PROJECT" >&2; exit 1; fi
if [[ ! "$relay_url" =~ ^https://draft-14\.cloudflare\.mediaoverquic\.com/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
  echo "CF_MANAGED_RELAY_URL must be the credentialed Cloudflare draft-14 root URL" >&2
  exit 1
fi
if [[ ! "$samples" =~ ^[1-9][0-9]*$ || ! "$repetitions" =~ ^[1-9][0-9]*$ || ! "$control_samples" =~ ^[1-9][0-9]*$ || ! "$control_warmup" =~ ^[0-9]+$ || ! "$control_rate_hz" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid sample settings" >&2
  exit 1
fi
if [[ ! "$run_prefix" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then echo "Invalid run prefix" >&2; exit 1; fi
if [[ ! "$continue_on_media_failure" =~ ^[01]$ ]]; then echo "Invalid CF_MANAGED_CONTINUE_ON_MEDIA_FAILURE" >&2; exit 1; fi
if [[ ! "$skip_media" =~ ^[01]$ ]]; then echo "Invalid CF_MANAGED_SKIP_MEDIA" >&2; exit 1; fi
case "$corridor" in
  virginia) subscriber="transport-bench-sub-virginia"; subscriber_zone="us-east4-a" ;;
  frankfurt) subscriber="transport-bench-sub-frankfurt"; subscriber_zone="europe-west3-a" ;;
  tokyo) subscriber="transport-bench-sub-tokyo"; subscriber_zone="asia-northeast1-b" ;;
  *) echo "Invalid corridor" >&2; exit 1 ;;
esac

publisher="transport-bench-publisher-west"
publisher_zone="us-west2-a"
publisher_ip="$(gcloud compute instances describe "$publisher" --project="$project" --zone="$publisher_zone" --format='value(networkInterfaces[0].networkIP)')"
if [[ ! "$publisher_ip" =~ ^10\.42\.[0-9]+\.[0-9]+$ ]]; then echo "Unexpected publisher IP" >&2; exit 1; fi

ssh_command() {
  local name="$1" zone="$2" command="$3"
  gcloud compute ssh "$name" --project="$project" --zone="$zone" --quiet --command="$command"
}
start_monitor() {
  local name="$1" zone="$2" run_id="$3"
  ssh_command "$name" "$zone" "mkdir -p ~/independent-benchmark/resource-logs; nohup node ~/independent-benchmark/media/resource-monitor.mjs > ~/independent-benchmark/resource-logs/$run_id.jsonl 2>&1 & printf '%s' \$! > /tmp/$run_id.resource-monitor.pid"
}
stop_monitor() {
  local name="$1" zone="$2" run_id="$3"
  ssh_command "$name" "$zone" "if test -f /tmp/$run_id.resource-monitor.pid; then monitor_pid=\$(cat /tmp/$run_id.resource-monitor.pid); kill -INT \"\$monitor_pid\" 2>/dev/null || true; fi; sleep 2"
}

active_run_id=""
cleanup_active() {
  if [[ -n "$active_run_id" ]]; then
    stop_monitor "$publisher" "$publisher_zone" "$active_run_id" 2>/dev/null || true
    stop_monitor "$subscriber" "$subscriber_zone" "$active_run_id" 2>/dev/null || true
  fi
}
trap cleanup_active EXIT INT TERM

download_media_trial() {
  local run_id="$1" trial_dir="$artifact_dir/media-trials/$run_id"
  mkdir -p "$trial_dir/publisher" "$trial_dir/subscriber"
  gcloud compute scp --recurse "$publisher:~/independent-benchmark/results-cf-managed-moq/$run_id" "$trial_dir/publisher/" --project="$project" --zone="$publisher_zone" --quiet
  gcloud compute scp --recurse "$subscriber:~/independent-benchmark/results-cf-managed-moq/$run_id" "$trial_dir/subscriber/" --project="$project" --zone="$subscriber_zone" --quiet
  gcloud compute scp "$publisher:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/publisher/resource-monitor.jsonl" --project="$project" --zone="$publisher_zone" --quiet
  gcloud compute scp "$subscriber:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/subscriber/resource-monitor.jsonl" --project="$project" --zone="$subscriber_zone" --quiet
  node "$root_dir/analyze-media.mjs" "$trial_dir" "$trial_dir/analysis.json" >/dev/null
  jq -e '(.rejectedTrials | length) == 0 and (.trials | length) == 1' "$trial_dir/analysis.json" >/dev/null
  node "$root_dir/analyze-resources.mjs" "$trial_dir" "$trial_dir/resource-analysis.json" "publisher,subscriber" >/dev/null
  jq -e '.accepted == true' "$trial_dir/resource-analysis.json" >/dev/null
}

run_media_trial() {
  local repetition="$1" run_id="${run_prefix}-${corridor}-media-r${repetition}" token
  token="$(openssl rand -hex 24)"
  active_run_id="$run_id"
  start_monitor "$publisher" "$publisher_zone" "$run_id"
  start_monitor "$subscriber" "$subscriber_zone" "$run_id"
  mkdir -p "$artifact_dir/ssh-logs"
  common="MEDIA_RUN_ID=$run_id MEDIA_CORRIDOR=west-$corridor MEDIA_OUTPUT_DIR=results-cf-managed-moq/$run_id MEDIA_WARMUP_FRAMES=$warmup_frames MEDIA_SAMPLES=$samples MEDIA_COOLDOWN_FRAMES=$cooldown_frames MEDIA_GRACE_MS=$grace_ms MEDIA_SOURCE_PROFILE=translated-texture-v1 MEDIA_STRICT_CBR=1 MEDIA_REQUIRE_SYNC=1 MEDIA_CLOCK_MAX_OFFSET_MS=1 MEDIA_PROVIDER=cloudflare-managed-moq MOQ_IMPLEMENTATION='Cloudflare Managed MoQ; cloudflare/moq-rs d98b8fc draft-14' MOQ_CLIENT_FLAVOR=cloudflare-draft14 MOQ_BROADCAST=$run_id MOQ_PUB_BIN=/opt/cloudflare-managed-moq/bin/moq-pub MOQ_SUB_BIN=/opt/cloudflare-managed-moq/bin/moq-sub MOQ_RUST_LOG=off MOQ_IGNORE_REMOTE_RELAY_URL=1"
  publisher_command="cd ~/independent-benchmark && env MEDIA_ROLE=publisher MEDIA_TOKEN=$token MEDIA_COORDINATOR_PORT=8080 MOQ_RELAY_URL=$relay_url $common node media/moq-agent.mjs"
  subscriber_command="cd ~/independent-benchmark && env MEDIA_ROLE=subscriber MEDIA_TOKEN=$token MEDIA_COORDINATOR_URL=http://$publisher_ip:8080 MOQ_RELAY_URL=$relay_url $common node media/moq-agent.mjs"
  ssh_command "$publisher" "$publisher_zone" "$publisher_command" > "$artifact_dir/ssh-logs/$run_id-publisher.log" 2>&1 &
  publisher_pid=$!
  sleep 2
  set +e
  ssh_command "$subscriber" "$subscriber_zone" "$subscriber_command" > "$artifact_dir/ssh-logs/$run_id-subscriber.log" 2>&1
  subscriber_code=$?
  if [[ "$subscriber_code" -ne 0 ]]; then kill -TERM "$publisher_pid" 2>/dev/null || true; fi
  wait "$publisher_pid"
  publisher_code=$?
  set -e
  stop_monitor "$publisher" "$publisher_zone" "$run_id"
  stop_monitor "$subscriber" "$subscriber_zone" "$run_id"
  if [[ "$publisher_code" -ne 0 || "$subscriber_code" -ne 0 ]]; then
    failure_dir="$artifact_dir/media-failures/$run_id"
    mkdir -p "$failure_dir/publisher" "$failure_dir/subscriber"
    gcloud compute scp "$publisher:~/independent-benchmark/resource-logs/$run_id.jsonl" "$failure_dir/publisher/resource-monitor.jsonl" --project="$project" --zone="$publisher_zone" --quiet 2>/dev/null || true
    gcloud compute scp "$subscriber:~/independent-benchmark/resource-logs/$run_id.jsonl" "$failure_dir/subscriber/resource-monitor.jsonl" --project="$project" --zone="$subscriber_zone" --quiet 2>/dev/null || true
    cp "$artifact_dir/ssh-logs/$run_id-publisher.log" "$failure_dir/publisher/ssh.log"
    cp "$artifact_dir/ssh-logs/$run_id-subscriber.log" "$failure_dir/subscriber/ssh.log"
    partial="$(sed -n 's/.*"received":\([0-9][0-9]*\),"expected":\([0-9][0-9]*\).*/\1 \2/p' "$artifact_dir/ssh-logs/$run_id-subscriber.log" | tail -n 1)"
    partial_received="${partial%% *}"
    partial_expected="${partial##* }"
    if [[ -z "$partial" ]]; then partial_received=0; partial_expected="$samples"; fi
    jq -n \
      --arg runId "$run_id" --arg corridor "west-$corridor" \
      --argjson publisherExit "$publisher_code" --argjson subscriberExit "$subscriber_code" \
      --argjson received "$partial_received" --argjson expected "$partial_expected" \
      '{runId:$runId,corridor:$corridor,provider:"cloudflare-managed-moq",status:"failed",publisherExit:$publisherExit,subscriberExit:$subscriberExit,receivedBeforeFailure:$received,expected:$expected,reason:"transport exited before all measured frames arrived"}' \
      > "$failure_dir/failure.json"
    echo "$run_id failed: publisher=$publisher_code subscriber=$subscriber_code" >&2
    return 1
  fi
  download_media_trial "$run_id"
  active_run_id=""
  echo "Completed $run_id"
}

run_control_trial() {
  local run_id="${run_prefix}-${corridor}-control-${control_samples}samples"
  active_run_id="$run_id"
  start_monitor "$publisher" "$publisher_zone" "$run_id"
  start_monitor "$subscriber" "$subscriber_zone" "$run_id"
  mkdir -p "$artifact_dir/ssh-logs"
  common="MOQ_URL=$relay_url MOQ_RUN_ID=$run_id MOQ_CORRIDOR=west-$corridor MOQ_NAMESPACE=$run_id MOQ_SAMPLES=$control_samples MOQ_WARMUP=$control_warmup MOQ_RATE_HZ=$control_rate_hz MOQ_PAYLOAD_BYTES=1100 MOQ_START_DELAY_MS=8000 MOQ_SUBSCRIBE_TIMEOUT_MS=60000 MOQ_ALLOW_LOSS=true MOQ_OUTPUT_DIR=results-cf-managed-control/$run_id RUST_LOG=off"
  ssh_command "$subscriber" "$subscriber_zone" "cd ~/independent-benchmark && env MOQ_ROLE=b $common ./moq-managed-agent/target/release/moq-managed-benchmark-agent" > "$artifact_dir/ssh-logs/$run_id-reflector.log" 2>&1 &
  reflector_pid=$!
  sleep 2
  set +e
  ssh_command "$publisher" "$publisher_zone" "cd ~/independent-benchmark && env MOQ_ROLE=a $common ./moq-managed-agent/target/release/moq-managed-benchmark-agent" > "$artifact_dir/ssh-logs/$run_id-origin.log" 2>&1
  origin_code=$?
  wait "$reflector_pid"
  reflector_code=$?
  set -e
  stop_monitor "$publisher" "$publisher_zone" "$run_id"
  stop_monitor "$subscriber" "$subscriber_zone" "$run_id"
  if [[ "$origin_code" -ne 0 || "$reflector_code" -ne 0 ]]; then
    echo "$run_id failed: origin=$origin_code reflector=$reflector_code" >&2
    return 1
  fi
  trial_dir="$artifact_dir/control-trials/$run_id"
  mkdir -p "$trial_dir/origin" "$trial_dir/reflector"
  gcloud compute scp --recurse "$publisher:~/independent-benchmark/results-cf-managed-control/$run_id" "$trial_dir/origin/" --project="$project" --zone="$publisher_zone" --quiet
  gcloud compute scp --recurse "$subscriber:~/independent-benchmark/results-cf-managed-control/$run_id" "$trial_dir/reflector/" --project="$project" --zone="$subscriber_zone" --quiet
  gcloud compute scp "$publisher:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/origin/resource-monitor.jsonl" --project="$project" --zone="$publisher_zone" --quiet
  gcloud compute scp "$subscriber:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/reflector/resource-monitor.jsonl" --project="$project" --zone="$subscriber_zone" --quiet
  summary="$(find "$trial_dir/origin" -name '*-A.summary.json' -type f -print -quit)"
  jq -e '.received > 0 and .duplicates == 0 and .sendFailures == 0' "$summary" >/dev/null
  node "$root_dir/analyze-resources.mjs" "$trial_dir" "$trial_dir/resource-analysis.json" "origin,reflector" >/dev/null
  jq -e '.accepted == true' "$trial_dir/resource-analysis.json" >/dev/null
  active_run_id=""
  echo "Completed $run_id"
}

mkdir -p "$artifact_dir/manifests/$publisher" "$artifact_dir/manifests/$subscriber" "$artifact_dir/qualification/$publisher" "$artifact_dir/qualification/$subscriber" "$artifact_dir/routing"
for spec in "$publisher:$publisher_zone" "$subscriber:$subscriber_zone"; do
  name="${spec%%:*}"; zone="${spec##*:}"
  ssh_command "$name" "$zone" 'mkdir -p ~/independent-benchmark/manifests; { uname -a; lscpu; ffmpeg -version; node --version; chronyc tracking; cat /opt/transport-benchmark/manifests/cloudflare-managed-moq-*.txt; } > ~/independent-benchmark/manifests/cf-managed-system.txt'
  gcloud compute scp "$name:~/independent-benchmark/manifests/cf-managed-system.txt" "$artifact_dir/manifests/$name/system.txt" --project="$project" --zone="$zone" --quiet
  gcloud compute scp "$name:~/independent-benchmark/qualification/workload.json" "$artifact_dir/qualification/$name/workload.json" --project="$project" --zone="$zone" --quiet
done
publisher_edge="$(ssh_command "$publisher" "$publisher_zone" "getent ahostsv4 draft-14.cloudflare.mediaoverquic.com | sed -n '1s/ .*//p'")"
subscriber_edge="$(ssh_command "$subscriber" "$subscriber_zone" "getent ahostsv4 draft-14.cloudflare.mediaoverquic.com | sed -n '1s/ .*//p'")"
{
  printf 'service=Cloudflare Managed MoQ\nendpoint=https://draft-14.cloudflare.mediaoverquic.com/[managed-credential]\n'
  printf 'publisher=%s\npublisher_resolved_ipv4=%s\nsubscriber=%s\nsubscriber_resolved_ipv4=%s\n' "$publisher" "$publisher_edge" "$subscriber" "$subscriber_edge"
  printf 'credential_mode=full publish+subscribe token on both endpoints; subscribe-only media interop failed qualification\n'
} > "$artifact_dir/routing/${corridor}-${run_prefix}.txt"

media_failures=0
if [[ "$skip_media" == "0" ]]; then
  for repetition in $(seq 1 "$repetitions"); do
    if ! run_media_trial "$repetition"; then
      media_failures=$((media_failures + 1))
      if [[ "$continue_on_media_failure" == "0" ]]; then exit 1; fi
    fi
  done
fi
run_control_trial
if [[ "$skip_media" == "0" && -d "$artifact_dir/media-trials" ]]; then
  node "$root_dir/analyze-media.mjs" "$artifact_dir/media-trials" "$artifact_dir/media-analysis.json" >/dev/null
fi
node "$root_dir/analyze-moq.mjs" "$artifact_dir/control-trials" "$artifact_dir/control-analysis.json" >/dev/null
echo "Cloudflare Managed MoQ corridor completed: $corridor (media failures: $media_failures/$repetitions)"
