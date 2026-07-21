#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"
network="transport-bench"
machine_type="${GCP_MACHINE_TYPE:-c3-standard-4}"
max_run_duration="${GCP_MAX_RUN_DURATION:-8h}"
profile="${GCP_BENCH_PROFILE:-global}"
focused_corridor="${GCP_BENCH_CORRIDOR:-virginia}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image="${GCP_IMAGE:-$(gcloud compute images describe-from-family ubuntu-2404-lts-amd64 \
  --project=ubuntu-os-cloud --format='value(name)')}"

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

billing_enabled="$(gcloud billing projects describe "$project" --format='value(billingEnabled)')"
if [[ "$billing_enabled" != "True" ]]; then
  echo "Billing is not enabled for $project" >&2
  exit 1
fi

if [[ "$profile" == "focused" ]]; then
  case "$focused_corridor" in
    virginia) expected_subscriber="transport-bench-sub-virginia" ;;
    frankfurt) expected_subscriber="transport-bench-sub-frankfurt" ;;
    tokyo) expected_subscriber="transport-bench-sub-tokyo" ;;
  esac
  while IFS= read -r existing_subscriber; do
    [[ -z "$existing_subscriber" || "$existing_subscriber" == "$expected_subscriber" ]] && continue
    echo "Refusing to exceed the three-VM ceiling; delete $existing_subscriber first" >&2
    exit 1
  done < <(gcloud compute instances list --project="$project" \
    --filter='labels.purpose=transport-benchmark AND name~transport-bench-sub-' \
    --format='value(name)')
fi

ensure_network() {
  if ! gcloud compute networks describe "$network" --project="$project" >/dev/null 2>&1; then
    gcloud compute networks create "$network" \
      --project="$project" \
      --subnet-mode=custom \
      --bgp-routing-mode=regional
  fi
}

ensure_subnet() {
  local name="$1"
  local region="$2"
  local range="$3"
  if ! gcloud compute networks subnets describe "$name" --region="$region" --project="$project" >/dev/null 2>&1; then
    gcloud compute networks subnets create "$name" \
      --project="$project" \
      --network="$network" \
      --region="$region" \
      --range="$range" \
      --enable-private-ip-google-access
  fi
}

ensure_firewall() {
  local name="$1"
  shift
  if ! gcloud compute firewall-rules describe "$name" --project="$project" >/dev/null 2>&1; then
    gcloud compute firewall-rules create "$name" --project="$project" --network="$network" "$@"
  fi
}

create_instance() {
  local name="$1"
  local zone="$2"
  local subnet="$3"
  local role="$4"
  local tag="transport-endpoint"
  [[ "$role" == "relay" ]] && tag="transport-relay"

  if gcloud compute instances describe "$name" --zone="$zone" --project="$project" >/dev/null 2>&1; then
    echo "$name already exists; leaving it unchanged"
    return
  fi

  gcloud compute instances create "$name" \
    --project="$project" \
    --zone="$zone" \
    --machine-type="$machine_type" \
    --subnet="$subnet" \
    --network-tier=PREMIUM \
    --image="$image" \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size=30GB \
    --boot-disk-type=pd-balanced \
    --boot-disk-auto-delete \
    --no-service-account \
    --no-scopes \
    --labels=purpose=transport-benchmark,managed-by=benchmark-harness \
    --tags=transport-bench,"$tag" \
    --metadata=bench-role="$role",bench-image="$image" \
    --metadata-from-file=startup-script="$script_dir/bootstrap.sh" \
    --max-run-duration="$max_run_duration" \
    --instance-termination-action=DELETE \
    --quiet
}

ensure_network
ensure_subnet transport-bench-us-west2 us-west2 10.42.0.0/24
if [[ "$profile" == "global" || "$focused_corridor" == "virginia" ]]; then
  ensure_subnet transport-bench-us-east4 us-east4 10.42.1.0/24
fi
if [[ "$profile" == "global" || "$focused_corridor" == "frankfurt" ]]; then
  ensure_subnet transport-bench-europe-west3 europe-west3 10.42.2.0/24
fi
if [[ "$profile" == "global" || "$focused_corridor" == "tokyo" ]]; then
  ensure_subnet transport-bench-asia-northeast1 asia-northeast1 10.42.3.0/24
fi

ensure_firewall transport-bench-internal \
  --direction=INGRESS \
  --priority=1000 \
  --source-ranges=10.42.0.0/22 \
  --target-tags=transport-bench \
  --allow=tcp,udp,icmp

ssh_ip="${GCP_SSH_SOURCE_IP:-$(curl --ipv4 --fail --silent --show-error https://api.ipify.org)}"
if [[ ! "$ssh_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Could not determine a valid SSH source IPv4 address" >&2
  exit 1
fi
ensure_firewall transport-bench-ssh \
  --direction=INGRESS \
  --priority=1000 \
  --source-ranges="$ssh_ip/32" \
  --target-tags=transport-bench \
  --allow=tcp:22

create_instance transport-bench-publisher-west us-west2-a transport-bench-us-west2 publisher &
publisher_pid=$!
create_instance transport-bench-relay-west us-west2-a transport-bench-us-west2 relay &
relay_pid=$!
instance_pids=("$publisher_pid" "$relay_pid")
if [[ "$profile" == "global" ]]; then
  create_instance transport-bench-sub-virginia us-east4-a transport-bench-us-east4 subscriber &
  instance_pids+=("$!")
  create_instance transport-bench-sub-frankfurt europe-west3-a transport-bench-europe-west3 subscriber &
  instance_pids+=("$!")
  create_instance transport-bench-sub-tokyo asia-northeast1-b transport-bench-asia-northeast1 subscriber &
  instance_pids+=("$!")
else
  case "$focused_corridor" in
    virginia)
      create_instance transport-bench-sub-virginia us-east4-a transport-bench-us-east4 subscriber &
      ;;
    frankfurt)
      create_instance transport-bench-sub-frankfurt europe-west3-a transport-bench-europe-west3 subscriber &
      ;;
    tokyo)
      create_instance transport-bench-sub-tokyo asia-northeast1-b transport-bench-asia-northeast1 subscriber &
      ;;
  esac
  instance_pids+=("$!")
fi

wait "${instance_pids[@]}"

endpoint_ranges="$(gcloud compute instances list \
  --project="$project" \
  --filter='labels.purpose=transport-benchmark AND tags.items=transport-endpoint' \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)' \
  | awk 'NF { printf "%s%s/32", sep, $1; sep="," }')"
if [[ -z "$endpoint_ranges" ]]; then
  echo "No endpoint public IPs found" >&2
  exit 1
fi

ensure_firewall transport-bench-relays \
  --direction=INGRESS \
  --priority=1000 \
  --source-ranges="$endpoint_ranges" \
  --target-tags=transport-relay \
  --allow=tcp:443,tcp:3478,tcp:7070,udp:443,udp:3478

gcloud compute instances list \
  --project="$project" \
  --filter='labels.purpose=transport-benchmark' \
  --format='table(name,zone.basename(),machineType.basename(),status,networkInterfaces[0].networkIP:label=INTERNAL_IP,networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP,scheduling.maxRunDuration:label=MAX_RUN)'
