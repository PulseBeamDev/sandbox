import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const control = JSON.parse(await fs.readFile(path.join(root, "distributed-analysis-gcp.json"), "utf8"));
const media = JSON.parse(await fs.readFile(path.join(root, "results-fair-gcp-20260718/media-analysis.json"), "utf8"));
const hosted = JSON.parse(await fs.readFile(path.join(root, "results-hosted-moq-gcp-20260718/hosted-moq-analysis.json"), "utf8"));
const output = path.resolve(process.argv[2] ?? path.join(root, "transport-benchmark-full-all-zones.svg"));

const regions = [
  { id: "west-virginia", label: "Virginia", zone: "us-east4-a" },
  { id: "west-frankfurt", label: "Frankfurt", zone: "europe-west3-a" },
  { id: "west-tokyo", label: "Tokyo", zone: "asia-northeast1-b" },
];
const providers = [
  { id: "moq", name: "MoQ", color: "#35d3a4", control: "QUIC datagram · 1,100 B", media: "CMAF over MoQ · self-hosted" },
  { id: "pulsebeam", name: "PulseBeam", color: "#42bff5", control: "WebRTC DataChannel · 1,200 B", media: "H.264 RTP · 5 Mbps BWE variant" },
  { id: "cloudflare", name: "Cloudflare SFU", color: "#f5a742", control: "WebRTC DataChannel · 1,200 B", media: "H.264 RTP · managed SFU" },
  { id: "moqdev", name: "moq.dev CDN", color: "#c58cff", control: "latest-state groups · 1,100 B", media: "fMP4 over MoQ · public demo CDN" },
];
const controlRows = [
  ...control.primaryAggregates.filter((row) => !row.corridor.includes("combined")),
  ...hosted.control.map((row) => ({ ...row, provider: "moqdev" })),
];
const mediaRows = media.aggregate.filter((row) => row.durationClass === "five-minute");
const controlRow = (region, provider) => controlRows.find((row) => row.corridor === region && row.provider === provider);
const hostedCompletion = (region) => hosted.media.completion.find((row) => row.corridor === region);
const mediaRow = (region, provider) => provider === "moqdev"
  ? hostedCompletion(region)?.aggregate ?? null
  : mediaRows.find((row) => row.corridor === region && row.provider === provider);
const managed = hosted.cloudflareManagedMoq;
const managedCompleted = managed.media.completion.reduce((sum, row) => sum + row.completed, 0);
const managedAttempts = managed.media.completion.reduce((sum, row) => sum + row.attempts, 0);
const managedExpected = managed.media.completion.reduce((sum, row) => sum + (row.aggregate?.expected ?? 0), 0);
const managedReceived = managed.media.completion.reduce((sum, row) => sum + (row.aggregate?.received ?? 0), 0);

if (controlRows.length !== 12 || mediaRows.length !== 9 || hosted.media.completion.length !== 3 || media.rejectedTrials.length !== 0) {
  throw new Error(`Unexpected benchmark matrix: control=${controlRows.length}, media=${mediaRows.length}, hosted=${hosted.media.completion.length}, rejected=${media.rejectedTrials.length}`);
}

const width = 1800;
const height = 1985;
const panelWidth = 540;
const bg = "#07111d";
const panel = "#0d1d2e";
const border = "#1c344a";
const foreground = "#f4f8fb";
const muted = "#91a5b9";
const subtle = "#71869a";
const svg = [];

svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`);
svg.push(`<title id="title">Global transport benchmark: control channels and media</title>`);
svg.push(`<desc id="desc">Application control round-trip time and capture-to-decoded-frame media performance for self-hosted MoQ, PulseBeam, Cloudflare SFU, and the moq.dev public demo CDN from California to Virginia, Frankfurt, and Tokyo. A separately dated Cloudflare Managed MoQ extension is summarized without merging it into the matched matrix.</desc>`);
svg.push(`<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#0b1928"/></linearGradient>
  <filter id="shadow" x="-10%" y="-10%" width="120%" height="135%"><feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#020812" flood-opacity=".34"/></filter>
  <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#627d96"/></marker>
  <style>
    .title{font:700 44px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground};letter-spacing:-.8px}
    .subtitle{font:400 18px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .eyebrow{font:650 13px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted};letter-spacing:1.15px}
    .topology{font:650 16px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground}}
    .topology-sub{font:400 12px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .region{font:700 25px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground}}
    .region-sub{font:400 13px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .section{font:650 14px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#dce7f0;letter-spacing:.9px}
    .provider{font:650 16px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground}}
    .qualifier{font:400 11.5px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .metric{font:650 14px "SFMono-Regular",Consolas,monospace;fill:#e8eff5}
    .detail{font:400 11.5px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .axis{font:500 10.5px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${subtle}}
    .summary-name{font:650 16px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground}}
    .summary-value{font:700 25px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground}}
    .summary-detail{font:400 12px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${muted}}
    .verdict{font:650 18px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${foreground}}
    .note{font:400 11.5px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:${subtle}}
    .grid{stroke:#294158;stroke-width:1;opacity:.58}.divider{stroke:#20384d;stroke-width:1}.track{stroke:#30485e;stroke-width:2}
  </style>
</defs>`);
svg.push(`<rect width="${width}" height="${height}" fill="url(#bg)"/>`);
svg.push(`<text class="title" x="55" y="67">Global transport benchmark</text>`);
svg.push(`<text class="subtitle" x="55" y="101">Control + headless glass-to-glass media · California → Virginia / Frankfurt / Tokyo · latency and completion shown together</text>`);

renderTopology();
renderManagedMoqStatus();
regions.forEach((region, index) => renderRegion(region, 55 + index * 575, 375));
renderSummaries();
renderFooter();

svg.push(`</svg>`);
await fs.writeFile(output, svg.join("\n") + "\n");
console.log(output);

function renderTopology() {
  svg.push(`<g transform="translate(55 125)"><rect width="1690" height="125" rx="18" fill="${panel}" stroke="${border}" filter="url(#shadow)"/>`);
  svg.push(`<text class="eyebrow" x="24" y="27">MATCHED GCP ENDPOINTS · ONE SUBSCRIBER REGION ACTIVE AT A TIME</text>`);
  topologyBox(24, 43, 265, "California publisher", "us-west2-a · c3-standard-4");
  topologyBox(325, 43, 265, "California relay", "self-hosted MoQ / PulseBeam");
  svg.push(`<line x1="289" y1="76" x2="319" y2="76" stroke="#627d96" stroke-width="2" marker-end="url(#arrow)"/>`);
  svg.push(`<line x1="590" y1="76" x2="742" y2="76" stroke="#627d96" stroke-width="2" marker-end="url(#arrow)"/>`);
  svg.push(`<text class="topology-sub" x="666" y="61" text-anchor="middle">sequential</text><text class="topology-sub" x="666" y="98" text-anchor="middle">rotation</text>`);
  for (const [x, label, zone] of [[780, "Virginia", "us-east4-a"], [1100, "Frankfurt", "europe-west3-a"], [1420, "Tokyo", "asia-northeast1-b"]]) topologyBox(x, 43, 244, label, zone);
  svg.push(`<text class="topology-sub" x="1040" y="116" text-anchor="middle">Cloudflare SFU and moq.dev use their managed/public edge routes from the same endpoint VMs</text>`);
  svg.push(`</g>`);
}

function renderManagedMoqStatus() {
  svg.push(`<g transform="translate(55 270)"><rect width="1690" height="78" rx="16" fill="#10263a" stroke="#356987"/>`);
  svg.push(`<rect x="22" y="20" width="11" height="38" rx="5" fill="#42bff5"/>`);
  svg.push(`<text class="section" x="50" y="31">CLOUDFLARE MANAGED MOQ · SEPARATE JULY 20 EXTENSION</text>`);
  svg.push(`<text class="detail" x="50" y="55">Media ${managedCompleted}/${managedAttempts} trials completed · ${formatInt(managedReceived)}/${formatInt(managedExpected)} frames across completed trials · 120 Hz control loss observed in 3/3 corridors.</text>`);
  svg.push(`<text class="detail" x="1665" y="44" text-anchor="end">draft-14 managed endpoint</text></g>`);
}

function topologyBox(x, y, w, label, detail) {
  svg.push(`<rect x="${x}" y="${y}" width="${w}" height="63" rx="12" fill="#11263a" stroke="#29455e"/>`);
  svg.push(`<text class="topology" x="${x + 14}" y="${y + 26}">${label}</text><text class="topology-sub" x="${x + 14}" y="${y + 47}">${detail}</text>`);
}

function renderRegion(region, x, y) {
  svg.push(`<g transform="translate(${x} ${y})"><rect width="${panelWidth}" height="1220" rx="20" fill="${panel}" stroke="${border}" filter="url(#shadow)"/>`);
  svg.push(`<text class="region" x="25" y="42">California → ${region.label}</text>`);
  svg.push(`<text class="region-sub" x="25" y="65">${region.zone} · control marks: circle P50 · diamond P99 · end tick max</text>`);

  svg.push(`<text class="section" x="25" y="103">CONTROL · APPLICATION RTT</text>`);
  svg.push(`<text class="axis" x="515" y="103" text-anchor="end">120 Hz · 5 min · log scale</text>`);
  renderControlAxis(130);
  providers.forEach((provider, index) => renderControlRow(controlRow(region.id, provider.id), provider, 172 + index * 98));

  svg.push(`<line class="divider" x1="25" y1="575" x2="515" y2="575"/>`);
  svg.push(`<text class="section" x="25" y="612">MEDIA · CAPTURE TO DECODE</text>`);
  svg.push(`<text class="axis" x="515" y="612" text-anchor="end">720p30 H.264 · strict 4 Mbps · 5 min/trial</text>`);
  renderMediaAxis(640);
  providers.forEach((provider, index) => renderMediaRow(mediaRow(region.id, provider.id), provider, 682 + index * 118, region.id));

  const moqControl = controlRow(region.id, "moq");
  const othersControl = providers.filter((p) => p.id !== "moq").map((p) => controlRow(region.id, p.id));
  const moqMedia = mediaRow(region.id, "moq");
  const othersMedia = providers.filter((p) => p.id !== "moq").map((p) => mediaRow(region.id, p.id)).filter(Boolean);
  const completion = hostedCompletion(region.id);
  svg.push(`<line class="divider" x1="25" y1="1164" x2="515" y2="1164"/>`);
  svg.push(`<text class="detail" x="25" y="1192">Self-hosted MoQ lead: control P99 ${fmt(Math.min(...othersControl.map((r) => r.roundTripMs.p99)) - moqControl.roundTripMs.p99)} ms · media P99 ${fmt(Math.min(...othersMedia.map((r) => r.latencyMs.p99)) - moqMedia.latencyMs.p99)} ms · moq.dev ${completion.completed}/${completion.attempts} media complete</text>`);
  svg.push(`</g>`);
}

function renderControlAxis(y) {
  const ticks = [50, 100, 200, 500, 1000, 2500];
  svg.push(`<line class="track" x1="195" y1="${y}" x2="505" y2="${y}"/>`);
  for (const tick of ticks) {
    const x = controlScale(tick);
    svg.push(`<line class="grid" x1="${x}" y1="${y - 7}" x2="${x}" y2="${y + 420}"/>`);
    svg.push(`<text class="axis" x="${x}" y="${y - 12}" text-anchor="middle">${tick}</text>`);
  }
}

function renderMediaAxis(y) {
  svg.push(`<line class="track" x1="195" y1="${y}" x2="505" y2="${y}"/>`);
  for (const tick of [160, 200, 240, 280, 320]) {
    const x = mediaScale(tick);
    svg.push(`<line class="grid" x1="${x}" y1="${y - 7}" x2="${x}" y2="${y + 460}"/>`);
    svg.push(`<text class="axis" x="${x}" y="${y - 12}" text-anchor="middle">${tick}</text>`);
  }
}

function renderControlRow(row, provider, y) {
  const x50 = controlScale(row.roundTripMs.p50);
  const x99 = controlScale(row.roundTripMs.p99);
  const xmax = controlScale(row.roundTripMs.max);
  svg.push(`<rect x="25" y="${y - 14}" width="11" height="11" rx="2" fill="${provider.color}"/><text class="provider" x="47" y="${y - 3}">${provider.name}</text>`);
  const qualifier = provider.id === "moq"
    ? `${provider.control} · unreliable`
    : provider.id === "moqdev"
      ? `${provider.control} · pinned CA ingress`
      : `${provider.control} · unordered / 0 retransmits`;
  svg.push(`<text class="qualifier" x="47" y="${y + 17}">${qualifier}</text>`);
  svg.push(`<line x1="${x50}" y1="${y + 33}" x2="${xmax}" y2="${y + 33}" stroke="${provider.color}" stroke-width="4" stroke-linecap="round" opacity=".58"/>`);
  svg.push(`<circle cx="${x50}" cy="${y + 33}" r="7" fill="${provider.color}" stroke="${panel}" stroke-width="3"/>`);
  svg.push(`<polygon points="${x99},${y + 25} ${x99 + 8},${y + 33} ${x99},${y + 41} ${x99 - 8},${y + 33}" fill="${provider.color}" stroke="${panel}" stroke-width="2"/>`);
  svg.push(`<line x1="${xmax}" y1="${y + 23}" x2="${xmax}" y2="${y + 43}" stroke="${provider.color}" stroke-width="3"/>`);
  svg.push(`<text class="metric" x="47" y="${y + 65}">${fmt(row.roundTripMs.p50)} / ${fmt(row.roundTripMs.p99)} / ${fmt(row.roundTripMs.max)} ms</text>`);
  svg.push(`<text class="detail" x="47" y="${y + 85}">P50 / P99 / max · ${formatInt(row.received)}/${formatInt(row.expected)} · ${pct(row.lossPercent)} loss${provider.id === "moqdev" ? ` · ${formatInt(row.outOfOrder)} reordered` : ""}</text>`);
}

function renderMediaRow(row, provider, y, region) {
  const completion = provider.id === "moqdev" ? hostedCompletion(region) : null;
  svg.push(`<rect x="25" y="${y - 14}" width="11" height="11" rx="2" fill="${provider.color}"/><text class="provider" x="47" y="${y - 3}">${provider.name}</text>`);
  svg.push(`<text class="qualifier" x="47" y="${y + 17}">${provider.media}</text>`);
  if (!row) {
    svg.push(`<text class="metric" x="47" y="${y + 56}">NO COMPLETED TRIAL</text>`);
    svg.push(`<text class="detail" x="47" y="${y + 82}">${completion.completed}/${completion.attempts} completed · transport close + first-frame timeout</text>`);
    return;
  }
  const x50 = mediaScale(row.latencyMs.p50);
  const x99 = mediaScale(row.latencyMs.p99);
  svg.push(`<line x1="${x50}" y1="${y + 33}" x2="${x99}" y2="${y + 33}" stroke="${provider.color}" stroke-width="6" stroke-linecap="round" opacity=".65"/>`);
  svg.push(`<circle cx="${x50}" cy="${y + 33}" r="7" fill="${provider.color}" stroke="${panel}" stroke-width="3"/>`);
  svg.push(`<polygon points="${x99},${y + 25} ${x99 + 8},${y + 33} ${x99},${y + 41} ${x99 - 8},${y + 33}" fill="${provider.color}" stroke="${panel}" stroke-width="2"/>`);
  svg.push(`<text class="metric" x="47" y="${y + 65}">${fmt(row.latencyMs.p50)} / ${fmt(row.latencyMs.p99)} / ${fmt(row.latencyMs.max)} ms</text>`);
  svg.push(`<text class="detail" x="47" y="${y + 85}">P50 / P99 / max · ${formatInt(row.received)}/${formatInt(row.expected)} · ${pct(row.lossPercent)} loss${completion ? ` · ${completion.completed}/${completion.attempts} trials complete` : ""}</text>`);
  svg.push(`<text class="detail" x="47" y="${y + 104}">${row.invalidMarkers} invalid markers · ${row.freezesOver250Ms} freezes &gt;250 ms · join P50 ${formatInt(Math.round(row.joinLatencyMs.p50))} ms</text>`);
}

function renderSummaries() {
  svg.push(`<g transform="translate(55 1630)">`);
  summaryCard(0, "CONTROL", "Self-hosted MoQ tightest in 3/3", "moq.dev: 108,000/108,000, but severe Frankfurt/Tokyo tails", "#35d3a4");
  summaryCard(575, "VIDEO", "Self-hosted MoQ retains the lead", "moq.dev public CDN: 4/7 five-minute trials completed", "#35d3a4");
  summaryCard(1150, "MANAGED MOQ EXTENSION", `${managedCompleted}/${managedAttempts} media trials complete`, "120 Hz control loss observed in 3/3 corridors", "#42bff5");
  svg.push(`</g>`);
}

function summaryCard(x, eyebrow, value, detail, color) {
  svg.push(`<rect x="${x}" y="0" width="540" height="135" rx="18" fill="${panel}" stroke="${border}" filter="url(#shadow)"/>`);
  svg.push(`<rect x="${x + 23}" y="24" width="10" height="10" rx="2" fill="${color}"/><text class="eyebrow" x="${x + 45}" y="34">${eyebrow}</text>`);
  svg.push(`<text class="summary-value" x="${x + 23}" y="77">${value}</text><text class="summary-detail" x="${x + 23}" y="108">${detail}</text>`);
}

function renderFooter() {
  svg.push(`<g transform="translate(55 1800)"><rect width="1690" height="140" rx="18" fill="#10263a" stroke="#2c4e68"/>`);
  svg.push(`<text class="verdict" x="24" y="33">Verdict: self-hosted MoQ led the matched matrix; hosted-service extensions are reported separately.</text>`);
  svg.push(`<text class="note" x="24" y="61">Control: application RTT at 120 Hz, 5 min/provider/region. moq.dev control used latest-state groups and one pinned California ingress; its multi-edge qualification failed 0/600.</text>`);
  svg.push(`<text class="note" x="24" y="84">Media: capture-to-decoded-frame headless glass-to-glass proxy. moq.dev used per-frame fMP4 at conservative latency-max=100ms; failed attempts count against completion.</text>`);
  svg.push(`<text class="note" x="24" y="107">Do not compare control RTT numerically with one-way media latency. Camera exposure and display scanout are excluded. PulseBeam media is the disclosed 5 Mbps initial-BWE variant.</text>`);
  svg.push(`<text class="note" x="24" y="130">moq.dev is a public unauthenticated demo cluster, not a production SLA relay. Cloudflare Managed MoQ used a separately dated draft-14 extension.</text>`);
  svg.push(`</g>`);
  svg.push(`<text class="note" x="55" y="1970">GCP · 2026-07-18/20 · raw evidence, failures, tuning rejection, and frozen protocol retained</text>`);
  svg.push(`<text class="note" x="1745" y="1970" text-anchor="end">Managed MoQ media: Virginia 2/3 · Frankfurt 3/3 · Tokyo 3/3 · moq.dev: 3/3 · 0/2 · 1/2</text>`);
}

function providerTotals(rows, expectedKey, receivedKey) {
  return Object.fromEntries(providers.map((provider) => {
    const selected = rows.filter((row) => row.provider === provider.id);
    return [provider.id, {
      expected: selected.reduce((sum, row) => sum + row[expectedKey], 0),
      received: selected.reduce((sum, row) => sum + row[receivedKey], 0),
    }];
  }));
}
function controlScale(value) {
  const min = 50;
  const max = 2500;
  const clamped = Math.max(min, Math.min(max, value));
  return 195 + (Math.log(clamped) - Math.log(min)) / (Math.log(max) - Math.log(min)) * 310;
}
function mediaScale(value) {
  const min = 160;
  const max = 320;
  return 195 + (Math.max(min, Math.min(max, value)) - min) / (max - min) * 310;
}
function fmt(value) { return Number(value.toFixed(1)); }
function pct(value) { return value === 0 ? "0%" : `${value.toFixed(4)}%`; }
function formatInt(value) { return new Intl.NumberFormat("en-US").format(value); }
