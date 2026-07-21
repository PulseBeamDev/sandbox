#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"
corridor="${GCP_BENCH_CORRIDOR:-virginia}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="${HOSTED_MOQ_ARTIFACT_DIR:-$root_dir/results-hosted-moq-gcp-20260718}"
samples="${HOSTED_MOQ_SAMPLES:-9000}"
repetitions="${HOSTED_MOQ_REPETITIONS:-3}"
warmup_frames="${HOSTED_MOQ_WARMUP_FRAMES:-150}"
cooldown_frames="${HOSTED_MOQ_COOLDOWN_FRAMES:-60}"
grace_ms="${HOSTED_MOQ_GRACE_MS:-8000}"
relay_mode="${HOSTED_MOQ_RELAY_MODE:-public}"
relay_url="${HOSTED_MOQ_RELAY_URL:-}"
run_prefix="${HOSTED_MOQ_RUN_PREFIX:-hosted}"
control_samples="${HOSTED_MOQ_CONTROL_SAMPLES:-36000}"
control_warmup="${HOSTED_MOQ_CONTROL_WARMUP:-1200}"
skip_media="${HOSTED_MOQ_SKIP_MEDIA:-0}"
skip_control="${HOSTED_MOQ_SKIP_CONTROL:-0}"
moq_dev_latency_max="${HOSTED_MOQ_DEV_LATENCY_MAX:-100ms}"
moq_dev_fragment_duration="${HOSTED_MOQ_DEV_FRAGMENT_DURATION:-0ms}"
implementation_override="${HOSTED_MOQ_IMPLEMENTATION:-}"

