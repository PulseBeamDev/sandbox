# Transport benchmark

This is the reviewer-facing source packet for the July 2026 Cloudflare,
PulseBeam, `cloudflare/moq-rs`, and moq.dev experiments. It contains the
benchmark agents, frozen workload, deployment scripts, exact implementation
patches, selected reports, and final figures. Raw trial output is intentionally
kept outside Git and can be shared as a separate checksummed evidence archive.

The benchmark has two independent workloads:

- latest-state control traffic: complete replaceable messages at 120 Hz;
- media: a deterministic 1280x720p30 H.264 source with timestamps and frame IDs
  embedded before encode and recovered after decode.

This packet evaluates transport behavior, not a complete application protocol.
Reliable ordered operations require a separate workload and should not be
inferred from the latest-state results reported here.

## Start here

| Document | Purpose |
| --- | --- |
| [`FAIR-BENCHMARK-PROTOCOL.md`](FAIR-BENCHMARK-PROTOCOL.md) | Frozen workload, topology, versions, acceptance gates, and interpretation rules |
| [`FAIR-MEDIA-BENCHMARK-REPORT.md`](FAIR-MEDIA-BENCHMARK-REPORT.md) | Primary three-region, three-repetition media result |
| [`HOSTED-MOQ-BENCHMARK-REPORT.md`](HOSTED-MOQ-BENCHMARK-REPORT.md) | Follow-up against the public moq.dev CDN |
| [`moq-dev-one-frame-latency-diagnosis.md`](moq-dev-one-frame-latency-diagnosis.md) | Reproduction and validation of the moq.dev zero-fragment successor-frame delay |
| [`gcp/README.md`](gcp/README.md) | GCP provisioning, qualification, execution, and cleanup entry point |

The frozen fair matrix used a matched self-hosted relay for PulseBeam and
`moq-rs`; the hosted moq.dev work is a follow-up and is not silently mixed into
that primary table.

## REMB and PulseBeam bandwidth estimation

REMB was not actively used by the harness as a bandwidth-control input.

The native `node-datachannel` H.264 receiver's SDP advertised
`a=rtcp-fb:102 goog-remb`, but it did not advertise `transport-cc` or the
transport-wide congestion-control RTP header extension. The harness used
`RtcpReceivingSession` for ordinary RTCP receive-side handling; it did not
calculate, inject, parse, or record REMB packets. No RTCP packet capture was
retained, so the evidence only establishes what SDP advertised, not that REMB
feedback was emitted on the wire.

PulseBeam v0.4.6 initialized str0m BWE at 500 kbit/s and applied downstream
rate changes only for `EgressBitrateEstimate(BweKind::Twcc(...))`. With this
receiver, the estimate therefore remained at its starting value. The qualified
variant changed exactly one line, from `Bitrate::kbps(500)` to
`Bitrate::mbps(5)`; see [`gcp/pulsebeam-bwe-5m.patch`](gcp/pulsebeam-bwe-5m.patch)
and [`gcp/build-pulsebeam-bwe-variant.sh`](gcp/build-pulsebeam-bwe-variant.sh).

Those rows are explicitly labeled as a 5 Mbit/s initial-estimate variant. They
are not stock-v0.4.6 results and do not validate PulseBeam's adaptive BWE
behavior. The stock result is retained only as a diagnostic boundary case.

## What is and is not committed

Committed:

- Node and Rust benchmark agents with lockfiles;
- media codec, timestamp marker, coordination, and analysis code;
- pinned GCP provisioning/build/run scripts;
- exact PulseBeam, moq-rs, and moq.dev patches;
- frozen protocol, selected reports, and final charts.

Not committed:

- downloaded upstream source trees and compiled binaries;
- `node_modules` and Rust `target` directories;
- raw JSONL samples, service logs, SDP/ICE diagnostics, certificates, and VM
  manifests;
- superseded exploratory reports and preliminary figures.

The excluded artifacts remain locally available. Some logs contain short-lived
ICE credentials and infrastructure identifiers, which is why the raw archive
must be reviewed separately before distribution.

## Reviewer validation

