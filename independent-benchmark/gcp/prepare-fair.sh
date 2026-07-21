#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"
profile="${GCP_BENCH_PROFILE:-global}"
focused_corridor="${GCP_BENCH_CORRIDOR:-virginia}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="${FAIR_ARTIFACT_DIR:-$root_dir/results-fair-gcp-20260718}"
reuse_base="${FAIR_REUSE_BASE:-0}"
prepare_pulsebeam="${FAIR_PREPARE_PULSEBEAM:-1}"
skip_moq_build="${FAIR_SKIP_MOQ_BUILD:-0}"

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
if [[ "$reuse_base" != "0" && "$reuse_base" != "1" ]]; then
  echo "FAIR_REUSE_BASE must be 0 or 1" >&2
  exit 1
fi
if [[ "$prepare_pulsebeam" != "0" && "$prepare_pulsebeam" != "1" ]]; then
  echo "FAIR_PREPARE_PULSEBEAM must be 0 or 1" >&2
  exit 1
fi
if [[ "$skip_moq_build" != "0" && "$skip_moq_build" != "1" ]]; then
  echo "FAIR_SKIP_MOQ_BUILD must be 0 or 1" >&2
  exit 1
fi
if [[ "$reuse_base" == "1" && "$profile" != "focused" ]]; then
  echo "FAIR_REUSE_BASE=1 requires the focused profile" >&2
  exit 1
fi

instances=(
  "transport-bench-publisher-west:us-west2-a"
  "transport-bench-relay-west:us-west2-a"
)
endpoints=(
  "transport-bench-publisher-west:us-west2-a"
)
if [[ "$profile" == "global" ]]; then
  instances+=(
    "transport-bench-sub-virginia:us-east4-a"
    "transport-bench-sub-frankfurt:europe-west3-a"
    "transport-bench-sub-tokyo:asia-northeast1-b"
  )
  endpoints+=(
    "transport-bench-sub-virginia:us-east4-a"
    "transport-bench-sub-frankfurt:europe-west3-a"
    "transport-bench-sub-tokyo:asia-northeast1-b"
  )
else
  case "$focused_corridor" in
    virginia) focused_instance="transport-bench-sub-virginia:us-east4-a" ;;
    frankfurt) focused_instance="transport-bench-sub-frankfurt:europe-west3-a" ;;
    tokyo) focused_instance="transport-bench-sub-tokyo:asia-northeast1-b" ;;
  esac
  instances+=("$focused_instance")
  endpoints+=("$focused_instance")
fi

ssh_command() {
  local spec="$1"
  local command="$2"
  local name="${spec%%:*}"
  local zone="${spec##*:}"
  gcloud compute ssh "$name" --project="$project" --zone="$zone" --quiet --command="$command"
}

build_instances=("${instances[@]}")
qualification_endpoints=("${endpoints[@]}")
if [[ "$reuse_base" == "1" ]]; then
  build_instances=("$focused_instance")
  qualification_endpoints=("$focused_instance")
fi
build_pids=()
if [[ "$skip_moq_build" == "0" ]]; then
  for instance in "${build_instances[@]}"; do
    ssh_command "$instance" \
      'cd ~/independent-benchmark && ./gcp/build-moq-fair-variant.sh' &
    build_pids+=("$!")
  done
  for pid in "${build_pids[@]}"; do wait "$pid"; done
fi

if [[ "$reuse_base" == "0" && "$prepare_pulsebeam" == "1" ]]; then
  ssh_command "transport-bench-relay-west:us-west2-a" \
    'cd ~/independent-benchmark && ./gcp/build-pulsebeam-bwe-variant.sh'
fi

for endpoint in "${qualification_endpoints[@]}"; do
  ssh_command "$endpoint" \
    'set -euo pipefail; cd ~/independent-benchmark; mkdir -p qualification; temp_file="$(mktemp qualification/workload.XXXXXX)"; trap '\''rm -f "$temp_file"'\'' EXIT; node media/qualify-workload.mjs | tee "$temp_file"; mv "$temp_file" qualification/workload.json; trap - EXIT'
done

