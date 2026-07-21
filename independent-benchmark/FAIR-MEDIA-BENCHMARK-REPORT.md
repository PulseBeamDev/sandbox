# Fair global media benchmark

Frozen run: July 18–19, 2026, on isolated GCP benchmark infrastructure.

## Verdict

MoQ is the strongest media result in this matrix. It had the lowest P50 and P99 capture-to-decoded-frame latency in Virginia, Frankfurt, and Tokyo; delivered 81,000/81,000 measured frames; produced no invalid decoded markers; and recorded no presentation freezes over 250 ms. PulseBeam's qualified 5 Mbps-initial-BWE variant was reliable but slower. Cloudflare's managed SFU was close to MoQ on median latency, but frame loss, invalid markers, long freezes, and join time were worse in this run.

Within this frozen matrix, MoQ produced the strongest latency result, subject to production work around authorization, lifecycle, observability, codec interoperability, and literal camera/display validation. It does not prove that MoQ will win every network, load level, or implementation revision.

## What was measured

The primary boundary is a reproducible headless glass-to-glass proxy: a capture timestamp and frame ID are embedded into the source before H.264 encode and recovered after software decode. It includes source scheduling, encode, transport/platform forwarding, receive, depacketize/reassembly, and decode. It excludes physical camera exposure and display scheduling/scanout.

- Source: deterministic `translated-texture-v1`, 1280×720p30, H.264 constrained baseline, one-second GOP, no B-frames.
- Rate: strict 4,000,000 bit/s H.264 source. The WebRTC Annex-B counter records exactly 4,000,000 bit/s; MoQ's fMP4 byte counter records 4,027,168 bit/s because it includes the per-frame container overhead (0.6792%). Both were prequalified with zero decoded-frame or marker errors and pass the frozen ±5% gate.
- Window: 150 warmup frames, 9,000 measured frames, 60 cooldown frames.
- Repetitions: three accepted five-minute trials per provider and region; provider order rotated.
- Publisher and self-hosted relay: separate `c3-standard-4` VMs in `us-west2-a`.
- Subscribers: `us-east4-a`, `europe-west3-a`, and `asia-northeast1-b`, one active at a time.
- Maximum active compute: three `c3-standard-4` VMs, 12 vCPUs.

## Individual accepted runs

