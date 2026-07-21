#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="${FAIR_ARTIFACT_DIR:-$root_dir/results-fair-gcp-20260718}"
samples="${FAIR_SAMPLES:-9000}"
repetitions="${FAIR_REPETITIONS:-3}"
warmup_frames="${FAIR_WARMUP_FRAMES:-150}"
cooldown_frames="${FAIR_COOLDOWN_FRAMES:-60}"
grace_ms="${FAIR_GRACE_MS:-8000}"
run_prefix="${FAIR_RUN_PREFIX:-fair}"
selected_corridors="${FAIR_CORRIDORS:-virginia,frankfurt,tokyo}"
selected_providers="${FAIR_PROVIDERS:-moq,pulsebeam,cloudflare}"
skip_existing="${FAIR_SKIP_EXISTING:-0}"

if [[ "${BENCHMARK_PROJECT_CONFIRM:-}" != "$project" ]]; then
  echo "Set BENCHMARK_PROJECT_CONFIRM to the same value as GCP_PROJECT" >&2
  exit 1
fi
if [[ ! "$samples" =~ ^[1-9][0-9]*$ || ! "$repetitions" =~ ^[1-9][0-9]*$ ]]; then
  echo "FAIR_SAMPLES and FAIR_REPETITIONS must be positive integers" >&2
  exit 1
fi
if [[ ! "$run_prefix" =~ ^[a-z0-9-]+$ || ! "$selected_corridors" =~ ^[a-z,]+$ || ! "$selected_providers" =~ ^[a-z,]+$ ]]; then
  echo "FAIR_RUN_PREFIX, FAIR_CORRIDORS, or FAIR_PROVIDERS has an unsafe value" >&2
  exit 1
fi
if [[ "$skip_existing" != "0" && "$skip_existing" != "1" ]]; then
  echo "FAIR_SKIP_EXISTING must be 0 or 1" >&2
  exit 1
fi
for provider in ${selected_providers//,/ }; do
  case "$provider" in moq|pulsebeam|cloudflare) ;; *) echo "Unsupported FAIR_PROVIDERS entry: $provider" >&2; exit 1 ;; esac
done
if [[ ",$selected_providers," == *,cloudflare,* ]] && { [[ ! "${CALLS_APP_ID:-}" =~ ^[0-9a-f]{32}$ ]] || [[ ! "${CALLS_APP_SECRET:-}" =~ ^[0-9a-f]{64}$ ]]; }; then
  echo "CALLS_APP_ID and CALLS_APP_SECRET must be set to the Cloudflare trial credentials" >&2
  exit 1
fi

publisher="transport-bench-publisher-west"
publisher_zone="us-west2-a"
relay="transport-bench-relay-west"
relay_zone="us-west2-a"
publisher_ip="$(gcloud compute instances describe "$publisher" --project="$project" \
  --zone="$publisher_zone" --format='value(networkInterfaces[0].networkIP)')"
relay_ip="$(gcloud compute instances describe "$relay" --project="$project" \
  --zone="$relay_zone" --format='value(networkInterfaces[0].networkIP)')"
if [[ ! "$publisher_ip" =~ ^10\.42\.[0-9]+\.[0-9]+$ || ! "$relay_ip" =~ ^10\.42\.[0-9]+\.[0-9]+$ ]]; then
  echo "Unexpected benchmark internal addresses" >&2
  exit 1
fi

corridors=(
  "virginia:transport-bench-sub-virginia:us-east4-a"
  "frankfurt:transport-bench-sub-frankfurt:europe-west3-a"
  "tokyo:transport-bench-sub-tokyo:asia-northeast1-b"
)

ssh_command() {
  local name="$1"
  local zone="$2"
  local command="$3"
  gcloud compute ssh "$name" --project="$project" --zone="$zone" --quiet --command="$command"
}

cloudflare_ssh_command() {
  local name="$1"
  local zone="$2"
  local command="$3"
  printf '%s\n%s\n' "$CALLS_APP_ID" "$CALLS_APP_SECRET" | \
    gcloud compute ssh "$name" --project="$project" --zone="$zone" --quiet \
      --command="IFS= read -r CALLS_APP_ID; IFS= read -r CALLS_APP_SECRET; export CALLS_APP_ID CALLS_APP_SECRET; $command"
}

