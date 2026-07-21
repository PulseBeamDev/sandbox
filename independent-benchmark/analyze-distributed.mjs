import fs from "node:fs/promises";
import path from "node:path";

const resultsDir = path.resolve(process.argv[2] ?? "results-cross-region");
const outputPath = path.resolve(process.argv[3] ?? "distributed-analysis.json");
const files = await walk(resultsDir);
const summaryFiles = files.filter((file) => file.endsWith("-A.summary.json"));

if (summaryFiles.length === 0) {
  throw new Error(`No role-A summary files found below ${resultsDir}`);
}

const trials = [];
for (const summaryPath of summaryFiles.sort()) {
  const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  const rawPath = summaryPath.replace(/\.summary\.json$/, ".jsonl");
  const samples = (await fs.readFile(rawPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .sort((a, b) => a.sequence - b.sequence);
  const baseCorridor = summary.corridor.split("/")[0];
  const placement = (summary.provider === "cloudflare"
    ? "cloudflare-edge"
    : summary.corridor.split("/")[1]
      ?? (summary.provider === "moq" ? "moq-self-hosted-west" : "pulsebeam-self-hosted-west"))
    .replace(/-paired-\d+m$/, "");
  const hypothesis = /hypothesis-|-(?:16b|1200b-30hz)/.test(summary.corridor + summary.runId);
  const baseline = percentile(samples.map((sample) => sample.roundTripMs), 0.5);
  const stallThresholdMs = baseline + 50;
  const bursts = contiguousBursts(samples, stallThresholdMs, summary.rateHz);

  trials.push({
    summary,
    baseCorridor,
    placement,
    hypothesis,
    samples,
    stallThresholdMs,
    stalls: {
      samples: samples.filter((sample) => sample.roundTripMs > stallThresholdMs).length,
      bursts: bursts.length,
      longest: bursts.sort((a, b) => b.count - a.count)[0] ?? null,
      highest: [...bursts].sort((a, b) => b.maxRoundTripMs - a.maxRoundTripMs)[0] ?? null,
    },
  });
}

const primaryTrials = trials.filter((trial) => !trial.hypothesis);
const primaryGroups = groupBy(primaryTrials, (trial) => (
  `${trial.baseCorridor}|${trial.summary.provider}|${trial.placement}`
));

const aggregates = [...primaryGroups.values()].map((group) => {
  const latencies = group.flatMap((trial) => trial.samples.map((sample) => sample.roundTripMs));
  const expected = sum(group.map((trial) => trial.summary.expected));
  const received = sum(group.map((trial) => trial.summary.received));
  return {
    corridor: group[0].baseCorridor,
    provider: group[0].summary.provider,
    placement: group[0].placement,
    trials: group.length,
    expected,
    received,
    lost: expected - received,
    lossPercent: expected === 0 ? 0 : ((expected - received) / expected) * 100,
    duplicates: sum(group.map((trial) => trial.summary.duplicates)),
    outOfOrder: sum(group.map((trial) => trial.summary.outOfOrder)),
    roundTripMs: distribution(latencies),
    maxPublisherBufferedAmount: Math.max(...group.map(
      (trial) => trial.summary.maxPublisherBufferedAmount ?? 0,
    )),
  };
}).sort(compareRows);

const trialRows = trials.map((trial) => ({
  runId: trial.summary.runId,
  corridor: trial.baseCorridor,
  provider: trial.summary.provider,
  placement: trial.placement,
  payloadBytes: trial.summary.payloadBytes,
  rateHz: trial.summary.rateHz,
  expected: trial.summary.expected,
  received: trial.summary.received,
  lost: trial.summary.lost,
  lossPercent: trial.summary.lossPercent,
  duplicates: trial.summary.duplicates,
  outOfOrder: trial.summary.outOfOrder,
  roundTripMs: trial.summary.roundTripMs,
  maxPublisherBufferedAmount: trial.summary.maxPublisherBufferedAmount,
  stallThresholdMs: trial.stallThresholdMs,
  stalls: trial.stalls,
  hypothesis: trial.hypothesis,
})).sort(compareRows);

const analysis = {
  generatedAt: new Date().toISOString(),
  resultsDir,
  stallDefinition: "per-trial RTT greater than that trial's p50 plus 50 ms; contiguous by transmitted sequence",
  primaryAggregates: aggregates,
  trials: trialRows,
};

await fs.writeFile(outputPath, JSON.stringify(analysis, null, 2) + "\n");

console.log("Primary aggregate (application RTT)");
console.table(aggregates.map((row) => ({
  corridor: row.corridor,
  provider: row.provider,
  placement: row.placement,
  trials: row.trials,
  received: `${row.received}/${row.expected}`,
  lossPct: round(row.lossPercent, 4),
  p50: round(row.roundTripMs.p50, 1),
  p95: round(row.roundTripMs.p95, 1),
  p99: round(row.roundTripMs.p99, 1),
  p999: round(row.roundTripMs.p999, 1),
  max: round(row.roundTripMs.max, 1),
})));

console.log("Per-trial stalls");
console.table(trialRows.map((row) => ({
  run: row.runId.replace(/^xregion-\d+-/, ""),
  bytes: row.payloadBytes,
  hz: row.rateHz,
  p50: round(row.roundTripMs.p50, 1),
  p99: round(row.roundTripMs.p99, 1),
  max: round(row.roundTripMs.max, 1),
  stallSamples: row.stalls.samples,
  stallBursts: row.stalls.bursts,
  longestBurstMs: round(row.stalls.longest?.approximateDurationMs ?? 0, 1),
  buffered: row.maxPublisherBufferedAmount,
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

function contiguousBursts(samples, thresholdMs, rateHz) {
  const bursts = [];
  let current = null;
  for (const sample of samples) {
    if (sample.roundTripMs <= thresholdMs) {
      if (current) bursts.push(finishBurst(current, rateHz));
      current = null;
      continue;
    }
    if (!current || sample.sequence !== current.endSequence + 1) {
      if (current) bursts.push(finishBurst(current, rateHz));
      current = {
        startSequence: sample.sequence,
        endSequence: sample.sequence,
        count: 1,
        maxRoundTripMs: sample.roundTripMs,
        firstRoundTripMs: sample.roundTripMs,
        lastRoundTripMs: sample.roundTripMs,
      };
      continue;
    }
    current.endSequence = sample.sequence;
    current.count += 1;
    current.maxRoundTripMs = Math.max(current.maxRoundTripMs, sample.roundTripMs);
    current.lastRoundTripMs = sample.roundTripMs;
  }
  if (current) bursts.push(finishBurst(current, rateHz));
  return bursts;
}

function finishBurst(burst, rateHz) {
  return {
    ...burst,
    approximateDurationMs: (burst.count / rateHz) * 1000,
  };
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
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

function compareRows(a, b) {
  return `${a.corridor}|${a.provider}|${a.placement}|${a.runId ?? ""}`
    .localeCompare(`${b.corridor}|${b.provider}|${b.placement}|${b.runId ?? ""}`);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
