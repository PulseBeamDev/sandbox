#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"
corridor="${GCP_BENCH_CORRIDOR:-virginia}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="${MOQ_RS_CONTROL_ARTIFACT_DIR:-$root_dir/results-moq-rs-control-gcp-20260719}"
samples="${MOQ_RS_CONTROL_SAMPLES:-36000}"
warmup="${MOQ_RS_CONTROL_WARMUP:-1200}"
run_prefix="${MOQ_RS_CONTROL_RUN_PREFIX:-implcmp}"

if [[ "${BENCHMARK_PROJECT_CONFIRM:-}" != "$project" ]]; then echo "Set BENCHMARK_PROJECT_CONFIRM to the same value as GCP_PROJECT" >&2; exit 1; fi
if [[ ! "$samples" =~ ^[1-9][0-9]*$ || ! "$warmup" =~ ^[0-9]+$ ]]; then echo "Invalid sample settings" >&2; exit 1; fi
if [[ ! "$run_prefix" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then echo "Invalid run prefix" >&2; exit 1; fi
case "$corridor" in
  virginia) subscriber="transport-bench-sub-virginia"; subscriber_zone="us-east4-a" ;;
  frankfurt) subscriber="transport-bench-sub-frankfurt"; subscriber_zone="europe-west3-a" ;;
  tokyo) subscriber="transport-bench-sub-tokyo"; subscriber_zone="asia-northeast1-b" ;;
  *) echo "Invalid corridor" >&2; exit 1 ;;
esac

publisher="transport-bench-publisher-west"
publisher_zone="us-west2-a"
relay="transport-bench-relay-west"
relay_zone="us-west2-a"
relay_ip="$(gcloud compute instances describe "$relay" --project="$project" --zone="$relay_zone" --format='value(networkInterfaces[0].networkIP)')"
if [[ ! "$relay_ip" =~ ^10\.42\.[0-9]+\.[0-9]+$ ]]; then echo "Unexpected relay IP" >&2; exit 1; fi

run_id="${run_prefix}-${corridor}-moqrs-control-${samples}samples"
relay_unit="transport-moq-rs-${run_id}.service"
coordinator_file="/run/transport-${run_id}-moq-coordinator.json"
active=0