start_monitor() {
  local name="$1"
  local zone="$2"
  local run_id="$3"
  ssh_command "$name" "$zone" \
    "mkdir -p ~/independent-benchmark/resource-logs; nohup node ~/independent-benchmark/media/resource-monitor.mjs > ~/independent-benchmark/resource-logs/$run_id.jsonl 2>&1 & printf '%s' \$! > /tmp/$run_id.resource-monitor.pid"
}

stop_monitor() {
  local name="$1"
  local zone="$2"
  local run_id="$3"
  ssh_command "$name" "$zone" \
    "if test -f /tmp/$run_id.resource-monitor.pid; then monitor_pid=\$(cat /tmp/$run_id.resource-monitor.pid); kill -INT \"\$monitor_pid\" 2>/dev/null || true; fi; sleep 2"
}

stop_relay_services() {
  ssh_command "$relay" "$relay_zone" \
    'sudo systemctl stop transport-moq-trial.service 2>/dev/null || true; sudo docker rm --force transport-pulsebeam-trial >/dev/null 2>&1 || true'
}

active_run_id=""
active_subscriber=""
active_subscriber_zone=""
cleanup_active_trial() {
  if [[ -n "$active_run_id" ]]; then
    stop_monitor "$publisher" "$publisher_zone" "$active_run_id" 2>/dev/null || true
    stop_monitor "$active_subscriber" "$active_subscriber_zone" "$active_run_id" 2>/dev/null || true
    stop_monitor "$relay" "$relay_zone" "$active_run_id" 2>/dev/null || true
  fi
  stop_relay_services 2>/dev/null || true
}
trap cleanup_active_trial EXIT INT TERM

start_relay_service() {
  local provider="$1"
  local run_id="$2"
  stop_relay_services
  case "$provider" in
    moq)
      ssh_command "$relay" "$relay_zone" \
        "sudo rm -f /run/transport-$run_id-moq-coordinator.json; sudo systemd-run --unit=transport-moq-trial --property=Restart=no /opt/moq-media-fair/bin/moq-relay-ietf --bind $relay_ip:443 --tls-cert /opt/transport-benchmark/tls/relay-cert.pem --tls-key /opt/transport-benchmark/tls/relay-key.pem --coordinator-file /run/transport-$run_id-moq-coordinator.json"
      ssh_command "$relay" "$relay_zone" \
        'for attempt in $(seq 1 30); do systemctl is-active --quiet transport-moq-trial.service && exit 0; sleep 1; done; exit 1'
      ;;
    pulsebeam)
      ssh_command "$relay" "$relay_zone" \
        'sudo docker run --detach --name transport-pulsebeam-trial --network host --cap-add SYS_NICE --pull never transport-pulsebeam:bwe-5m --dev'
      ssh_command "$relay" "$relay_zone" \
        "for attempt in \$(seq 1 30); do curl --silent --output /dev/null http://$relay_ip:7070/ && exit 0; sleep 1; done; sudo docker logs transport-pulsebeam-trial; exit 1"
      ;;
    cloudflare)
      ;;
    *)
      echo "Unsupported provider: $provider" >&2
      exit 1
      ;;
  esac
}

capture_relay_evidence() {
  local provider="$1"
  local run_id="$2"
  case "$provider" in
    moq)
      ssh_command "$relay" "$relay_zone" \
        "sudo journalctl --unit=transport-moq-trial.service --no-pager > /tmp/$run_id-relay.log; sudo systemctl stop transport-moq-trial.service 2>/dev/null || true; sudo rm -f /run/transport-$run_id-moq-coordinator.json; chmod 0644 /tmp/$run_id-relay.log"
      ;;
    pulsebeam)
      ssh_command "$relay" "$relay_zone" \
        "sudo docker logs transport-pulsebeam-trial > /tmp/$run_id-relay.log 2>&1; sudo docker inspect transport-pulsebeam-trial > /tmp/$run_id-relay-inspect.json; sudo docker stop transport-pulsebeam-trial >/dev/null; sudo docker rm transport-pulsebeam-trial >/dev/null; chmod 0644 /tmp/$run_id-relay.log /tmp/$run_id-relay-inspect.json"
      ;;
    cloudflare)
      ssh_command "$relay" "$relay_zone" \
        "printf '%s\n' 'Cloudflare Realtime managed service; no process ran on the self-hosted relay.' > /tmp/$run_id-relay.log"
      ;;
  esac
}

