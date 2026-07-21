import fs from "node:fs/promises";
import path from "node:path";

const resultsDir = path.resolve(process.argv[2] ?? "results-cross-region-moq");
const outputPath = path.resolve(process.argv[3] ?? "moq-analysis.json");
const files = await walk(resultsDir);
const summaryFiles = files.filter((file) => file.endsWith("-moq-A.summary.json"));

if (summaryFiles.length === 0) {
  throw new Error(`No MoQ role-A summaries found below ${resultsDir}`);
}

const trials = [];
for (const summaryPath of summaryFiles.sort()) {
  const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  const rawPath = summaryPath.replace(/\.summary\.json$/, ".jsonl");
  const raw = await fs.readFile(rawPath, "utf8");
  const samples = raw.trim().split("\n").filter(Boolean).map(JSON.parse);
  const global = summary.corridor?.startsWith("west-")
    || summary.runId.startsWith("moq-global-")
    || summary.runId.startsWith("gcp-");
  const durationClass = summary.runId.includes("-5m-") || summary.expected >= 36_000
    ? "five-minute"
    : "one-minute";
  const status = summary.received === summary.expected && summary.sendFailures === 0
    ? "complete"
    : summary.received === 0 && summary.sendFailures > 0
      ? "setup-failed"
      : summary.sendFailures === 0
        ? "loss-observed"
        : "send-failed";
  const threshold = samples.length === 0
    ? null
    : percentile(samples.map((sample) => sample.roundTripMs), 0.5) + 50;

  trials.push({ summary, samples, global, durationClass, status, threshold });
}

const usable = trials.filter((trial) => trial.global && trial.status !== "setup-failed");
const groups = groupBy(usable, (trial) => `${trial.summary.corridor}|${trial.durationClass}`);
const aggregates = [...groups.values()].map((group) => {
  const latencies = group.flatMap((trial) => trial.samples.map((sample) => sample.roundTripMs));
  const expected = sum(group.map((trial) => trial.summary.expected));
  const received = sum(group.map((trial) => trial.summary.received));
  return {
    corridor: group[0].summary.corridor,
    durationClass: group[0].durationClass,
    trials: group.length,
    payloadBytes: group[0].summary.payloadBytes,
    rateHz: group[0].summary.rateHz,
    expected,
    received,
    lost: expected - received,
    lossPercent: expected === 0 ? 0 : ((expected - received) / expected) * 100,
    duplicates: sum(group.map((trial) => trial.summary.duplicates)),
    outOfOrder: sum(group.map((trial) => trial.summary.outOfOrder)),
    sendFailures: sum(group.map((trial) => trial.summary.sendFailures)),
    tailSamples: sum(group.map((trial) => trial.samples.filter(
      (sample) => sample.roundTripMs > trial.threshold,
    ).length)),
    roundTripMs: distribution(latencies),
  };
}).sort(compareRows);

const trialRows = trials.filter((trial) => trial.global).map((trial) => ({
  runId: trial.summary.runId,
  corridor: trial.summary.corridor,
  durationClass: trial.durationClass,
  status: trial.status,
  expected: trial.summary.expected,
  received: trial.summary.received,
  lost: trial.summary.lost,
  lossPercent: trial.summary.lossPercent,
  duplicates: trial.summary.duplicates,
  outOfOrder: trial.summary.outOfOrder,
  sendFailures: trial.summary.sendFailures,
  roundTripMs: trial.summary.roundTripMs,
  tailThresholdMs: trial.threshold,
  tailSamples: trial.threshold === null ? 0 : trial.samples.filter(
    (sample) => sample.roundTripMs > trial.threshold,
  ).length,
})).sort(compareRows);

const globalAttempts = trialRows.length;
const setupFailures = trialRows.filter((trial) => trial.status === "setup-failed").length;
const firstSummary = trials[0].summary;
const analysis = {
  generatedAt: new Date().toISOString(),
  resultsDir,
  methodology: {
    provider: firstSummary.provider,
    implementation: firstSummary.implementation,
    transport: `${firstSummary.draft} over WebTransport/QUIC datagrams`,
    payloadBytes: firstSummary.payloadBytes,
    rateHz: firstSummary.rateHz,
    tailDefinition: "per-trial RTT greater than that trial's p50 plus 50 ms",
  },
  startup: {
    globalAttempts,
    setupFailures,
    setupFailurePercent: globalAttempts === 0 ? 0 : (setupFailures / globalAttempts) * 100,
  },
  aggregates,
  trials: trialRows,
};

await fs.writeFile(outputPath, JSON.stringify(analysis, null, 2) + "\n");

console.log("MoQ steady-state aggregate (usable application-RTT trials, including observed loss)");
console.table(aggregates.map((row) => ({
  corridor: row.corridor,
  duration: row.durationClass,
  trials: row.trials,
  received: `${row.received}/${row.expected}`,
  lossPct: round(row.lossPercent, 4),
  p50: round(row.roundTripMs.p50, 2),
  p95: round(row.roundTripMs.p95, 2),
  p99: round(row.roundTripMs.p99, 2),
  p999: round(row.roundTripMs.p999, 2),
  max: round(row.roundTripMs.max, 2),
  tailSamples: row.tailSamples,
})));

console.log("MoQ startup and per-trial status");
console.table(trialRows.map((row) => ({
  run: row.runId,
  status: row.status,
  received: `${row.received}/${row.expected}`,
  sendFailures: row.sendFailures,
  p50: round(row.roundTripMs.p50, 2),
  p99: round(row.roundTripMs.p99, 2),
  max: round(row.roundTripMs.max, 2),
})));
console.log(`Wrote ${outputPath}`);

async function walk(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(root, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  }));
  return nested.flat();
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { min: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, p999: 0, max: 0 };
  }
  return {
    min: sorted[0],
    mean: sum(sorted) / sorted.length,
    p50: percentileSorted(sorted, 0.5),
    p90: percentileSorted(sorted, 0.9),
    p95: percentileSorted(sorted, 0.95),
    p99: percentileSorted(sorted, 0.99),
    p999: percentileSorted(sorted, 0.999),
    max: sorted.at(-1),
  };
}

function percentile(values, quantile) {
  return percentileSorted([...values].sort((a, b) => a - b), quantile);
}

function percentileSorted(sorted, quantile) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (index - lower));
}

function groupBy(values, keyFn) {
  const result = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(value);
  }
  return result;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value, digits) {
  if (value === null || value === undefined) return null;
  return Number(value.toFixed(digits));
}

function compareRows(a, b) {
  return `${a.corridor}|${a.durationClass}|${a.runId ?? ""}`
    .localeCompare(`${b.corridor}|${b.durationClass}|${b.runId ?? ""}`);
}
