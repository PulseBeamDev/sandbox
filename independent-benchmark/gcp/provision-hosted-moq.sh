#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT:?Set GCP_PROJECT to a dedicated benchmark project}"
corridor="${GCP_BENCH_CORRIDOR:-virginia}"
network="transport-bench"
machine_type="${GCP_MACHINE_TYPE:-c3-standard-4}"
max_run_duration="${GCP_MAX_RUN_DURATION:-5h}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image="${GCP_IMAGE:-$(gcloud compute images describe-from-family ubuntu-2404-lts-amd64 --project=ubuntu-os-cloud --format='value(name)')}"

if [[ "${BENCHMARK_PROJECT_CONFIRM:-}" != "$project" ]]; then
  echo "Set BENCHMARK_PROJECT_CONFIRM to the same value as GCP_PROJECT" >&2
  exit 1
fi
if [[ "$machine_type" != "c3-standard-4" ]]; then
  echo "Hosted benchmark is capped at c3-standard-4; got $machine_type" >&2
  exit 1
fi
case "$corridor" in
  virginia) subscriber="transport-bench-sub-virginia"; subscriber_zone="us-east4-a"; subscriber_region="us-east4"; subnet="transport-bench-us-east4"; range="10.42.1.0/24" ;;
  frankfurt) subscriber="transport-bench-sub-frankfurt"; subscriber_zone="europe-west3-a"; subscriber_region="europe-west3"; subnet="transport-bench-europe-west3"; range="10.42.2.0/24" ;;
  tokyo) subscriber="transport-bench-sub-tokyo"; subscriber_zone="asia-northeast1-b"; subscriber_region="asia-northeast1"; subnet="transport-bench-asia-northeast1"; range="10.42.3.0/24" ;;
  *) echo "GCP_BENCH_CORRIDOR must be virginia, frankfurt, or tokyo" >&2; exit 1 ;;
esac

if [[ "$(gcloud billing projects describe "$project" --format='value(billingEnabled)')" != "True" ]]; then
  echo "Billing is not enabled for $project" >&2
  exit 1
fi

while IFS= read -r existing; do
  [[ -z "$existing" || "$existing" == "transport-bench-publisher-west" || "$existing" == "$subscriber" ]] && continue
  echo "Refusing to exceed the two-VM hosted benchmark ceiling; unexpected instance: $existing" >&2
  exit 1
done < <(gcloud compute instances list --project="$project" \
  --filter='labels.purpose=transport-benchmark' --format='value(name)')

if ! gcloud compute networks describe "$network" --project="$project" >/dev/null 2>&1; then
  gcloud compute networks create "$network" --project="$project" --subnet-mode=custom --bgp-routing-mode=regional
fi
if ! gcloud compute networks subnets describe transport-bench-us-west2 --region=us-west2 --project="$project" >/dev/null 2>&1; then
  gcloud compute networks subnets create transport-bench-us-west2 --project="$project" --network="$network" --region=us-west2 --range=10.42.0.0/24 --enable-private-ip-google-access
fi
if ! gcloud compute networks subnets describe "$subnet" --region="$subscriber_region" --project="$project" >/dev/null 2>&1; then
  gcloud compute networks subnets create "$subnet" --project="$project" --network="$network" --region="$subscriber_region" --range="$range" --enable-private-ip-google-access
fi
if ! gcloud compute firewall-rules describe transport-bench-internal --project="$project" >/dev/null 2>&1; then
  gcloud compute firewall-rules create transport-bench-internal --project="$project" --network="$network" --direction=INGRESS --priority=1000 --source-ranges=10.42.0.0/22 --target-tags=transport-bench --allow=tcp,udp,icmp
fi
ssh_ip="${GCP_SSH_SOURCE_IP:-$(curl --ipv4 --fail --silent --show-error https://api.ipify.org)}"
if [[ ! "$ssh_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Could not determine a valid SSH source IPv4 address" >&2
  exit 1
fi
if ! gcloud compute firewall-rules describe transport-bench-ssh --project="$project" >/dev/null 2>&1; then
  gcloud compute firewall-rules create transport-bench-ssh --project="$project" --network="$network" --direction=INGRESS --priority=1000 --source-ranges="$ssh_ip/32" --target-tags=transport-bench --allow=tcp:22
fi

create_instance() {
  local name="$1" zone="$2" instance_subnet="$3" role="$4"
  if gcloud compute instances describe "$name" --project="$project" --zone="$zone" >/dev/null 2>&1; then
    echo "$name already exists; leaving it unchanged"
    return
  fi
  gcloud compute instances create "$name" --project="$project" --zone="$zone" \
    --machine-type="$machine_type" --subnet="$instance_subnet" --network-tier=PREMIUM \
    --image="$image" --image-project=ubuntu-os-cloud --boot-disk-size=30GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
    --no-service-account --no-scopes --labels=purpose=transport-benchmark,managed-by=benchmark-harness \
    --tags=transport-bench,transport-endpoint --metadata=bench-role="$role",bench-image="$image" \
    --metadata-from-file=startup-script="$script_dir/bootstrap.sh" \
    --max-run-duration="$max_run_duration" --instance-termination-action=DELETE --quiet
}

create_instance transport-bench-publisher-west us-west2-a transport-bench-us-west2 publisher &
publisher_pid=$!
create_instance "$subscriber" "$subscriber_zone" "$subnet" subscriber &
subscriber_pid=$!
wait "$publisher_pid" "$subscriber_pid"

count="$(gcloud compute instances list --project="$project" --filter='labels.purpose=transport-benchmark' --format='value(name)' | awk 'NF { count++ } END { print count+0 }')"
if [[ "$count" -gt 2 ]]; then
  echo "Safety check failed: $count benchmark instances exist" >&2
  exit 1
fi
gcloud compute instances list --project="$project" --filter='labels.purpose=transport-benchmark' \
  --format='table(name,zone.basename(),machineType.basename(),status,networkInterfaces[0].networkIP:label=INTERNAL_IP,networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP,scheduling.maxRunDuration:label=MAX_RUN)'