common_media_env() {
  local run_id="$1"
  local corridor="$2"
  printf '%s' \
    "MEDIA_RUN_ID=$run_id MEDIA_CORRIDOR=west-$corridor MEDIA_OUTPUT_DIR=results-fair-gcp/$run_id MEDIA_WARMUP_FRAMES=$warmup_frames MEDIA_SAMPLES=$samples MEDIA_COOLDOWN_FRAMES=$cooldown_frames MEDIA_GRACE_MS=$grace_ms MEDIA_SOURCE_PROFILE=translated-texture-v1 MEDIA_STRICT_CBR=1 MEDIA_REQUIRE_SYNC=1 MEDIA_CLOCK_MAX_OFFSET_MS=1"
}

provider_media_env() {
  local provider="$1"
  local run_id="$2"
  case "$provider" in
    moq)
      printf '%s' "MOQ_RELAY_URL=https://$relay_ip MOQ_BROADCAST=$run_id MOQ_TLS_ROOT=\$HOME/independent-benchmark/relay-cert.pem MOQ_PUB_BIN=/opt/moq-media-fair/bin/moq-pub MOQ_SUB_BIN=/opt/moq-media-fair/bin/moq-sub"
      ;;
    pulsebeam)
      printf '%s' "MEDIA_PROVIDER=pulsebeam MEDIA_DEBUG_SIGNAL=1 PULSEBEAM_ENDPOINT=http://$relay_ip:7070/api/v1/rooms/$run_id/participants"
      ;;
    cloudflare)
      printf '%s' "MEDIA_PROVIDER=cloudflare MEDIA_DEBUG_SIGNAL=1"
      ;;
  esac
}

download_trial() {
  local provider="$1"
  local run_id="$2"
  local subscriber="$3"
  local subscriber_zone="$4"
  local trial_dir="$artifact_dir/trials/$run_id"
  mkdir -p "$trial_dir/publisher" "$trial_dir/subscriber" "$trial_dir/relay"
  gcloud compute scp --recurse \
    "$publisher:~/independent-benchmark/results-fair-gcp/$run_id" \
    "$trial_dir/publisher/" --project="$project" --zone="$publisher_zone" --quiet
  gcloud compute scp --recurse \
    "$subscriber:~/independent-benchmark/results-fair-gcp/$run_id" \
    "$trial_dir/subscriber/" --project="$project" --zone="$subscriber_zone" --quiet
  gcloud compute scp \
    "$publisher:~/independent-benchmark/resource-logs/$run_id.jsonl" \
    "$trial_dir/publisher/resource-monitor.jsonl" --project="$project" --zone="$publisher_zone" --quiet
  gcloud compute scp \
    "$subscriber:~/independent-benchmark/resource-logs/$run_id.jsonl" \
    "$trial_dir/subscriber/resource-monitor.jsonl" --project="$project" --zone="$subscriber_zone" --quiet
  gcloud compute scp \
    "$relay:~/independent-benchmark/resource-logs/$run_id.jsonl" \
    "$trial_dir/relay/resource-monitor.jsonl" --project="$project" --zone="$relay_zone" --quiet
  gcloud compute scp "$relay:/tmp/$run_id-relay.log" \
    "$trial_dir/relay/service.log" --project="$project" --zone="$relay_zone" --quiet
  if [[ "$provider" == "pulsebeam" ]]; then
    gcloud compute scp "$relay:/tmp/$run_id-relay-inspect.json" \
      "$trial_dir/relay/container-inspect.json" --project="$project" --zone="$relay_zone" --quiet
  fi
  node "$root_dir/analyze-media.mjs" "$trial_dir" "$trial_dir/analysis.json" >/dev/null
  jq -e '.rejectedTrials | length == 0' "$trial_dir/analysis.json" >/dev/null
  jq -e '.trials | length == 1' "$trial_dir/analysis.json" >/dev/null
  node "$root_dir/analyze-resources.mjs" "$trial_dir" "$trial_dir/resource-analysis.json" >/dev/null
  jq -e '.accepted == true' "$trial_dir/resource-analysis.json" >/dev/null
}