if [[ "${BENCHMARK_PROJECT_CONFIRM:-}" != "$project" ]]; then echo "Set BENCHMARK_PROJECT_CONFIRM to the same value as GCP_PROJECT" >&2; exit 1; fi
if [[ ! "$samples" =~ ^[1-9][0-9]*$ || ! "$repetitions" =~ ^[1-9][0-9]*$ || ! "$control_samples" =~ ^[1-9][0-9]*$ || ! "$control_warmup" =~ ^[0-9]+$ ]]; then echo "Invalid sample settings" >&2; exit 1; fi
if [[ ! "$run_prefix" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then echo "Invalid run prefix" >&2; exit 1; fi
if [[ ! "$skip_media" =~ ^[01]$ ]]; then echo "Invalid HOSTED_MOQ_SKIP_MEDIA" >&2; exit 1; fi
if [[ ! "$skip_control" =~ ^[01]$ ]]; then echo "Invalid HOSTED_MOQ_SKIP_CONTROL" >&2; exit 1; fi
if [[ ! "$moq_dev_latency_max" =~ ^[0-9]+ms$ || ! "$moq_dev_fragment_duration" =~ ^[0-9]+ms$ ]]; then echo "Invalid moq.dev media duration setting" >&2; exit 1; fi
if [[ "$relay_mode" != "public" && "$relay_mode" != "selfhosted" ]]; then echo "HOSTED_MOQ_RELAY_MODE must be public or selfhosted" >&2; exit 1; fi
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
publisher_ip="$(gcloud compute instances describe "$publisher" --project="$project" --zone="$publisher_zone" --format='value(networkInterfaces[0].networkIP)')"
if [[ ! "$publisher_ip" =~ ^10\.42\.[0-9]+\.[0-9]+$ ]]; then echo "Unexpected publisher IP" >&2; exit 1; fi
if [[ "$relay_mode" == "public" ]]; then
  relay_url="${relay_url:-https://cdn.moq.dev/anon}"
  if [[ "$relay_url" != "https://cdn.moq.dev/anon" ]]; then echo "Refusing unexpected public relay URL" >&2; exit 1; fi
  provider="moq-dev-cdn"
  implementation="${implementation_override:-moq.dev public CDN; moq-cli 0.8.7 b0115de}"
else
  relay_ip="$(gcloud compute instances describe "$relay" --project="$project" --zone="$relay_zone" --format='value(networkInterfaces[0].networkIP)')"
  if [[ ! "$relay_ip" =~ ^10\.42\.[0-9]+\.[0-9]+$ ]]; then echo "Unexpected relay IP" >&2; exit 1; fi
  relay_url="${relay_url:-https://$relay_ip/anon}"
  if [[ "$relay_url" != "https://$relay_ip/anon" ]]; then echo "Refusing unexpected self-hosted relay URL" >&2; exit 1; fi
  provider="moq-dev-selfhosted"
  implementation="${implementation_override:-moq.dev/moq b0115de self-hosted relay}"
fi
tls_env=""
if [[ "$relay_mode" == "selfhosted" ]]; then
  tls_env="MOQ_TLS_ROOT=\$HOME/independent-benchmark/relay-cert.pem MOQ_CLIENT_TLS_ROOT=\$HOME/independent-benchmark/relay-cert.pem"
fi

ssh_command() {
  local name="$1" zone="$2" command="$3"
  gcloud compute ssh "$name" --project="$project" --zone="$zone" --quiet --command="$command"
}
resolve_cdn_ipv4() {
  local name="$1" zone="$2" ip
  ip="$(ssh_command "$name" "$zone" "getent ahostsv4 cdn.moq.dev | sed -n '1s/ .*//p'")"
  if [[ ! "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    echo "Could not resolve an IPv4 address for cdn.moq.dev on $name" >&2
    return 1
  fi
  printf '%s' "$ip"
}
start_monitor() {
  local name="$1" zone="$2" run_id="$3"
  ssh_command "$name" "$zone" "mkdir -p ~/independent-benchmark/resource-logs; nohup node ~/independent-benchmark/media/resource-monitor.mjs > ~/independent-benchmark/resource-logs/$run_id.jsonl 2>&1 & printf '%s' \$! > /tmp/$run_id.resource-monitor.pid"
}
stop_monitor() {
  local name="$1" zone="$2" run_id="$3"
  ssh_command "$name" "$zone" "if test -f /tmp/$run_id.resource-monitor.pid; then monitor_pid=\$(cat /tmp/$run_id.resource-monitor.pid); kill -INT \"\$monitor_pid\" 2>/dev/null || true; fi; sleep 2"
}
relay_unit_for_run() {
  local run_id="$1"
  printf 'transport-moq-dev-%s.service' "$run_id"
}
stop_selfhosted_relay() {
  local run_id="${1:-}"
  [[ "$relay_mode" == "selfhosted" ]] || return 0
  [[ -n "$run_id" ]] || return 0
  local relay_unit
  relay_unit="$(relay_unit_for_run "$run_id")"
  ssh_command "$relay" "$relay_zone" \
    "sudo systemctl stop '$relay_unit' 2>/dev/null || true"
}
start_selfhosted_relay() {
  local run_id="$1" relay_unit
  [[ "$relay_mode" == "selfhosted" ]] || return 0
  relay_unit="$(relay_unit_for_run "$run_id")"
  stop_selfhosted_relay "$run_id"
  ssh_command "$relay" "$relay_zone" \
    "set -euo pipefail; config=/run/transport-$run_id-moq-dev.toml; printf '%s\n' '[log]' 'level = \"warn\"' '[server]' 'bind = \"$relay_ip:443\"' '[server.tls]' 'cert = \"/opt/transport-benchmark/tls/relay-cert.pem\"' 'key = \"/opt/transport-benchmark/tls/relay-key.pem\"' '[auth]' 'public = \"anon\"' | sudo tee \"\$config\" >/dev/null; sudo systemd-run --unit='$relay_unit' --property=Restart=no /opt/hosted-moq-bench/bin/moq-relay \"\$config\""
  ssh_command "$relay" "$relay_zone" \
    "for attempt in \$(seq 1 30); do systemctl is-active --quiet '$relay_unit' && exit 0; sleep 1; done; sudo journalctl --unit='$relay_unit' --no-pager; exit 1"
}
capture_selfhosted_relay() {
  local run_id="$1" relay_unit
  [[ "$relay_mode" == "selfhosted" ]] || return 0
  relay_unit="$(relay_unit_for_run "$run_id")"
  ssh_command "$relay" "$relay_zone" \
    "sudo journalctl --unit='$relay_unit' --no-pager > /tmp/$run_id-relay.log; sudo systemctl stop '$relay_unit' 2>/dev/null || true; sudo rm -f /run/transport-$run_id-moq-dev.toml; chmod 0644 /tmp/$run_id-relay.log"
}

active_run_id=""
cleanup_active() {
  if [[ -n "$active_run_id" ]]; then
    stop_monitor "$publisher" "$publisher_zone" "$active_run_id" 2>/dev/null || true
    stop_monitor "$subscriber" "$subscriber_zone" "$active_run_id" 2>/dev/null || true
    if [[ "$relay_mode" == "selfhosted" ]]; then
      stop_monitor "$relay" "$relay_zone" "$active_run_id" 2>/dev/null || true
    fi
  fi
  if [[ -n "$active_run_id" ]]; then
    stop_selfhosted_relay "$active_run_id" 2>/dev/null || true
  fi
}
trap cleanup_active EXIT INT TERM

download_media_trial() {
  local run_id="$1" trial_dir="$artifact_dir/media-trials/$run_id"
  mkdir -p "$trial_dir/publisher" "$trial_dir/subscriber"
  gcloud compute scp --recurse "$publisher:~/independent-benchmark/results-hosted-moq/$run_id" "$trial_dir/publisher/" --project="$project" --zone="$publisher_zone" --quiet
  gcloud compute scp --recurse "$subscriber:~/independent-benchmark/results-hosted-moq/$run_id" "$trial_dir/subscriber/" --project="$project" --zone="$subscriber_zone" --quiet
  gcloud compute scp "$publisher:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/publisher/resource-monitor.jsonl" --project="$project" --zone="$publisher_zone" --quiet
  gcloud compute scp "$subscriber:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/subscriber/resource-monitor.jsonl" --project="$project" --zone="$subscriber_zone" --quiet
  resource_roles="publisher,subscriber"
  if [[ "$relay_mode" == "selfhosted" ]]; then
    mkdir -p "$trial_dir/relay"
    gcloud compute scp "$relay:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/relay/resource-monitor.jsonl" --project="$project" --zone="$relay_zone" --quiet
    gcloud compute scp "$relay:/tmp/$run_id-relay.log" "$trial_dir/relay/service.log" --project="$project" --zone="$relay_zone" --quiet
    resource_roles="publisher,subscriber,relay"
  fi
  node "$root_dir/analyze-media.mjs" "$trial_dir" "$trial_dir/analysis.json" >/dev/null
  jq -e '(.rejectedTrials | length) == 0 and (.trials | length) == 1' "$trial_dir/analysis.json" >/dev/null
  node "$root_dir/analyze-resources.mjs" "$trial_dir" "$trial_dir/resource-analysis.json" "$resource_roles" >/dev/null
  jq -e '.accepted == true' "$trial_dir/resource-analysis.json" >/dev/null
}

run_media_trial() {
  local repetition="$1" run_id="${run_prefix}-${corridor}-moqdev-r${repetition}" trial_loss
  local token
  token="$(openssl rand -hex 24)"
  active_run_id="$run_id"
  start_selfhosted_relay "$run_id"
  start_monitor "$publisher" "$publisher_zone" "$run_id"
  start_monitor "$subscriber" "$subscriber_zone" "$run_id"
  if [[ "$relay_mode" == "selfhosted" ]]; then start_monitor "$relay" "$relay_zone" "$run_id"; fi
  mkdir -p "$artifact_dir/ssh-logs"
  common="$tls_env MEDIA_RUN_ID=$run_id MEDIA_CORRIDOR=west-$corridor MEDIA_OUTPUT_DIR=results-hosted-moq/$run_id MEDIA_WARMUP_FRAMES=$warmup_frames MEDIA_SAMPLES=$samples MEDIA_COOLDOWN_FRAMES=$cooldown_frames MEDIA_GRACE_MS=$grace_ms MEDIA_SOURCE_PROFILE=translated-texture-v1 MEDIA_STRICT_CBR=1 MEDIA_REQUIRE_SYNC=1 MEDIA_CLOCK_MAX_OFFSET_MS=1 MEDIA_PROVIDER=$provider MOQ_IMPLEMENTATION='$implementation' MOQ_CLIENT_FLAVOR=moq-dev MOQ_CLIENT_BIND=0.0.0.0:0 MOQ_DEV_LATENCY_MAX=$moq_dev_latency_max MOQ_DEV_FRAGMENT_DURATION=$moq_dev_fragment_duration MOQ_BROADCAST=$run_id.hang MOQ_PUB_BIN=/opt/hosted-moq-bench/bin/moq MOQ_SUB_BIN=/opt/hosted-moq-bench/bin/moq"
  publisher_command="cd ~/independent-benchmark && env MEDIA_ROLE=publisher MEDIA_TOKEN=$token MEDIA_COORDINATOR_PORT=8080 MOQ_RELAY_URL=$publisher_relay_url $common node media/moq-agent.mjs"
  subscriber_command="cd ~/independent-benchmark && env MEDIA_ROLE=subscriber MEDIA_TOKEN=$token MEDIA_COORDINATOR_URL=http://$publisher_ip:8080 MOQ_RELAY_URL=$subscriber_relay_url $common node media/moq-agent.mjs"
  ssh_command "$publisher" "$publisher_zone" "$publisher_command" > "$artifact_dir/ssh-logs/$run_id-publisher.log" 2>&1 &
  publisher_pid=$!
  sleep 2
  set +e
  ssh_command "$subscriber" "$subscriber_zone" "$subscriber_command" > "$artifact_dir/ssh-logs/$run_id-subscriber.log" 2>&1
  subscriber_code=$?
  if [[ "$subscriber_code" -ne 0 ]]; then
    # Do not leave the publisher waiting indefinitely for subscriber readiness
    # after a first-frame timeout or an early hosted-relay disconnect.
    kill -TERM "$publisher_pid" 2>/dev/null || true
  fi
  wait "$publisher_pid"
  publisher_code=$?
  set -e
  stop_monitor "$publisher" "$publisher_zone" "$run_id"
  stop_monitor "$subscriber" "$subscriber_zone" "$run_id"
  if [[ "$relay_mode" == "selfhosted" ]]; then stop_monitor "$relay" "$relay_zone" "$run_id"; fi
  capture_selfhosted_relay "$run_id"
  if [[ "$publisher_code" -ne 0 || "$subscriber_code" -ne 0 ]]; then
    echo "$run_id failed: publisher=$publisher_code subscriber=$subscriber_code" >&2
    return 1
  fi
  download_media_trial "$run_id"
  active_run_id=""
  trial_loss="$(jq -r '.aggregate[0].lost' "$artifact_dir/media-trials/$run_id/analysis.json")"
  echo "Completed $run_id (measured frame loss: $trial_loss)"
}

download_control_trial() {
  local run_id="$1" trial_dir="$artifact_dir/control-trials/$run_id"
  mkdir -p "$trial_dir/origin" "$trial_dir/reflector"
  gcloud compute scp --recurse "$publisher:~/independent-benchmark/results-hosted-control/$run_id" "$trial_dir/origin/" --project="$project" --zone="$publisher_zone" --quiet
  gcloud compute scp --recurse "$subscriber:~/independent-benchmark/results-hosted-control/$run_id" "$trial_dir/reflector/" --project="$project" --zone="$subscriber_zone" --quiet
  gcloud compute scp "$publisher:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/origin/resource-monitor.jsonl" --project="$project" --zone="$publisher_zone" --quiet
  gcloud compute scp "$subscriber:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/reflector/resource-monitor.jsonl" --project="$project" --zone="$subscriber_zone" --quiet
  resource_roles="origin,reflector"
  if [[ "$relay_mode" == "selfhosted" ]]; then
    mkdir -p "$trial_dir/relay"
    gcloud compute scp "$relay:~/independent-benchmark/resource-logs/$run_id.jsonl" "$trial_dir/relay/resource-monitor.jsonl" --project="$project" --zone="$relay_zone" --quiet
    gcloud compute scp "$relay:/tmp/$run_id-relay.log" "$trial_dir/relay/service.log" --project="$project" --zone="$relay_zone" --quiet
    resource_roles="origin,reflector,relay"
  fi
  summary="$(find "$trial_dir/origin" -name '*-A.summary.json' -type f -print -quit)"
  jq -e '.received == .expected and .lost == 0 and .duplicates == 0 and .sendFailures == 0' "$summary" >/dev/null
  node "$root_dir/analyze-resources.mjs" "$trial_dir" "$trial_dir/resource-analysis.json" "$resource_roles" >/dev/null
  jq -e '.accepted == true' "$trial_dir/resource-analysis.json" >/dev/null
}

run_control_trial() {
  local run_id="${run_prefix}-${corridor}-moqdev-control-${control_samples}samples" control_reordered
  active_run_id="$run_id"
  start_selfhosted_relay "$run_id"
  start_monitor "$publisher" "$publisher_zone" "$run_id"
  start_monitor "$subscriber" "$subscriber_zone" "$run_id"
  if [[ "$relay_mode" == "selfhosted" ]]; then start_monitor "$relay" "$relay_zone" "$run_id"; fi
  mkdir -p "$artifact_dir/ssh-logs"
  common="$tls_env MOQ_CLIENT_BIND=0.0.0.0:0 MOQ_RUN_ID=$run_id MOQ_CORRIDOR=west-$corridor MOQ_NAMESPACE=$run_id MOQ_FLAT_BROADCAST_NAMES=true MOQ_PROVIDER=$provider MOQ_IMPLEMENTATION='$implementation' MOQ_SAMPLES=$control_samples MOQ_WARMUP=$control_warmup MOQ_RATE_HZ=120 MOQ_PAYLOAD_BYTES=1100 MOQ_OUTPUT_DIR=results-hosted-control/$run_id"
  ssh_command "$subscriber" "$subscriber_zone" "cd ~/independent-benchmark && env MOQ_ROLE=b MOQ_CLIENT_CONNECT=$subscriber_relay_url $common /opt/hosted-moq-bench/bin/moq-dev-benchmark-agent" > "$artifact_dir/ssh-logs/$run_id-reflector.log" 2>&1 &
  reflector_pid=$!
  sleep 2
  set +e
  ssh_command "$publisher" "$publisher_zone" "cd ~/independent-benchmark && env MOQ_ROLE=a MOQ_CLIENT_CONNECT=$publisher_relay_url $common /opt/hosted-moq-bench/bin/moq-dev-benchmark-agent" > "$artifact_dir/ssh-logs/$run_id-origin.log" 2>&1
  origin_code=$?
  wait "$reflector_pid"
  reflector_code=$?
  set -e
  stop_monitor "$publisher" "$publisher_zone" "$run_id"
  stop_monitor "$subscriber" "$subscriber_zone" "$run_id"
  if [[ "$relay_mode" == "selfhosted" ]]; then stop_monitor "$relay" "$relay_zone" "$run_id"; fi
  capture_selfhosted_relay "$run_id"
  if [[ "$origin_code" -ne 0 || "$reflector_code" -ne 0 ]]; then
    echo "$run_id failed: origin=$origin_code reflector=$reflector_code" >&2
    return 1
  fi
  download_control_trial "$run_id"
  active_run_id=""
  control_reordered="$(jq -r '.outOfOrder' "$artifact_dir/control-trials/$run_id/origin"/*/*-A.summary.json)"
  echo "Completed $run_id (lossless; reordered echoes: $control_reordered)"
}

mkdir -p "$artifact_dir/manifests/$publisher" "$artifact_dir/manifests/$subscriber" "$artifact_dir/qualification/$publisher" "$artifact_dir/qualification/$subscriber"
publisher_relay_url="$relay_url"
subscriber_relay_url="$relay_url"
mkdir -p "$artifact_dir/routing"
if [[ "$relay_mode" == "public" ]]; then
  publisher_cdn_ip="$(resolve_cdn_ipv4 "$publisher" "$publisher_zone")"
  subscriber_cdn_ip="$(resolve_cdn_ipv4 "$subscriber" "$subscriber_zone")"
  {
    printf 'relay_mode=public\nlogical_relay=%s\n' "$relay_url"
    printf 'publisher_endpoint=%s\npublisher_resolved_ipv4=%s\n' "$publisher" "$publisher_cdn_ip"
    printf 'subscriber_endpoint=%s\nsubscriber_resolved_ipv4=%s\n' "$subscriber" "$subscriber_cdn_ip"
    printf 'client_bind=0.0.0.0:0\n'
  } > "$artifact_dir/routing/${corridor}-${run_prefix}.txt"
else
  mkdir -p "$artifact_dir/manifests/$relay"
  {
    printf 'relay_mode=selfhosted\nlogical_relay=%s\nrelay_instance=%s\nrelay_internal_ip=%s\n' "$relay_url" "$relay" "$relay_ip"
    printf 'publisher_endpoint=%s\nsubscriber_endpoint=%s\nclient_bind=0.0.0.0:0\n' "$publisher" "$subscriber"
  } > "$artifact_dir/routing/${corridor}-${run_prefix}.txt"
  ssh_command "$relay" "$relay_zone" 'mkdir -p ~/independent-benchmark/manifests; { uname -a; lscpu; chronyc tracking; cat /opt/transport-benchmark/manifests/moq-dev-hosted-clients.txt; } > ~/independent-benchmark/manifests/hosted-moq-system.txt'
  gcloud compute scp "$relay:~/independent-benchmark/manifests/hosted-moq-system.txt" "$artifact_dir/manifests/$relay/system.txt" --project="$project" --zone="$relay_zone" --quiet
fi
for spec in "$publisher:$publisher_zone" "$subscriber:$subscriber_zone"; do
  name="${spec%%:*}"; zone="${spec##*:}"
  ssh_command "$name" "$zone" 'mkdir -p ~/independent-benchmark/manifests; { uname -a; lscpu; ffmpeg -version; node --version; chronyc tracking; cat /opt/transport-benchmark/manifests/moq-dev-hosted-clients.txt; } > ~/independent-benchmark/manifests/hosted-moq-system.txt'
  gcloud compute scp "$name:~/independent-benchmark/manifests/hosted-moq-system.txt" "$artifact_dir/manifests/$name/system.txt" --project="$project" --zone="$zone" --quiet
  gcloud compute scp "$name:~/independent-benchmark/qualification/workload.json" "$artifact_dir/qualification/$name/workload.json" --project="$project" --zone="$zone" --quiet
done

if [[ "$skip_media" == "0" ]]; then
  for repetition in $(seq 1 "$repetitions"); do run_media_trial "$repetition"; done
fi
if [[ "$skip_control" == "0" ]]; then
  run_control_trial
fi
if [[ "$skip_media" == "0" ]]; then
  node "$root_dir/analyze-media.mjs" "$artifact_dir/media-trials" "$artifact_dir/media-analysis.json" >/dev/null
fi
echo "moq.dev $relay_mode corridor completed: $corridor"
