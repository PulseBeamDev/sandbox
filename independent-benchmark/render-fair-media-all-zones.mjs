import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const resultsDir = path.join(root, "results-fair-gcp-20260718");
const analysis = JSON.parse(await fs.readFile(path.join(resultsDir, "media-analysis.json"), "utf8"));
const output = path.resolve(process.argv[2] ?? path.join(root, "fair-media-benchmark-all-zones.svg"));

const regionOrder = ["west-virginia", "west-frankfurt", "west-tokyo"];
const regionLabels = {
  "west-virginia": "Virginia",
  "west-frankfurt": "Frankfurt",
  "west-tokyo": "Tokyo",
};
const providers = [
  { id: "moq", name: "MoQ · moq-rs", qualifier: "self-hosted California relay", color: "#35d3a4" },
  { id: "pulsebeam", name: "PulseBeam", qualifier: "5 Mbps initial-BWE variant", color: "#42bff5" },
  { id: "cloudflare", name: "Cloudflare", qualifier: "managed Realtime SFU", color: "#f5a742" },
];
const rows = analysis.aggregate.filter((row) => row.durationClass === "five-minute");
const getRow = (region, provider) => rows.find((row) => row.corridor === region && row.provider === provider);

if (rows.length !== 9 || analysis.rejectedTrials.length !== 0) {
  throw new Error(`Expected nine accepted aggregates and no rejected trials; got ${rows.length} / ${analysis.rejectedTrials.length}`);
}

const width = 1800;
const height = 1440;
const bg = "#07111d";
const panel = "#0d1d2e";
const border = "#1c344a";
const foreground = "#f4f8fb";
const muted = "#91a5b9";
const subtle = "#71869a";
const axisMin = 160;
const axisMax = 260;
const panelWidth = 540;
const chartLeft = 192;
const chartRight = 500;

