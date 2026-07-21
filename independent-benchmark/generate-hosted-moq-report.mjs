import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const analysisPath = path.join(root, "results-hosted-moq-gcp-20260718", "hosted-moq-analysis.json");
const data = JSON.parse(await fs.readFile(analysisPath, "utf8"));
const output = path.resolve(process.argv[2] ?? path.join(root, "HOSTED-MOQ-BENCHMARK-REPORT.md"));
const byCorridor = (rows, corridor) => rows.find((row) => row.corridor === corridor);
const lines = [];

lines.push("# Hosted MoQ benchmark extension");
lines.push("");
lines.push("## Verdict");
lines.push("");
lines.push("The moq.dev public demo CDN preserved MoQ's attractive control median in Virginia and delivered all 108,000 measured control echoes without loss, duplicates, or send failures. It did not preserve a tight global control tail: Frankfurt reached 2,066.9 ms P99.9 and Tokyo reached 662.2 ms P99. Media reliability was the larger problem: Virginia completed 3/3 five-minute runs, Frankfurt completed 0/2, and Tokyo completed 1/2. These public-demo-CDN results do not overturn the stronger result from the matched self-hosted `cloudflare/moq-rs` relay.");
lines.push("");
lines.push("Cloudflare Managed MoQ was measured in a separate July 20 extension using the managed draft-14 endpoint and pinned `cloudflare/moq-rs` clients. Its media path completed 8/9 attempted five-minute runs. Its 120 Hz datagram control path observed loss in every corridor and therefore did not pass the benchmark's zero-loss control gate. Because this extension used a different protocol draft and run date, it is reported separately rather than merged into the earlier matched matrix.");
lines.push("");
lines.push("## Cloudflare Managed MoQ extension");
lines.push("");
lines.push("### Control: latest-state application RTT");
lines.push("");
lines.push(`Workload: ${data.cloudflareManagedMoq.control.workload}.`);
lines.push("");
lines.push("| Corridor | Delivered | Loss | P50 | P99 | Max | Result |");
lines.push("|---|---:|---:|---:|---:|---:|---|");
for (const row of data.cloudflareManagedMoq.control.aggregates) {
  lines.push(`| ${label(row.corridor)} | ${num(row.received)} / ${num(row.expected)} | ${pct(row.lossPercent)} | ${ms(row.roundTripMs.p50)} | ${ms(row.roundTripMs.p99)} | ${ms(row.roundTripMs.max)} | measured; loss observed |`);
}
lines.push("");
const retry = data.cloudflareManagedMoq.control.diagnostic60Hz;
lines.push(`A later Virginia 60 Hz diagnostic retry delivered ${num(retry.received)} / ${num(retry.expected)} echoes. It is not used as a latency row and prevents interpreting the 120 Hz loss as a clean rate threshold.`);
lines.push("");
lines.push("### Media: headless glass-to-glass proxy");
lines.push("");
lines.push("| Corridor | Completed / attempts | Accepted frames | P50 | P99 | Freezes >100 ms | Result |");
lines.push("|---|---:|---:|---:|---:|---:|---|");
for (const row of data.cloudflareManagedMoq.media.completion) {
  const aggregate = row.aggregate;
  lines.push(`| ${row.label} | ${row.completed} / ${row.attempts} | ${aggregate ? `${num(aggregate.received)} / ${num(aggregate.expected)}` : "—"} | ${aggregate ? ms(aggregate.latencyMs.p50) : "—"} | ${aggregate ? ms(aggregate.latencyMs.p99) : "—"} | ${aggregate ? num(aggregate.freezesOver100Ms) : "—"} | ${row.completed === row.attempts ? "completed" : "partial completion"} |`);
}
lines.push("");
for (const failure of data.cloudflareManagedMoq.media.failures) {
  lines.push(`The failed ${label(failure.corridor)} attempt delivered ${num(failure.received)} / ${num(failure.expected)} frames before the ${failure.reason}. It remains part of the completion result.`);
}
lines.push("");
lines.push("Across the eight completed trials, the aggregate was 71,999 / 72,000 frames. That aggregate does not hide or count the incomplete Virginia attempt as a completed run.");
lines.push("");
lines.push("## moq.dev public CDN follow-up");
lines.push("");
lines.push("### Control: latest-state application RTT");
lines.push("");
lines.push("Both endpoints were pinned to the California-resolved moq.dev ingress, matching the original west-relay topology. A preliminary multi-edge qualification using independent west/east CDN edges returned 0/600 echoes, so it was not used as a latency result.");
lines.push("");
lines.push("| Corridor | Delivered | Reordered | P50 | P99 | P99.9 | Max |");
lines.push("|---|---:|---:|---:|---:|---:|---:|");
for (const row of data.control) {
  lines.push(`| ${label(row.corridor)} | ${num(row.received)} / ${num(row.expected)} | ${num(row.outOfOrder)} | ${ms(row.roundTripMs.p50)} | ${ms(row.roundTripMs.p99)} | ${ms(row.roundTripMs.p999)} | ${ms(row.roundTripMs.max)} |`);
}
lines.push("");
lines.push("Reordering is reported rather than treated as loss because each update is a complete replaceable state. Loss, duplicates, and send failures remained hard rejection gates; all were zero.");
lines.push("");
lines.push("### Media: headless glass-to-glass proxy");
lines.push("");
lines.push("| Corridor | Completed / attempts | Accepted frames | P50 | P99 | Freezes >100 ms | Result |");
lines.push("|---|---:|---:|---:|---:|---:|---|");
for (const row of data.media.completion) {
  const aggregate = row.aggregate;
  lines.push(`| ${row.label} | ${row.completed} / ${row.attempts} | ${aggregate ? `${num(aggregate.received)} / ${num(aggregate.expected)}` : "—"} | ${aggregate ? ms(aggregate.latencyMs.p50) : "—"} | ${aggregate ? ms(aggregate.latencyMs.p99) : "—"} | ${aggregate ? num(aggregate.freezesOver100Ms) : "—"} | ${row.completed === row.attempts ? "completed" : row.completed === 0 ? "no completed trial" : "partial completion"} |`);
}
lines.push("");
lines.push("Failed attempts are part of the reliability result:");
lines.push("");
for (const failure of data.media.failures) {
  lines.push(`- ${label(failure.corridor)} attempt ${failure.attempt}: ${num(failure.received)} / ${num(failure.expected)} frames before ${failure.reason}.`);
}
lines.push("");
lines.push("The measurement stamps capture time and frame identity before H.264 encode and recovers them after software decode. It includes source scheduling, encode, transport/relay forwarding, receive, reassembly, and decode; it excludes camera exposure and display scanout.");
lines.push("");
lines.push("## Tuning decision");
lines.push("");
lines.push("The accepted media setting used `latency-max=100ms` and one fMP4 fragment per frame (`fragment-duration=0ms`). The seemingly faster `latency-max=0ms` setting was rejected: two Virginia runs completed, but the third delivered only 2,959 / 9,000 frames and lost 6,041.");
lines.push("");
lines.push("## Scope and provenance");
lines.push("");
lines.push(`- Target: ${data.target.provider} at \`${data.target.relayUrl}\`. Its own documentation describes this as a small, public, unauthenticated test cluster and warns users not to abuse it.`);
lines.push(`- Client: \`${data.target.implementation}\` commit \`${data.target.revision}\`, \`${data.target.client}\`; identical release binary hashes were verified on both endpoints.`);
lines.push(`- Media: ${data.workload.media}.`);
lines.push(`- Control: ${data.workload.control}.`);
lines.push(`- Cloudflare Managed MoQ: ${data.cloudflareManagedMoq.target.protocol}, client revision \`${data.cloudflareManagedMoq.target.clientRevision}\`; credential path redacted.`);
lines.push("- GCP endpoints: California publisher `us-west2-a`; subscribers `us-east4-a`, `europe-west3-a`, and `asia-northeast1-b`; `c3-standard-4`; synchronized clocks; endpoint resource gates passed.");
lines.push("- Cloudflare Managed MoQ API reference: https://developers.cloudflare.com/api/resources/moq");
lines.push("- Cloudflare MoQ overview: https://developers.cloudflare.com/moq/");
lines.push("- moq.dev public relay warning: https://doc.moq.dev/setup/dev");

await fs.writeFile(output, `${lines.join("\n")}\n`);
console.log(output);

function label(corridor) { return corridor.replace("west-", "").replace(/^./, (c) => c.toUpperCase()); }
function num(value) { return new Intl.NumberFormat("en-US").format(value); }
function ms(value) { return `${Number(value.toFixed(1))} ms`; }
function pct(value) { return `${Number(value.toFixed(3))}%`; }