ssh_command() {
  local name="$1" zone="$2" command="$3"
  gcloud compute ssh "$name" --project="$project" --zone="$zone" --quiet --command="$command"
}
start_monitor() {
  local name="$1" zone="$2"
  ssh_command "$name" "$zone" "mkdir -p ~/independent-benchmark/resource-logs; nohup node ~/independent-benchmark/media/resource-monitor.mjs > ~/independent-benchmark/resource-logs/$run_id.jsonl 2>&1 & printf '%s' \$! > /tmp/$run_id.resource-monitor.pid"
}
stop_monitor() {
  local name="$1" zone="$2"
  ssh_command "$name" "$zone" "if test -f /tmp/$run_id.resource-monitor.pid; then monitor_pid=\$(cat /tmp/$run_id.resource-monitor.pid); kill -INT \"\$monitor_pid\" 2>/dev/null || true; fi; sleep 2"
}
stop_relay() {
  ssh_command "$relay" "$relay_zone" "sudo systemctl stop '$relay_unit' 2>/dev/null || true; sudo rm -f '$coordinator_file'"
}
cleanup() {
  if [[ "$active" == "1" ]]; then
    stop_monitor "$publisher" "$publisher_zone" 2>/dev/null || true
    stop_monitor "$subscriber" "$subscriber_zone" 2>/dev/null || true
    stop_monitor "$relay" "$relay_zone" 2>/dev/null || true
    stop_relay 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

mkdir -p "$artifact_dir/ssh-logs" "$artifact_dir/control-trials/$run_id/origin" "$artifact_dir/control-trials/$run_id/reflector" "$artifact_dir/control-trials/$run_id/relay"
ssh_command "$relay" "$relay_zone" "sudo rm -f '$coordinator_file'; sudo systemd-run --unit='$relay_unit' --property=Restart=no /opt/moq-media-fair/bin/moq-relay-ietf --bind '$relay_ip:443' --tls-cert /opt/transport-benchmark/tls/relay-cert.pem --tls-key /opt/transport-benchmark/tls/relay-key.pem --coordinator-file '$coordinator_file'"
ssh_command "$relay" "$relay_zone" "for attempt in \$(seq 1 30); do systemctl is-active --quiet '$relay_unit' && exit 0; sleep 1; done; sudo journalctl --unit='$relay_unit' --no-pager; exit 1"
active=1
start_monitor "$publisher" "$publisher_zone"
start_monitor "$subscriber" "$subscriber_zone"
start_monitor "$relay" "$relay_zone"

common="MOQ_URL=https://$relay_ip MOQ_RUN_ID=$run_id MOQ_CORRIDOR=west-$corridor MOQ_NAMESPACE=$run_id MOQ_SAMPLES=$samples MOQ_WARMUP=$warmup MOQ_RATE_HZ=120 MOQ_PAYLOAD_BYTES=1100 MOQ_TLS_ROOT=\$HOME/independent-benchmark/relay-cert.pem MOQ_OUTPUT_DIR=results-moq-rs-control/$run_id"
ssh_command "$subscriber" "$subscriber_zone" "cd ~/independent-benchmark && env MOQ_ROLE=b $common ./moq-agent/target/release/moq-benchmark-agent" > "$artifact_dir/ssh-logs/$run_id-reflector.log" 2>&1 &
reflector_pid=$!
sleep 2
set +e
ssh_command "$publisher" "$publisher_zone" "cd ~/independent-benchmark && env MOQ_ROLE=a $common ./moq-agent/target/release/moq-benchmark-agent" > "$artifact_dir/ssh-logs/$run_id-origin.log" 2>&1
origin_code=$?
wait "$reflector_pid"
reflector_code=$?
set -e

stop_monitor "$publisher" "$publisher_zone"
stop_monitor "$subscriber" "$subscriber_zone"
stop_monitor "$relay" "$relay_zone"
ssh_command "$relay" "$relay_zone" "sudo journalctl --unit='$relay_unit' --no-pager > /tmp/$run_id-relay.log; sudo systemctl stop '$relay_unit' 2>/dev/null || true; sudo rm -f '$coordinator_file'; chmod 0644 /tmp/$run_id-relay.log"
if [[ "$origin_code" -ne 0 || "$reflector_code" -ne 0 ]]; then
  echo "$run_id failed: origin=$origin_code reflector=$reflector_code" >&2
  exit 1
fi

trial_dir="$artifact_dir/control-trials/$run_id"
gcloud compute scp --recurse "$publisher:~/independent-benchmark/results-moq-rs-control/$run_id" "$trial_dir/origin/" --project="$project" --zone="$publisher_zone" --quiet
gcloud compute scp --recurse "$subscriber:~/independent-benchmark/results-moq-rs-control/$run_id" "$trial_dir/reflector/" --project="$project" --zone="$subscriber_zone" --quiet
gcloud compute scp "$publisher:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/origin/resource-monitor.jsonl" --project="$project" --zone="$publisher_zone" --quiet
gcloud compute scp "$subscriber:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/reflector/resource-monitor.jsonl" --project="$project" --zone="$subscriber_zone" --quiet
gcloud compute scp "$relay:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/relay/resource-monitor.jsonl" --project="$project" --zone="$relay_zone" --quiet
gcloud compute scp "$relay:/tmp/$run_id-relay.log" "$trial_dir/relay/service.log" --project="$project" --zone="$relay_zone" --quiet

summary="$(find "$trial_dir/origin" -name '*-moq-A.summary.json' -type f -print -quit)"
jq -e '.received == .expected and .lost == 0 and .duplicates == 0 and .outOfOrder == 0 and .sendFailures == 0' "$summary" >/dev/null
node "$root_dir/analyze-resources.mjs" "$trial_dir" "$trial_dir/resource-analysis.json" "origin,reflector,relay" >/dev/null
jq -e '.accepted == true' "$trial_dir/resource-analysis.json" >/dev/null
node "$root_dir/analyze-moq.mjs" "$artifact_dir/control-trials" "$artifact_dir/control-analysis.json" >/dev/null
active=0
echo "Completed $run_id (lossless and resource-qualified)."