The lightweight checks do not require cloud credentials:

```sh
npm ci
find . -maxdepth 2 -name '*.mjs' -type f -print0 | xargs -0 -n1 node --check
find gcp -maxdepth 1 -name '*.sh' -type f -print0 | xargs -0 -n1 bash -n
npm run media:test-codec
cargo check --locked --manifest-path moq-agent/Cargo.toml
cargo check --locked --manifest-path moq-managed-agent/Cargo.toml
```

`moq-dev-agent` deliberately uses path dependencies from the pinned moq.dev
checkout. `gcp/build-hosted-moq-clients.sh` clones that exact revision before
building it; a fresh checkout cannot run its Cargo command until that script's
`.tools/moq-dev-src` dependency has been populated.

## Install

```sh
npm ci
```

Use Node.js 22 or newer. Keep Cloudflare credentials in environment variables;
do not put them in a source file or command history.

## Single-host comparison

Both peers run in one process. This is useful for repeatability and regional
placement checks, but it is not a cross-region test.

```sh
CALLS_APP_ID=... \
CALLS_APP_SECRET=... \
PULSEBEAM_ENDPOINT=https://example/api/v1/rooms/demo/participants \
npm run benchmark -- --provider both --rate 120 --payload 1200 --samples 36000
```

Analyze the generated report and JSONL files with:

```sh
npm run analyze -- results/<report.json>
```

## Split-host application-RTT test

The distributed harness uses two unidirectional channels. Role A sends a
snapshot; role B immediately echoes it on the reverse channel. Role A measures
the full application round trip with its own monotonic clock, so clock sync
between hosts is not required.

Start role A first and allow role B to reach its coordinator port:

```sh
DIST_ROLE=A \
DIST_PROVIDER=cloudflare \
DIST_TOKEN="$(openssl rand -hex 24)" \
DIST_COORDINATOR_PORT=8080 \
DIST_RUN_ID=west-frankfurt-01 \
DIST_CORRIDOR=west-frankfurt \
DIST_SAMPLES=36000 \
DIST_WARMUP=1200 \
DIST_RATE_HZ=120 \
DIST_PAYLOAD_BYTES=1200 \
CALLS_APP_ID=... \
CALLS_APP_SECRET=... \
npm run distributed
```

On role B, use the same token and settings plus role A's private/VPN address:

```sh
DIST_ROLE=B \
DIST_PROVIDER=cloudflare \
DIST_TOKEN=... \
DIST_COORDINATOR_URL=http://ROLE_A_ADDRESS:8080 \
DIST_RUN_ID=west-frankfurt-01 \
DIST_CORRIDOR=west-frankfurt \
DIST_SAMPLES=36000 \
DIST_WARMUP=1200 \
DIST_RATE_HZ=120 \
DIST_PAYLOAD_BYTES=1200 \
CALLS_APP_ID=... \
CALLS_APP_SECRET=... \
npm run distributed
```

For PulseBeam, change `DIST_PROVIDER=pulsebeam`, omit the Cloudflare variables,
and set the same `PULSEBEAM_ENDPOINT` on both roles. Use a unique room or topic
namespace per concurrent test. Do not co-locate an endpoint with the SFU when
the goal is a realistic geographic comparison.

Aggregate downloaded split-host results with:

```sh
npm run analyze:distributed -- results-cross-region distributed-analysis.json
```

## Split-host MoQ datagram test

The Rust MoQ adapter uses `cloudflare/moq-rs` draft-16 QUIC datagrams. Role A
publishes `control`, role B echoes it as `telemetry`, and role A measures the
full application RTT with one monotonic clock. Build it with:

```sh
npm run moq:build
```

Start both roles against a unique relay path. They may start in either order:
each role now waits for exact-track `PUBLISH_OK`, then retries its reciprocal
subscription with bounded backoff until `SUBSCRIBE_OK`. No registration sleep
is required:

```sh
npm run moq:run -- \
  --role a \
  --url https://relay.example/run-01 \
  --run-id run-01 \
  --corridor west-frankfurt \
  --samples 7200 \
  --warmup 1200 \
  --rate-hz 120 \
  --payload-bytes 1100 \
  --tls-disable-verify
```

