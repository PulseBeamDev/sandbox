import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const resultsDir = path.join(root, "results-fair-gcp-20260718");
const analysis = JSON.parse(await fs.readFile(path.join(resultsDir, "media-analysis.json"), "utf8"));
const output = path.resolve(process.argv[2] ?? path.join(root, "FAIR-MEDIA-BENCHMARK-REPORT.md"));
const aggregates = analysis.aggregate.filter((row) => row.durationClass === "five-minute");
const trials = analysis.trials
  .filter((trial) => trial.summary?.media?.measuredFrames === 9000)
  .sort((a, b) => a.summary.runId.localeCompare(b.summary.runId));

if (aggregates.length !== 9 || trials.length !== 27 || analysis.rejectedTrials.length !== 0) {
  throw new Error(`Incomplete result matrix: ${aggregates.length} aggregates, ${trials.length} trials, ${analysis.rejectedTrials.length} rejected`);
}

const lines = [];
lines.push("# Fair global media benchmark");
lines.push("");
lines.push("Frozen run: July 18–19, 2026, on isolated GCP benchmark infrastructure.");
lines.push("");
lines.push("## Verdict");
lines.push("");
lines.push("MoQ is the strongest media result in this matrix. It had the lowest P50 and P99 capture-to-decoded-frame latency in Virginia, Frankfurt, and Tokyo; delivered 81,000/81,000 measured frames; produced no invalid decoded markers; and recorded no presentation freezes over 250 ms. PulseBeam's qualified 5 Mbps-initial-BWE variant was reliable but slower. Cloudflare's managed SFU was close to MoQ on median latency, but frame loss, invalid markers, long freezes, and join time were worse in this run.");
lines.push("");
lines.push("Within this frozen matrix, MoQ produced the strongest latency result, subject to production work around authorization, lifecycle, observability, codec interoperability, and literal camera/display validation. It does not prove that MoQ will win every network, load level, or implementation revision.");
lines.push("");
lines.push("## What was measured");
lines.push("");
lines.push("The primary boundary is a reproducible headless glass-to-glass proxy: a capture timestamp and frame ID are embedded into the source before H.264 encode and recovered after software decode. It includes source scheduling, encode, transport/platform forwarding, receive, depacketize/reassembly, and decode. It excludes physical camera exposure and display scheduling/scanout.");
lines.push("");
lines.push("- Source: deterministic `translated-texture-v1`, 1280×720p30, H.264 constrained baseline, one-second GOP, no B-frames.");
lines.push("- Rate: strict 4,000,000 bit/s H.264 source. The WebRTC Annex-B counter records exactly 4,000,000 bit/s; MoQ's fMP4 byte counter records 4,027,168 bit/s because it includes the per-frame container overhead (0.6792%). Both were prequalified with zero decoded-frame or marker errors and pass the frozen ±5% gate.");
lines.push("- Window: 150 warmup frames, 9,000 measured frames, 60 cooldown frames.");
lines.push("- Repetitions: three accepted five-minute trials per provider and region; provider order rotated.");
lines.push("- Publisher and self-hosted relay: separate `c3-standard-4` VMs in `us-west2-a`.");
lines.push("- Subscribers: `us-east4-a`, `europe-west3-a`, and `asia-northeast1-b`, one active at a time.");
lines.push("- Maximum active compute: three `c3-standard-4` VMs, 12 vCPUs.");
lines.push("");
lines.push("## Individual accepted runs");
lines.push("");
lines.push("| Run | Provider | Region | Frames | Loss | P50 | P99 | Max | >100 ms | >250 ms | Join |");
lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const trial of trials) {
  const s = trial.summary;
  lines.push(`| ${s.runId} | ${label(s.provider)} | ${region(s.corridor)} | ${formatInt(s.received)}/${formatInt(s.expected)} | ${pct(s.lossPercent)} | ${ms(s.latencyMs.p50)} | ${ms(s.latencyMs.p99)} | ${ms(s.latencyMs.max)} | ${s.freezesOver100Ms} | ${s.freezesOver250Ms} | ${ms(s.joinLatencyMs)} |`);
}
lines.push("");
lines.push("## Pooled regional results");
lines.push("");
lines.push("Percentiles below are pooled across all valid decoded frames from the three repetitions, not averages of per-run percentiles.");
lines.push("");
lines.push("| Region | Provider | Frames | Loss | Invalid | P50 | P95 | P99 | Max | >100 ms | >250 ms | Join P50 |");
lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const corridor of ["west-virginia", "west-frankfurt", "west-tokyo"]) {
  for (const provider of ["moq", "pulsebeam", "cloudflare"]) {
    const s = aggregates.find((row) => row.corridor === corridor && row.provider === provider);
    lines.push(`| ${region(corridor)} | ${label(provider)} | ${formatInt(s.received)}/${formatInt(s.expected)} | ${pct(s.lossPercent)} | ${s.invalidMarkers} | ${ms(s.latencyMs.p50)} | ${ms(s.latencyMs.p95)} | ${ms(s.latencyMs.p99)} | ${ms(s.latencyMs.max)} | ${s.freezesOver100Ms} | ${s.freezesOver250Ms} | ${ms(s.joinLatencyMs.p50)} |`);
  }
}
lines.push("");
lines.push("## Implementation disclosure");
lines.push("");
lines.push("- MoQ: `cloudflare/moq-rs` commit `5295993480c3d19f6057d0bb3c8b0b394ad1df62`; only explicit `moq-sub` stdout flush instrumentation was added. Patch SHA-256: `8fa0fbacbae2f7ff9ec47c82480eb5413b9afda397720068a5e7f6bf2bc37f02`.");
lines.push("- PulseBeam: v0.4.6 commit `4fb1f66e549d00051860992acded9f4954b83029`; the initial receiver-side BWE estimate was changed from 500 kbit/s to 5 Mbit/s to qualify the native fixed-rate sender. Patch SHA-256: `6ca65c1293e9ec20356fe5efb0ec0e0fab8db7044e7636724c06203a9b9f83ee`. These are not stock-v0.4.6 numbers.");
lines.push("- Cloudflare: current managed Realtime SFU Sessions/Tracks API with no private tuning.");
lines.push("- MoQ used per-frame CMAF chunks over MoQ. PulseBeam and Cloudflare used H.264 RTP over WebRTC. Encoder, decoder, source content, target rate, resolution, cadence, and measured boundary were fixed. The MoQ publisher summary's historically named `measuredElementaryStream` counter includes fMP4 bytes; its observed 4,027,168 bit/s is packaging overhead, not a higher H.264 target.");
lines.push("");
lines.push("## Validity and caveats");
lines.push("");
lines.push("All 27 trials passed the predeclared workload, clock, resource, and evidence gates. The result set has zero rejected trials. Maximum reported endpoint clock offset was below 0.004 ms. Resource analyses reported no cgroup CPU throttling, and host CPU remained below the 80% P95 exclusion threshold.");
lines.push("");
lines.push("This is a fair product-stack comparison, not pure protocol isolation. MoQ and PulseBeam share matched self-hosted relay placement and compute. Cloudflare chooses its managed edge path, which is an intended product property. MoQ's CMAF packaging and the WebRTC platforms' RTP packaging are each platform-native; byte overhead is therefore not identical. A physical LED/timecode camera-to-display test and a multi-camera/load matrix remain necessary before a final production capacity claim.");
lines.push("");
lines.push("## Evidence");
lines.push("");
lines.push("- Frozen protocol: `FAIR-BENCHMARK-PROTOCOL.md`");
lines.push("- Machine-readable aggregate: `results-fair-gcp-20260718/media-analysis.json`");
lines.push("- Trial artifacts: `results-fair-gcp-20260718/trials/`");
lines.push("- Host manifests and clock evidence: `results-fair-gcp-20260718/manifests/`");
lines.push("- Workload qualification: `results-fair-gcp-20260718/qualification/`");
lines.push("- MoQ fMP4/H.264 bitrate derivation: `results-fair-gcp-20260718/MOQ-BITRATE-DERIVATION.json`");
lines.push("- Integrity manifest: `results-fair-gcp-20260718/SHA256SUMS`");
lines.push("");

await fs.writeFile(output, lines.join("\n"));
console.log(output);

function label(provider) {
  return provider === "moq" ? "MoQ" : provider === "pulsebeam" ? "PulseBeam variant" : "Cloudflare";
}
function region(corridor) { return corridor.replace("west-", "").replace(/^./, (c) => c.toUpperCase()); }
function ms(value) { return `${Number(value.toFixed(1))} ms`; }
function pct(value) { return value === 0 ? "0%" : `${value.toFixed(3)}%`; }
function formatInt(value) { return new Intl.NumberFormat("en-US").format(value); }