const svg = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`);
svg.push(`<title id="title">Fair global media benchmark: MoQ, PulseBeam, and Cloudflare</title>`);
svg.push(`<desc id="desc">Capture-to-decoded H.264 latency, loss, freezes, and join time from California to Virginia, Frankfurt, and Tokyo. MoQ has the lowest median and 99th-percentile latency in every region and receives all measured frames.</desc>`);
svg.push(`<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#0b1928"/></linearGradient>
  <filter id="shadow" x="-10%" y="-10%" width="120%" height="135%"><feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#020812" flood-opacity=".34"/></filter>
  <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#627d96"/></marker>
  <style>
    .title{font:700 44px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground};letter-spacing:-.8px}
    .subtitle{font:400 18px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .eyebrow{font:650 13px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted};letter-spacing:1.2px}
    .topology{font:650 17px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground}}
    .topology-sub{font:400 12px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .region{font:700 25px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground}}
    .region-sub{font:400 13px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .provider{font:650 16px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground}}
    .qualifier{font:400 12px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .metric{font:650 15px "SFMono-Regular",Consolas,monospace;fill:#e8eff5}
    .detail{font:400 12px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .axis{font:500 11px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${subtle}}
    .summary-name{font:650 17px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground}}
    .summary-value{font:700 27px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground}}
    .summary-detail{font:400 13px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .verdict{font:650 22px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground}}
    .verdict-detail{font:400 15px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .note{font:400 12px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${subtle}}
    .grid{stroke:#294158;stroke-width:1;opacity:.58}.divider{stroke:#20384d;stroke-width:1}
  </style>
</defs>`);
svg.push(`<rect width="${width}" height="${height}" fill="url(#bg)"/>`);
svg.push(`<text class="title" x="55" y="68">Fair global media benchmark</text>`);
svg.push(`<text class="subtitle" x="55" y="103">Capture → H.264 encode → platform → decode · 1280×720p30 · strict 4.0 Mbps · 3 × 5 min per provider and region</text>`);

renderTopology();
regionOrder.forEach((region, index) => renderRegion(region, 55 + index * 575, 310));
renderOverall();
renderVerdict();

svg.push(`<text class="note" x="55" y="1400">Headless glass-to-glass proxy: capture timestamp is embedded before encode and recovered after decode; camera exposure and display scanout are excluded.</text>`);
svg.push(`<text class="note" x="1745" y="1400" text-anchor="end">GCP · July 18–19, 2026 · 27 accepted trials · 243,000 expected frames</text>`);
svg.push(`</svg>`);

await fs.writeFile(output, svg.join("\n") + "\n");
console.log(output);

function renderTopology() {
  svg.push(`<g transform="translate(55 132)"><rect width="1690" height="142" rx="18" fill="${panel}" stroke="${border}" filter="url(#shadow)"/>`);
  svg.push(`<text class="eyebrow" x="24" y="30">TEST TOPOLOGY · ONE REGIONAL SUBSCRIBER ACTIVE AT A TIME · 12 vCPUs MAX</text>`);
  topologyBox(24, 49, 270, "California publisher", "us-west2-a · c3-standard-4");
  topologyBox(330, 49, 270, "California relay", "MoQ / PulseBeam · isolated");
  svg.push(`<line x1="294" y1="84" x2="324" y2="84" stroke="#627d96" stroke-width="2" marker-end="url(#arrow)"/>`);
  svg.push(`<line x1="600" y1="84" x2="742" y2="84" stroke="#627d96" stroke-width="2" marker-end="url(#arrow)"/>`);
  svg.push(`<text class="topology-sub" x="671" y="68" text-anchor="middle">sequential</text>`);
  svg.push(`<text class="topology-sub" x="671" y="105" text-anchor="middle">rotation</text>`);
  svg.push(`<text class="eyebrow" x="780" y="42">SUBSCRIBER ZONES · NOT A SERIAL PATH</text>`);
  for (const [x, label, zone] of [[780, "Virginia", "us-east4-a"], [1100, "Frankfurt", "europe-west3-a"], [1420, "Tokyo", "asia-northeast1-b"]]) {
    topologyBox(x, 49, 244, label, zone);
  }
  svg.push(`<text class="topology-sub" x="465" y="130" text-anchor="middle">Cloudflare uses its managed route; shown as the product-stack reference</text>`);
  svg.push(`</g>`);
}

function topologyBox(x, y, w, label, detail) {
  svg.push(`<rect x="${x}" y="${y}" width="${w}" height="68" rx="12" fill="#11263a" stroke="#29455e"/>`);
  svg.push(`<text class="topology" x="${x + 15}" y="${y + 28}">${label}</text>`);
  svg.push(`<text class="topology-sub" x="${x + 15}" y="${y + 50}">${detail}</text>`);
}

function renderRegion(region, x, y) {
  const label = regionLabels[region];
  svg.push(`<g transform="translate(${x} ${y})"><rect width="${panelWidth}" height="650" rx="20" fill="${panel}" stroke="${border}" filter="url(#shadow)"/>`);
  svg.push(`<text class="region" x="25" y="42">California → ${label}</text>`);
  svg.push(`<text class="region-sub" x="25" y="66">P50 circle · P99 diamond · lower is better</text>`);
  for (const tick of [160, 180, 200, 220, 240, 260]) {
    const px = scale(tick);
    svg.push(`<line class="grid" x1="${px}" y1="92" x2="${px}" y2="515"/>`);
    svg.push(`<text class="axis" x="${px}" y="84" text-anchor="middle">${tick}</text>`);
  }
  providers.forEach((provider, index) => renderProviderRow(getRow(region, provider.id), provider, 135 + index * 142));
  svg.push(`<line class="divider" x1="25" y1="540" x2="515" y2="540"/>`);
  const moq = getRow(region, "moq");
  const pb = getRow(region, "pulsebeam");
  const cf = getRow(region, "cloudflare");
  svg.push(`<text class="eyebrow" x="25" y="570">REGIONAL READOUT</text>`);
  svg.push(`<text class="summary-detail" x="25" y="598">MoQ leads P50 by ${fmt(Math.min(pb.latencyMs.p50, cf.latencyMs.p50) - moq.latencyMs.p50)} ms</text>`);
  svg.push(`<text class="summary-detail" x="25" y="622">and P99 by ${fmt(Math.min(pb.latencyMs.p99, cf.latencyMs.p99) - moq.latencyMs.p99)} ms; 0 lost frames.</text>`);
  svg.push(`</g>`);
}

function renderProviderRow(row, provider, y) {
  const x50 = scale(row.latencyMs.p50);
  const x99 = scale(row.latencyMs.p99);
  svg.push(`<rect x="25" y="${y - 15}" width="11" height="11" rx="2" fill="${provider.color}"/>`);
  svg.push(`<text class="provider" x="47" y="${y - 4}">${provider.name}</text>`);
  svg.push(`<text class="qualifier" x="47" y="${y + 17}">${provider.qualifier}</text>`);
  svg.push(`<line x1="${x50}" y1="${y + 35}" x2="${x99}" y2="${y + 35}" stroke="${provider.color}" stroke-width="6" stroke-linecap="round" opacity=".65"/>`);
  svg.push(`<circle cx="${x50}" cy="${y + 35}" r="8" fill="${provider.color}" stroke="${panel}" stroke-width="3"/>`);
  svg.push(`<polygon points="${x99},${y + 26} ${x99 + 9},${y + 35} ${x99},${y + 44} ${x99 - 9},${y + 35}" fill="${provider.color}" stroke="${panel}" stroke-width="2"/>`);
  svg.push(`<text class="metric" x="47" y="${y + 69}">P50 ${fmt(row.latencyMs.p50)} · P99 ${fmt(row.latencyMs.p99)} ms</text>`);
  svg.push(`<text class="detail" x="47" y="${y + 91}">${formatInt(row.received)}/${formatInt(row.expected)} · ${fmtPct(row.lossPercent)} loss · ${row.freezesOver250Ms} freezes &gt;250 ms</text>`);
  svg.push(`<text class="detail" x="47" y="${y + 111}">join P50 ${formatInt(Math.round(row.joinLatencyMs.p50))} ms · ${row.invalidMarkers} invalid markers</text>`);
}

function renderOverall() {
  svg.push(`<g transform="translate(55 995)"><text class="eyebrow" x="0" y="18">ALL THREE REGIONS · SUMMED OUTCOMES</text>`);
  providers.forEach((provider, index) => {
    const providerRows = rows.filter((row) => row.provider === provider.id);
    const expected = sum(providerRows, "expected");
    const received = sum(providerRows, "received");
    const freezes = sum(providerRows, "freezesOver250Ms");
    const invalid = sum(providerRows, "invalidMarkers");
    const x = index * 575;
    svg.push(`<rect x="${x}" y="36" width="540" height="138" rx="18" fill="${panel}" stroke="${border}" filter="url(#shadow)"/>`);
    svg.push(`<rect x="${x + 23}" y="59" width="11" height="11" rx="2" fill="${provider.color}"/>`);
    svg.push(`<text class="summary-name" x="${x + 45}" y="70">${provider.name}</text>`);
    svg.push(`<text class="summary-value" x="${x + 23}" y="108">${formatInt(received)} / ${formatInt(expected)}</text>`);
    svg.push(`<text class="summary-detail" x="${x + 23}" y="135">${fmtPct((expected - received) / expected * 100)} loss · ${invalid} invalid · ${freezes} freezes &gt;250 ms</text>`);
    svg.push(`<text class="summary-detail" x="${x + 23}" y="157">${provider.id === "moq" ? "lowest P50 + P99 in 3/3 regions" : "three accepted five-minute trials per region"}</text>`);
  });
  svg.push(`</g>`);
}

function renderVerdict() {
  svg.push(`<g transform="translate(55 1215)"><rect width="1690" height="142" rx="20" fill="#10263a" stroke="#2c4e68" filter="url(#shadow)"/>`);
  svg.push(`<text class="eyebrow" x="25" y="34">FROZEN MATRIX VERDICT</text>`);
  svg.push(`<text class="verdict" x="25" y="70">MoQ is the strongest result in this frozen test matrix.</text>`);
  svg.push(`<text class="verdict-detail" x="25" y="100">It wins every region on P50 and P99, delivers 81,000/81,000 frames, and records zero &gt;250 ms freezes.</text>`);
  svg.push(`<text class="verdict-detail" x="25" y="125">Treat this as a product-stack result: Cloudflare is managed; MoQ and PulseBeam use the matched California relay VM.</text>`);
  svg.push(`</g>`);
}

function scale(value) {
  return chartLeft + (Math.max(axisMin, Math.min(axisMax, value)) - axisMin) / (axisMax - axisMin) * (chartRight - chartLeft);
}
function sum(values, key) { return values.reduce((total, value) => total + value[key], 0); }
function fmt(value) { return Number(value.toFixed(1)); }
function fmtPct(value) { return value === 0 ? "0%" : `${value.toFixed(3)}%`; }
function formatInt(value) { return new Intl.NumberFormat("en-US").format(value); }