Run the same command on role B with `--role b`. A 1,200-byte MoQ object is too
large for the implementation's QUIC datagram once MoQT and WebTransport
framing are included, so the production-shaped MoQ default is 1,100 bytes.
This differs from the 1,200-byte application payload in the SFU tests and must
be called out in direct comparisons.

Analyze downloaded results with:

```sh
npm run analyze:moq -- results-cross-region-moq moq-analysis.json
```

Run the local startup, concurrency, rate, and payload stress matrix against a
development relay with:

```sh
npm run moq:stress -- \
  --profile full \
  --url https://localhost:4443/stress \
  --output results-moq-stress/local
```

`--profile startup-only` deliberately starts one role 750 ms early to exercise
subscription retry. `--profile boundaries` narrows the local throughput and
datagram-framing limits. The stress harness expects the release agent to have
been built first and uses `--tls-disable-verify`; do not use that TLS option for
a production relay.

For simultaneous trials, correlate their wall-clock event windows with:

```sh
npm run correlate -- cloudflare-A.jsonl pulsebeam-A.jsonl 203
```

## Encoded-video latency test

The media harness adds a software glass-to-glass measurement for Cloudflare,
PulseBeam, and MoQ. It stamps capture time and frame ID into the pixels, encodes
H.264, transports the media, decodes it, and reads the marker from the decoded
frame. See [`FAIR-BENCHMARK-PROTOCOL.md`](FAIR-BENCHMARK-PROTOCOL.md) for the
frozen workload, GCP topology, clock requirements, and interpretation limits.

Validate the common H.264 marker path locally:

```sh
npm run media:test-codec
```

Run a distributed PulseBeam or Cloudflare publisher with `MEDIA_ROLE=publisher`
and a subscriber with `MEDIA_ROLE=subscriber`. The same coordination variables
used by the data harness apply, but the media harness uses `MEDIA_*` names:

```sh
MEDIA_ROLE=publisher \
MEDIA_PROVIDER=pulsebeam \
MEDIA_TOKEN=... \
MEDIA_COORDINATOR_PORT=8080 \
MEDIA_RUN_ID=west-frankfurt-pulsebeam-01 \
MEDIA_CORRIDOR=west-frankfurt \
MEDIA_WARMUP_FRAMES=150 \
MEDIA_SAMPLES=9000 \
MEDIA_COOLDOWN_FRAMES=60 \
MEDIA_REQUIRE_SYNC=1 \
PULSEBEAM_ENDPOINT=https://relay.example/api/v1/rooms/media-01/participants \
npm run media:webrtc
```

The subscriber adds `MEDIA_COORDINATOR_URL=http://PUBLISHER:8080`. For
Cloudflare, set `MEDIA_PROVIDER=cloudflare` and supply `CALLS_APP_ID` and
`CALLS_APP_SECRET` instead of `PULSEBEAM_ENDPOINT`.

Install the draft-16 MoQ media tools once:

```sh
npm run media:install-moq-pub
npm run media:install-moq-sub
npm run media:install-moq-relay
```

Then run `npm run media:moq` on both roles with the same `MEDIA_*` variables,
plus `MOQ_RELAY_URL`, a unique `MOQ_BROADCAST`, and a trusted relay certificate.
`MOQ_TLS_DISABLE_VERIFY=1` is available only for local development.

Aggregate downloaded subscriber summaries and frame samples with:

```sh
npm run analyze:media -- results-media-aws media-analysis.json
```
The first argument is the results directory and the second is the output JSON.
Non-local trials are rejected unless matching publisher/subscriber summaries
contain `chronyc tracking` offsets no greater than 1 ms.

## What to compare

Use fresh sessions, warm up before measurement, alternate or run providers
simultaneously, and retain raw sequence-level output. Report loss, reordering,
P50/P95/P99/P99.9/max, sender scheduling lag, event-loop delay, and
`bufferedAmount`. Before production use, also test failover, stale-state
rejection, safety behavior, actual cellular networks, media contention, and
multi-hour sessions.