run_trial() {
  local provider="$1"
  local corridor="$2"
  local subscriber="$3"
  local subscriber_zone="$4"
  local repetition="$5"
  local run_id="$run_prefix-${corridor}-${provider}-r${repetition}"
  local token
  token="$(openssl rand -hex 24)"
  local common_env
  common_env="$(common_media_env "$run_id" "$corridor")"
  local platform_env
  platform_env="$(provider_media_env "$provider" "$run_id")"
  local script="media/webrtc-agent.mjs"
  [[ "$provider" == "moq" ]] && script="media/moq-agent.mjs"

  echo "Starting $run_id"
  active_run_id="$run_id"
  active_subscriber="$subscriber"
  active_subscriber_zone="$subscriber_zone"
  start_relay_service "$provider" "$run_id"
  start_monitor "$publisher" "$publisher_zone" "$run_id"
  start_monitor "$subscriber" "$subscriber_zone" "$run_id"
  start_monitor "$relay" "$relay_zone" "$run_id"

  publisher_command="cd ~/independent-benchmark && env MEDIA_ROLE=publisher MEDIA_TOKEN=$token MEDIA_COORDINATOR_PORT=8080 $common_env $platform_env node $script"
  subscriber_command="cd ~/independent-benchmark && env MEDIA_ROLE=subscriber MEDIA_TOKEN=$token MEDIA_COORDINATOR_URL=http://$publisher_ip:8080 $common_env $platform_env node $script"
  mkdir -p "$artifact_dir/ssh-logs"

  if [[ "$provider" == "cloudflare" ]]; then
    cloudflare_ssh_command "$publisher" "$publisher_zone" "$publisher_command" \
      > "$artifact_dir/ssh-logs/$run_id-publisher.log" 2>&1 &
  else
    ssh_command "$publisher" "$publisher_zone" "$publisher_command" \
      > "$artifact_dir/ssh-logs/$run_id-publisher.log" 2>&1 &
  fi
  publisher_pid=$!
  sleep 2

  set +e
  if [[ "$provider" == "cloudflare" ]]; then
    cloudflare_ssh_command "$subscriber" "$subscriber_zone" "$subscriber_command" \
      > "$artifact_dir/ssh-logs/$run_id-subscriber.log" 2>&1
  else
    ssh_command "$subscriber" "$subscriber_zone" "$subscriber_command" \
      > "$artifact_dir/ssh-logs/$run_id-subscriber.log" 2>&1
  fi
  subscriber_code=$?
  wait "$publisher_pid"
  publisher_code=$?
  set -e

  stop_monitor "$publisher" "$publisher_zone" "$run_id"
  stop_monitor "$subscriber" "$subscriber_zone" "$run_id"
  stop_monitor "$relay" "$relay_zone" "$run_id"
  capture_relay_evidence "$provider" "$run_id"

  if [[ "$publisher_code" -ne 0 || "$subscriber_code" -ne 0 ]]; then
    echo "$run_id failed: publisher=$publisher_code subscriber=$subscriber_code" >&2
    return 1
  fi
  download_trial "$provider" "$run_id" "$subscriber" "$subscriber_zone"
  active_run_id=""
  active_subscriber=""
  active_subscriber_zone=""
  echo "Accepted $run_id"
}

trial_already_accepted() {
  local run_id="$1"
  local trial_dir="$artifact_dir/trials/$run_id"
  [[ -f "$trial_dir/analysis.json" && -f "$trial_dir/resource-analysis.json" ]] || return 1
  jq -e '.rejectedTrials | length == 0' "$trial_dir/analysis.json" >/dev/null \
    && jq -e '.trials | length == 1' "$trial_dir/analysis.json" >/dev/null \
    && jq -e '.accepted == true' "$trial_dir/resource-analysis.json" >/dev/null
}

for corridor_spec in "${corridors[@]}"; do
  IFS=: read -r corridor subscriber subscriber_zone <<< "$corridor_spec"
  if [[ ",$selected_corridors," != *",$corridor,"* ]]; then continue; fi
  for repetition in $(seq 1 "$repetitions"); do
    case "$repetition" in
      1) provider_order=(moq pulsebeam cloudflare) ;;
      2) provider_order=(pulsebeam cloudflare moq) ;;
      *) provider_order=(cloudflare moq pulsebeam) ;;
    esac
    for provider in "${provider_order[@]}"; do
      if [[ ",$selected_providers," != *",$provider,"* ]]; then continue; fi
      candidate_run_id="$run_prefix-${corridor}-${provider}-r${repetition}"
      if [[ "$skip_existing" == "1" ]] && trial_already_accepted "$candidate_run_id"; then
        echo "Skipping already accepted $candidate_run_id"
        continue
      fi
      run_trial "$provider" "$corridor" "$subscriber" "$subscriber_zone" "$repetition"
    done
  done
done

node "$root_dir/analyze-media.mjs" "$artifact_dir/trials" "$artifact_dir/media-analysis.json" >/dev/null
echo "Fair cross-region media matrix completed: $artifact_dir/media-analysis.json"
