# Frozen transport benchmark protocol

Date frozen: 2026-07-18

## Purpose

This protocol compares the best qualified configuration of Cloudflare Realtime
SFU, PulseBeam, and `cloudflare/moq-rs` without hiding stock-release behavior or
conflating control latency with media latency. The primary media measurement is
capture-to-decoded-presentable-frame. It is a headless glass-to-glass proxy, not
a physical camera-to-display measurement.

No result is publishable unless every acceptance gate below passes. Failed and
excluded trials remain in the raw artifact set with the exclusion reason.

## Two explicit comparison lanes

### 1. Product-stack lane

Each platform is allowed to use its intended architecture:

- Cloudflare Realtime SFU uses its managed Anycast edge and HTTPS Sessions and
  Tracks API.
- PulseBeam uses one isolated self-hosted relay node in California.
- MoQ uses one isolated `moq-relay-ietf` node in California.

This answers: "Which complete platform gives the best result for this
workload?" Cloudflare's global placement is a product advantage, not a protocol
constant.

### 2. Self-hosted forwarding lane

PulseBeam and MoQ use the same relay VM, never concurrently, with the same
publisher and subscriber VMs. This answers: "Which self-hosted forwarding path
performs better under matched placement and compute?"

Cloudflare is shown as a managed reference but is not described as a
transport-isolation peer in this lane.

## Frozen implementations

Every report must include commit, image digest, build command, patch checksum,
and runtime arguments.

| Platform | Unmodified reference | Best-qualified candidate |
| --- | --- | --- |
| PulseBeam | Official `ghcr.io/pulsebeamdev/pulsebeam:pulsebeam-v0.4.6`, commit `4fb1f66e549d00051860992acded9f4954b83029` (annotated tag object `3fe1cf7841713e90b2d502adc151a306aafa1c17`) | Same v0.4.6 commit with only str0m's initial receiver-side BWE estimate changed from 500 kbit/s to 5 Mbit/s for the fixed-rate native sender; exact patch preserved |
| MoQ | `cloudflare/moq-rs` current main `5295993480c3d19f6057d0bb3c8b0b394ad1df62` | Same commit with only explicit `moq-sub` stdout flushes; exact patch preserved |
| Cloudflare | Current Realtime SFU Sessions/Tracks API | Same managed service; no private or undocumented tuning |

Frozen patch SHA-256 values are
`6ca65c1293e9ec20356fe5efb0ec0e0fab8db7044e7636724c06203a9b9f83ee`
for the PulseBeam BWE-start variant and
`8fa0fbacbae2f7ff9ec47c82480eb5413b9afda397720068a5e7f6bf2bc37f02`
for the `moq-sub` stdout-flush variant.

The best-qualified table is primary. When unmodified PulseBeam or MoQ rows are
included, they are labeled separately so minimal harness-compatibility fixes
are never presented as upstream releases.

PulseBeam's intended congestion-feedback behavior must also be qualified with a
standards-complete WebRTC receiver. The existing `node-datachannel` receiver
offers `goog-remb` but no transport-wide-CC extension. The harness does not
generate, parse, or record REMB explicitly, and no RTCP packet capture was
retained. PulseBeam v0.4.6 applies its downstream bitrate estimate only for
TWCC events, so an unmodified 500 kbit/s result from this client is diagnostic
only and cannot be used to claim PulseBeam's best media performance.

## Media workload

- Resolution: 1280×720.
- Frame rate: 30 fps.
- Codec: H.264 constrained baseline, packetization mode 1.
- GOP: 30 frames; no B-frames; scene-cut disabled.
- Encoder: the same pinned FFmpeg/libx264 build on every publisher.
- Decoder: the same pinned FFmpeg software decoder on every subscriber.
- Rate: strict 4.0 Mbit/s elementary stream, accepted only within ±5% after
  warmup. The source must be the deterministic `translated-texture-v1`, not the previous
  low-complexity checkerboard.
- Timestamp: capture epoch and frame ID embedded in a codec-aligned 16×9 pixel
  marker grid with CRC before encoding and accepted only after decode.
- RTP MTU: 1200 bytes for both WebRTC platforms.
- MoQ packaging: one CMAF chunk (`moof` + `mdat`) per frame.
- MoQ TLS: a per-benchmark private root CA signs a CA:false relay leaf whose
  subjectAltName is the relay's benchmark-only internal IP.
- Warmup: 150 frames; measured window: 9,000 frames; cooldown: 60 frames.

