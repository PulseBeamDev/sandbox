# GCP cross-region benchmark deployment

This deployment requires an isolated project supplied through `GCP_PROJECT`
and confirmed through `BENCHMARK_PROJECT_CONFIRM`. It creates five on-demand
`c3-standard-4` Ubuntu 24.04 VMs: separate publisher and relay VMs in Los
Angeles, and subscriber VMs in Northern Virginia, Frankfurt, and Tokyo.

Every VM has no Google Cloud service account and is automatically deleted after
eight hours. A dedicated VPC restricts SSH to the provisioning host's current
public IPv4 address. Relay ports are restricted to the four endpoint public
addresses. The default project network is not used or modified.

The provisioning and cleanup scripts refuse to operate unless both project
variables match. Before running them, authenticate `gcloud`, select an account
with access to a dedicated project, confirm billing and regional quota, and
review the resources in `provision.sh`. The default global profile can create
five `c3-standard-4` instances; `GCP_BENCH_PROFILE=focused` creates the
publisher, relay, and one selected subscriber instead.

```sh
export GCP_PROJECT=your-isolated-benchmark-project
export BENCHMARK_PROJECT_CONFIRM="$GCP_PROJECT"
```

Cloudflare credentials are read only from `CALLS_APP_ID` and
`CALLS_APP_SECRET`. They must not be written into scripts or result files.
PulseBeam and self-hosted MoQ need no third-party service credentials.

Provision and synchronize the harness with:

```sh
./gcp/provision.sh
./gcp/sync.sh
./gcp/prepare-fair.sh
```

`prepare-fair.sh` builds the frozen PulseBeam and MoQ variants, runs the common
strict-CBR codec qualification on every endpoint, creates the one-day trusted
benchmark relay certificate, and downloads implementation/system manifests.

Run a short Virginia acceptance matrix before the full paid matrix:

```sh
FAIR_RUN_PREFIX=smoke \
FAIR_CORRIDORS=virginia \
FAIR_SAMPLES=300 \
FAIR_REPETITIONS=1 \
CALLS_APP_ID=... \
CALLS_APP_SECRET=... \
./gcp/run-fair-media.sh
```

If all three smoke trials pass every media and resource gate, run the frozen
three-repetition, all-zone matrix with the default settings:

```sh
CALLS_APP_ID=... \
CALLS_APP_SECRET=... \
./gcp/run-fair-media.sh
```

The startup script installs FFmpeg, Node.js, Rust, `chrony`, the relevant
`moq-rs` media tool, and the official PulseBeam v0.4.6 container. It configures
`chrony` to use only `metadata.google.internal`. Before accepting any one-way
media result, preserve `chronyc tracking` and reject offsets over 1 ms.

After downloading every raw result and log, remove only the labeled benchmark
resources with:

```sh
./gcp/cleanup.sh --yes
```

The cleanup command deletes instances, firewall rules, subnets, and the VPC
whose benchmark labels and fixed names match this deployment. Raw results stay
on the workstation under `results-*`; Git ignores those directories so they
can be reviewed and sanitized before being shared as an evidence archive.