relay_internal_ip="$(gcloud compute instances describe transport-bench-relay-west \
  --project="$project" --zone=us-west2-a \
  --format='value(networkInterfaces[0].networkIP)')"
if [[ ! "$relay_internal_ip" =~ ^10\.42\.[0-9]+\.[0-9]+$ ]]; then
  echo "Unexpected relay internal IP: $relay_internal_ip" >&2
  exit 1
fi

if [[ "$reuse_base" == "0" ]]; then
  ssh_command "transport-bench-relay-west:us-west2-a" \
    "set -euo pipefail; tls=/opt/transport-benchmark/tls; sudo install -d -m 0700 \"\$tls\"; sudo rm -f \"\$tls\"/ca-cert.srl; sudo openssl req -x509 -newkey rsa:2048 -nodes -keyout \"\$tls\"/ca-key.pem -out \"\$tls\"/ca-cert.pem -days 1 -subj /CN=transport-benchmark-root -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign; sudo openssl req -new -newkey rsa:2048 -nodes -keyout \"\$tls\"/relay-key.pem -out \"\$tls\"/relay.csr -subj /CN=$relay_internal_ip; printf '%s\n' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' 'subjectAltName=IP:$relay_internal_ip' | sudo tee \"\$tls\"/relay.ext >/dev/null; sudo openssl x509 -req -in \"\$tls\"/relay.csr -CA \"\$tls\"/ca-cert.pem -CAkey \"\$tls\"/ca-key.pem -CAcreateserial -out \"\$tls\"/relay-cert.pem -days 1 -sha256 -extfile \"\$tls\"/relay.ext; sudo chmod 0600 \"\$tls\"/ca-key.pem \"\$tls\"/relay-key.pem; sudo chmod 0644 \"\$tls\"/ca-cert.pem \"\$tls\"/relay-cert.pem; sudo cp \"\$tls\"/ca-cert.pem /tmp/transport-relay-cert.pem; sudo chmod 0644 /tmp/transport-relay-cert.pem"
else
  ssh_command "transport-bench-relay-west:us-west2-a" \
    'set -euo pipefail; tls=/opt/transport-benchmark/tls; sudo openssl verify -CAfile "$tls/ca-cert.pem" "$tls/relay-cert.pem"; sudo cp "$tls/ca-cert.pem" /tmp/transport-relay-cert.pem; sudo chmod 0644 /tmp/transport-relay-cert.pem'
fi

cert_temp="$(mktemp -d /tmp/transport-relay-cert.XXXXXX)"
gcloud compute scp transport-bench-relay-west:/tmp/transport-relay-cert.pem \
  "$cert_temp/relay-cert.pem" --project="$project" --zone=us-west2-a --quiet
for endpoint in "${endpoints[@]}"; do
  name="${endpoint%%:*}"
  zone="${endpoint##*:}"
  gcloud compute scp "$cert_temp/relay-cert.pem" \
    "$name:~/independent-benchmark/relay-cert.pem" \
    --project="$project" --zone="$zone" --quiet
done

for instance in "${instances[@]}"; do
  name="${instance%%:*}"
  zone="${instance##*:}"
  ssh_command "$instance" \
    'mkdir -p ~/independent-benchmark/manifests && { uname -a; lscpu; ffmpeg -version; node --version; npm --version; chronyc tracking; sha256sum ~/independent-benchmark/package-lock.json; } > ~/independent-benchmark/manifests/system.txt'
  mkdir -p "$artifact_dir/manifests/$name" "$artifact_dir/qualification/$name"
  gcloud compute scp "$name:~/independent-benchmark/manifests/system.txt" \
    "$artifact_dir/manifests/$name/system.txt" \
    --project="$project" --zone="$zone" --quiet
  gcloud compute scp "$name:~/independent-benchmark/qualification/workload.json" \
    "$artifact_dir/qualification/$name/workload.json" \
    --project="$project" --zone="$zone" --quiet 2>/dev/null || true
done

gcloud compute scp --recurse \
  transport-bench-relay-west:/opt/transport-benchmark/manifests \
  "$artifact_dir/manifests/transport-bench-relay-west/implementations" \
  --project="$project" --zone=us-west2-a --quiet

echo "Fair benchmark implementations, workload, and TLS trust are qualified."