Counter clarification for the frozen implementation: the MoQ publisher's
historically named `measuredElementaryStream` field counts fMP4 output bytes
(`moof` + `mdat`), not bare Annex-B bytes. The paired qualification therefore
records both: 4,000,000 bit/s for bare H.264 and 4,027,168 bit/s including fMP4
container overhead. Reports must preserve both values and the derivation rather
than presenting the fMP4 counter as a second H.264 target.

The encoded elementary-stream byte count, RTP/MoQ payload byte count, frame
count, source scheduling skips, measured-window decoder-invalid marker count,
and total decoder-invalid marker count are mandatory artifacts. Invalid frames
during warmup/cooldown are reported but do not invalidate an otherwise exact
measured frame-ID set. A configured bitrate without an observed bitrate is not
evidence.

Measured-window loss, CRC-invalid frames, duplicates, reordering, and freezes
are platform outcomes, not exclusion criteria. They remain in the aggregate
and count against the provider. A trial is rejected only for a workload,
codec, clock, resource-saturation, or evidence-integrity defect.

## Control workload

Control is reported independently from video:

- 120 messages/second for five minutes.
- Full replaceable state payload, sequence number, and send timestamp.
- MoQ: QUIC datagrams at the largest size accepted by the pinned implementation.
- WebRTC: unordered DataChannel with zero retransmits.
- Report RTT P50/P95/P99/P99.9/max, delivery, duplicates, reordering, and stale
  arrivals.

Control RTT must never be numerically compared to one-way media latency as if
they shared a measurement boundary.

## Topology and trial order

- Publisher: California `us-west2-a`.
- Self-hosted relay: a separate California `us-west2-a` VM.
- Subscribers: Virginia `us-east4-a`, Frankfurt `europe-west3-a`, and Tokyo
  `asia-northeast1-b`.
- All endpoints and the relay use the same `c3-standard-4` machine type, image,
  disk class, network tier, and pinned dependency set.
- MoQ and PulseBeam never share relay CPU during a measured trial.
- Three accepted five-minute repetitions per provider and corridor.
- Provider order rotates to reduce time-of-day bias:
  1. MoQ → PulseBeam → Cloudflare
  2. PulseBeam → Cloudflare → MoQ
  3. Cloudflare → MoQ → PulseBeam
- A simultaneous media-plus-control repetition follows each media-only matrix.

## Acceptance and exclusion gates

A trial is accepted only when all conditions pass:

1. Both endpoint clock offsets are at most 1 ms; the actual offsets are saved.
2. Source scheduling has zero skipped measured frames.
3. Observed H.264 elementary-stream rate is within ±5% of 4.0 Mbit/s.
4. Per-second host CPU P95 remains below 80%, and benchmark cgroups show zero
   increase in `throttled_usec`. Per-process CPU, RSS, disk I/O, host memory,
   and network byte counters are retained as JSONL.
5. The selected network candidate pair and transport are recorded.
6. The exact expected measured ID interval is present; loss is reported rather
   than silently shortening the sample.
7. Marker CRC failures, decoder errors, process restarts, subscription retries,
   and relay errors are reported.
8. No configuration changes occur after viewing a provider's result. Any change
   invalidates the complete matrix and starts a new frozen run set.

Predeclared exclusion reasons are: failed clock gate, wrong encoded bitrate,
source scheduling skip, process crash, corrupt marker, or infrastructure loss.
Poor latency, loss, freezes, slow startup, or an unexpectedly bad provider result
are not exclusion reasons.

## Reported statistics

For every individual run and pooled provider/corridor set:

- Valid/expected frames and loss percentage.
- Latency P50/P95/P99/P99.9/max and mean.
- Presentation-gap P50/P99/max; freezes over 100 ms and 250 ms.
- Join time and every retry/error.
- Observed encoded and received bitrates.
- Endpoint and relay CPU/memory/network counters.
- Raw frame samples, logs, image digests, commit IDs, patches, configuration,
  clock evidence, and SHA-256 manifest.

The report shows individual-run values before pooled values. It does not rank a
provider whose qualification gate failed.

## Literal glass-to-glass follow-up

The headless test excludes camera exposure/capture and display scheduling/
scanout. A final physical validation should film an LED/timecode source and the
remote display simultaneously with a high-speed camera. That physical test is a
separate result and must not replace the reproducible headless measurement.

## Vendor-review packet

Before using the result in a decision or external conversation, provide
reviewers with this frozen protocol, exact patches, SDP offers/answers,
container/image digests, raw summaries, and the analysis script. Corrections
are accepted only by rerunning the complete frozen matrix.