| Run | Provider | Region | Frames | Loss | P50 | P99 | Max | >100 ms | >250 ms | Join |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fair-frankfurt-cloudflare-r1 | Cloudflare | Frankfurt | 8,861/9,000 | 1.544% | 227.7 ms | 237 ms | 364.7 ms | 11 | 6 | 5315.1 ms |
| fair-frankfurt-cloudflare-r2 | Cloudflare | Frankfurt | 8,910/9,000 | 1.000% | 227.6 ms | 241.2 ms | 370.1 ms | 8 | 5 | 4321.4 ms |
| fair-frankfurt-cloudflare-r3 | Cloudflare | Frankfurt | 8,949/9,000 | 0.567% | 222.8 ms | 233.4 ms | 724.2 ms | 6 | 3 | 4311.6 ms |
| fair-frankfurt-moq-r1 | MoQ | Frankfurt | 9,000/9,000 | 0% | 221.7 ms | 227.9 ms | 304.6 ms | 1 | 0 | 1326.1 ms |
| fair-frankfurt-moq-r2 | MoQ | Frankfurt | 9,000/9,000 | 0% | 222 ms | 228.3 ms | 305.2 ms | 1 | 0 | 1527.6 ms |
| fair-frankfurt-moq-r3 | MoQ | Frankfurt | 9,000/9,000 | 0% | 221.8 ms | 227.9 ms | 307.4 ms | 1 | 0 | 1716.9 ms |
| fair-frankfurt-pulsebeam-r1 | PulseBeam variant | Frankfurt | 8,999/9,000 | 0.011% | 244.2 ms | 250.9 ms | 333.8 ms | 1 | 0 | 3153.4 ms |
| fair-frankfurt-pulsebeam-r2 | PulseBeam variant | Frankfurt | 9,000/9,000 | 0% | 243 ms | 249.5 ms | 330.6 ms | 1 | 0 | 3159.2 ms |
| fair-frankfurt-pulsebeam-r3 | PulseBeam variant | Frankfurt | 9,000/9,000 | 0% | 243.1 ms | 250.3 ms | 335.1 ms | 1 | 0 | 3156.8 ms |
| fair-tokyo-cloudflare-r1 | Cloudflare | Tokyo | 8,953/9,000 | 0.522% | 199 ms | 209.6 ms | 285.8 ms | 4 | 3 | 4308.6 ms |
| fair-tokyo-cloudflare-r2 | Cloudflare | Tokyo | 8,957/9,000 | 0.478% | 207.4 ms | 215.2 ms | 300.8 ms | 5 | 3 | 4314 ms |
| fair-tokyo-cloudflare-r3 | Cloudflare | Tokyo | 8,968/9,000 | 0.356% | 199.6 ms | 211 ms | 286.6 ms | 4 | 2 | 4304.3 ms |
| fair-tokyo-moq-r1 | MoQ | Tokyo | 9,000/9,000 | 0% | 197.6 ms | 205.1 ms | 280.3 ms | 1 | 0 | 915.6 ms |
| fair-tokyo-moq-r2 | MoQ | Tokyo | 9,000/9,000 | 0% | 196.3 ms | 202.5 ms | 279 ms | 1 | 0 | 891.7 ms |
| fair-tokyo-moq-r3 | MoQ | Tokyo | 9,000/9,000 | 0% | 162.2 ms | 168.4 ms | 246.3 ms | 1 | 0 | 1096.7 ms |
| fair-tokyo-pulsebeam-r1 | PulseBeam variant | Tokyo | 9,000/9,000 | 0% | 217.6 ms | 226.3 ms | 309.8 ms | 1 | 0 | 2852.2 ms |
| fair-tokyo-pulsebeam-r2 | PulseBeam variant | Tokyo | 9,000/9,000 | 0% | 217.6 ms | 224.8 ms | 304.2 ms | 1 | 0 | 2850.3 ms |
| fair-tokyo-pulsebeam-r3 | PulseBeam variant | Tokyo | 9,000/9,000 | 0% | 218.6 ms | 226.9 ms | 308.1 ms | 1 | 0 | 2852.7 ms |
| fair-virginia-cloudflare-r1 | Cloudflare | Virginia | 8,937/9,000 | 0.700% | 177 ms | 188.1 ms | 268.9 ms | 5 | 3 | 3307.2 ms |
| fair-virginia-cloudflare-r2 | Cloudflare | Virginia | 8,961/9,000 | 0.433% | 184.6 ms | 192.6 ms | 268.8 ms | 6 | 1 | 3322.2 ms |
| fair-virginia-cloudflare-r3 | Cloudflare | Virginia | 8,971/9,000 | 0.322% | 181.2 ms | 188.6 ms | 264 ms | 4 | 1 | 3328.2 ms |
| fair-virginia-moq-r1 | MoQ | Virginia | 9,000/9,000 | 0% | 178.5 ms | 185 ms | 263.6 ms | 1 | 0 | 575.7 ms |
| fair-virginia-moq-r2 | MoQ | Virginia | 9,000/9,000 | 0% | 179.2 ms | 185.8 ms | 263.5 ms | 1 | 0 | 714.4 ms |
| fair-virginia-moq-r3 | MoQ | Virginia | 9,000/9,000 | 0% | 178.6 ms | 185.1 ms | 260.1 ms | 1 | 0 | 1047.9 ms |
| fair-virginia-pulsebeam-r1 | PulseBeam variant | Virginia | 9,000/9,000 | 0% | 200 ms | 207 ms | 287.1 ms | 1 | 0 | 2630.1 ms |
| fair-virginia-pulsebeam-r2 | PulseBeam variant | Virginia | 9,000/9,000 | 0% | 201 ms | 208.1 ms | 294.8 ms | 1 | 0 | 2626.8 ms |
| fair-virginia-pulsebeam-r3 | PulseBeam variant | Virginia | 8,975/9,000 | 0.278% | 200.4 ms | 207.5 ms | 288.5 ms | 2 | 1 | 2627.2 ms |

## Pooled regional results

Percentiles below are pooled across all valid decoded frames from the three repetitions, not averages of per-run percentiles.

