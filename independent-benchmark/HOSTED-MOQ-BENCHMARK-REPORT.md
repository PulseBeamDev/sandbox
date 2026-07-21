# Hosted MoQ benchmark extension

## Verdict

The moq.dev public demo CDN preserved MoQ's attractive control median in Virginia and delivered all 108,000 measured control echoes without loss, duplicates, or send failures. It did not preserve a tight global control tail: Frankfurt reached 2,066.9 ms P99.9 and Tokyo reached 662.2 ms P99. Media reliability was the larger problem: Virginia completed 3/3 five-minute runs, Frankfurt completed 0/2, and Tokyo completed 1/2. These public-demo-CDN results do not overturn the stronger result from the matched self-hosted `cloudflare/moq-rs` relay.

Cloudflare Managed MoQ was measured in a separate July 20 extension using the managed draft-14 endpoint and pinned `cloudflare/moq-rs` clients. Its media path completed 8/9 attempted five-minute runs. Its 120 Hz datagram control path observed loss in every corridor and therefore did not pass the benchmark's zero-loss control gate. Because this extension used a different protocol draft and run date, it is reported separately rather than merged into the earlier matched matrix.

## Cloudflare Managed MoQ extension

### Control: latest-state application RTT

Workload: 120 Hz, 1,100-byte QUIC datagrams, application round trip, 36,000 measured messages per corridor.

| Corridor | Delivered | Loss | P50 | P99 | Max | Result |
|---|---:|---:|---:|---:|---:|---|
| Frankfurt | 35,931 / 36,000 | 0.192% | 161.8 ms | 166.5 ms | 193.3 ms | measured; loss observed |
| Tokyo | 35,862 / 36,000 | 0.383% | 104.6 ms | 110.2 ms | 142.8 ms | measured; loss observed |
| Virginia | 17,382 / 36,000 | 51.717% | 70.2 ms | 76.3 ms | 112.9 ms | measured; loss observed |

A later Virginia 60 Hz diagnostic retry delivered 0 / 18,000 echoes. It is not used as a latency row and prevents interpreting the 120 Hz loss as a clean rate threshold.

### Media: headless glass-to-glass proxy

| Corridor | Completed / attempts | Accepted frames | P50 | P99 | Freezes >100 ms | Result |
|---|---:|---:|---:|---:|---:|---|
| Virginia | 2 / 3 | 18,000 / 18,000 | 176 ms | 183.3 ms | 2 | partial completion |
| Frankfurt | 3 / 3 | 27,000 / 27,000 | 223.9 ms | 231.7 ms | 3 | completed |
| Tokyo | 3 / 3 | 26,999 / 27,000 | 200.1 ms | 208.1 ms | 3 | completed |

The failed Virginia attempt delivered 3,594 / 9,000 frames before the WebTransport connection closed. It remains part of the completion result.

Across the eight completed trials, the aggregate was 71,999 / 72,000 frames. That aggregate does not hide or count the incomplete Virginia attempt as a completed run.

## moq.dev public CDN follow-up

### Control: latest-state application RTT

Both endpoints were pinned to the California-resolved moq.dev ingress, matching the original west-relay topology. A preliminary multi-edge qualification using independent west/east CDN edges returned 0/600 echoes, so it was not used as a latency result.

| Corridor | Delivered | Reordered | P50 | P99 | P99.9 | Max |
|---|---:|---:|---:|---:|---:|---:|
| Virginia | 36,000 / 36,000 | 19 | 73.4 ms | 74.1 ms | 79.9 ms | 174.8 ms |
| Frankfurt | 36,000 / 36,000 | 290 | 155.7 ms | 182.4 ms | 2066.9 ms | 2219.1 ms |
| Tokyo | 36,000 / 36,000 | 505 | 123.9 ms | 662.2 ms | 1496.2 ms | 1762.7 ms |

Reordering is reported rather than treated as loss because each update is a complete replaceable state. Loss, duplicates, and send failures remained hard rejection gates; all were zero.

### Media: headless glass-to-glass proxy

| Corridor | Completed / attempts | Accepted frames | P50 | P99 | Freezes >100 ms | Result |
|---|---:|---:|---:|---:|---:|---|
| Virginia | 3 / 3 | 27,000 / 27,000 | 233.1 ms | 308.3 ms | 3 | completed |
| Frankfurt | 0 / 2 | — | — | — | — | no completed trial |
| Tokyo | 1 / 2 | 9,000 / 9,000 | 245.4 ms | 256.9 ms | 1 | partial completion |

Failed attempts are part of the reliability result:

- Frankfurt attempt 1: 4,093 / 9,000 frames before relay transport connection closed.
- Frankfurt attempt 2: 0 / 9,000 frames before first decoded frame timed out.
- Tokyo attempt 1: 8,998 / 9,000 frames before relay remote error code 24.

The measurement stamps capture time and frame identity before H.264 encode and recovers them after software decode. It includes source scheduling, encode, transport/relay forwarding, receive, reassembly, and decode; it excludes camera exposure and display scanout.

## Tuning decision

The accepted media setting used `latency-max=100ms` and one fMP4 fragment per frame (`fragment-duration=0ms`). The seemingly faster `latency-max=0ms` setting was rejected: two Virginia runs completed, but the third delivered only 2,959 / 9,000 frames and lost 6,041.

## Scope and provenance

- Target: moq.dev public demo CDN at `https://cdn.moq.dev/anon`. Its own documentation describes this as a small, public, unauthenticated test cluster and warns users not to abuse it.
- Client: `moq.dev/moq` commit `b0115deeed82792a4dee41bb783b580fa03fbbfe`, `moq-cli 0.8.7`; identical release binary hashes were verified on both endpoints.
- Media: 1280x720, 30 fps, H.264 baseline, strict 4 Mbps, per-frame fragmented MP4, capture-to-decoded-presentable-frame.
- Control: 120 Hz, 1,100-byte latest-state updates, application round trip, 36,000 measured messages.
- Cloudflare Managed MoQ: draft-ietf-moq-transport-14, client revision `d98b8fc798bae9904916bf959206aaaac3ee5472`; credential path redacted.
- GCP endpoints: California publisher `us-west2-a`; subscribers `us-east4-a`, `europe-west3-a`, and `asia-northeast1-b`; `c3-standard-4`; synchronized clocks; endpoint resource gates passed.
- Cloudflare Managed MoQ API reference: https://developers.cloudflare.com/api/resources/moq
- Cloudflare MoQ overview: https://developers.cloudflare.com/moq/
- moq.dev public relay warning: https://doc.moq.dev/setup/dev