| Region | Provider | Frames | Loss | Invalid | P50 | P95 | P99 | Max | >100 ms | >250 ms | Join P50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Virginia | MoQ | 27,000/27,000 | 0% | 0 | 178.8 ms | 182.2 ms | 185.4 ms | 263.6 ms | 3 | 0 | 714.4 ms |
| Virginia | PulseBeam variant | 26,975/27,000 | 0.093% | 24 | 200.4 ms | 205 ms | 207.6 ms | 294.8 ms | 4 | 1 | 2627.2 ms |
| Virginia | Cloudflare | 26,869/27,000 | 0.485% | 118 | 181.7 ms | 187.4 ms | 190.9 ms | 268.9 ms | 15 | 5 | 3322.2 ms |
| Frankfurt | MoQ | 27,000/27,000 | 0% | 0 | 221.9 ms | 225.4 ms | 228.1 ms | 307.4 ms | 3 | 0 | 1527.6 ms |
| Frankfurt | PulseBeam variant | 26,999/27,000 | 0.004% | 1 | 243.4 ms | 247.9 ms | 250.4 ms | 335.1 ms | 3 | 0 | 3156.8 ms |
| Frankfurt | Cloudflare | 26,720/27,000 | 1.037% | 228 | 226.8 ms | 232.8 ms | 238.1 ms | 724.2 ms | 25 | 14 | 4321.4 ms |
| Tokyo | MoQ | 27,000/27,000 | 0% | 0 | 196.2 ms | 201.1 ms | 203.8 ms | 280.3 ms | 3 | 0 | 915.6 ms |
| Tokyo | PulseBeam variant | 27,000/27,000 | 0% | 0 | 218 ms | 223.3 ms | 226.2 ms | 309.8 ms | 3 | 0 | 2852.2 ms |
| Tokyo | Cloudflare | 26,878/27,000 | 0.452% | 111 | 201.7 ms | 209.9 ms | 213.4 ms | 300.8 ms | 13 | 8 | 4308.6 ms |

## Implementation disclosure

- MoQ: `cloudflare/moq-rs` commit `5295993480c3d19f6057d0bb3c8b0b394ad1df62`; only explicit `moq-sub` stdout flush instrumentation was added. Patch SHA-256: `8fa0fbacbae2f7ff9ec47c82480eb5413b9afda397720068a5e7f6bf2bc37f02`.
- PulseBeam: v0.4.6 commit `4fb1f66e549d00051860992acded9f4954b83029`; the initial receiver-side BWE estimate was changed from 500 kbit/s to 5 Mbit/s to qualify the native fixed-rate sender. Patch SHA-256: `6ca65c1293e9ec20356fe5efb0ec0e0fab8db7044e7636724c06203a9b9f83ee`. These are not stock-v0.4.6 numbers.
- Cloudflare: current managed Realtime SFU Sessions/Tracks API with no private tuning.
- MoQ used per-frame CMAF chunks over MoQ. PulseBeam and Cloudflare used H.264 RTP over WebRTC. Encoder, decoder, source content, target rate, resolution, cadence, and measured boundary were fixed. The MoQ publisher summary's historically named `measuredElementaryStream` counter includes fMP4 bytes; its observed 4,027,168 bit/s is packaging overhead, not a higher H.264 target.

## Validity and caveats

All 27 trials passed the predeclared workload, clock, resource, and evidence gates. The result set has zero rejected trials. Maximum reported endpoint clock offset was below 0.004 ms. Resource analyses reported no cgroup CPU throttling, and host CPU remained below the 80% P95 exclusion threshold.

This is a fair product-stack comparison, not pure protocol isolation. MoQ and PulseBeam share matched self-hosted relay placement and compute. Cloudflare chooses its managed edge path, which is an intended product property. MoQ's CMAF packaging and the WebRTC platforms' RTP packaging are each platform-native; byte overhead is therefore not identical. A physical LED/timecode camera-to-display test and a multi-camera/load matrix remain necessary before a final production capacity claim.

## Evidence

- Frozen protocol: `FAIR-BENCHMARK-PROTOCOL.md`
- Final figures: `fair-media-benchmark-all-zones.{png,svg}` and
  `transport-benchmark-full-all-zones.{png,svg}`
- Machine-readable aggregates, per-frame samples, service logs, host manifests,
  clock evidence, workload qualification, bitrate derivation, and the SHA-256
  integrity manifest are retained in the separately distributed
  `results-fair-gcp-20260718` evidence archive. They are intentionally excluded
  from Git because the raw logs include transient SDP/ICE and infrastructure
  metadata.
