import fs from "node:fs/promises";
import path from "node:path";

const reportPath = process.argv[2];
if (!reportPath) throw new Error("Usage: npm run analyze -- results/<run>-report.json");

const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
const resultsDir = path.dirname(reportPath);
const aggregate = {};

for (let index = 0; index < report.trialPlan.length; index += 1) {
  const provider = report.trialPlan[index];
  const rawPath = path.join(
    resultsDir,
    `${report.runId}-${String(index + 1).padStart(2, "0")}-${provider}.jsonl`,
  );
  const samples = (await fs.readFile(rawPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const summary = report.summaries[index];
  const missingSequences = findMissingSequences(samples, summary.expected);
  const baseline = summary.latencyMs.p50;
  const burstThreshold = baseline + 20;
  const bursts = contiguousBursts(samples, burstThreshold);
  const longestBurst = bursts.sort((a, b) => b.count - a.count)[0] ?? null;

  aggregate[provider] ??= { latencies: [], expected: 0, received: 0, connectMs: [] };
  aggregate[provider].latencies.push(...samples.map((sample) => sample.latencyMs));
  aggregate[provider].expected += summary.expected;
  aggregate[provider].received += summary.received;
  aggregate[provider].connectMs.push(summary.connectMs);

  process.stdout.write(`${JSON.stringify({
    provider,
    trial: summary.trialNumber,
    connectMs: rounded(summary.connectMs),
    received: `${summary.received}/${summary.expected}`,
    missingSequences,
    outOfOrder: summary.outOfOrder ?? "not recorded",
    p50: rounded(summary.latencyMs.p50),
    p95: rounded(summary.latencyMs.p95),
    p99: rounded(summary.latencyMs.p99),
    p999: rounded(summary.latencyMs.p999),
    max: rounded(summary.latencyMs.max),
    samplesOverBaselinePlus20: samples.filter((sample) => sample.latencyMs > burstThreshold).length,
    longestBurst: longestBurst === null ? null : {
      startSequence: longestBurst.startSequence,
      endSequence: longestBurst.endSequence,
      count: longestBurst.count,
      approximateDurationMs: longestBurst.count * report.config.intervalMs,
      peakMs: rounded(longestBurst.peakMs),
    },
  })}\n`);
}

for (const [provider, values] of Object.entries(aggregate)) {
  values.latencies.sort((a, b) => a - b);
  const lost = values.expected - values.received;
  process.stdout.write(`${JSON.stringify({
    aggregate: provider,
    expected: values.expected,
    received: values.received,
    lost,
    lossPercent: rounded((lost / values.expected) * 100),
    connectMs: {
      min: rounded(Math.min(...values.connectMs)),
      mean: rounded(values.connectMs.reduce((sum, value) => sum + value, 0) / values.connectMs.length),
      max: rounded(Math.max(...values.connectMs)),
    },
    latencyMs: {
      min: rounded(percentile(values.latencies, 0)),
      p50: rounded(percentile(values.latencies, 50)),
      p90: rounded(percentile(values.latencies, 90)),
      p95: rounded(percentile(values.latencies, 95)),
      p99: rounded(percentile(values.latencies, 99)),
      p999: rounded(percentile(values.latencies, 99.9)),
      max: rounded(percentile(values.latencies, 100)),
      mean: rounded(values.latencies.reduce((sum, value) => sum + value, 0) / values.latencies.length),
    },
  })}\n`);
}

function findMissingSequences(samples, expectedCount) {
  const present = new Set(samples.map((sample) => sample.sequence));
  const missing = [];
  for (let sequence = 0; sequence < expectedCount; sequence += 1) {
    if (!present.has(sequence)) missing.push(sequence);
  }
  return missing;
}

function contiguousBursts(samples, threshold) {
  const bursts = [];
  let current = null;
  for (const sample of samples) {
    if (sample.latencyMs <= threshold) {
      if (current !== null) bursts.push(current);
      current = null;
      continue;
    }
    if (current === null || sample.sequence !== current.endSequence + 1) {
      if (current !== null) bursts.push(current);
      current = {
        startSequence: sample.sequence,
        endSequence: sample.sequence,
        count: 1,
        peakMs: sample.latencyMs,
      };
    } else {
      current.endSequence = sample.sequence;
      current.count += 1;
      current.peakMs = Math.max(current.peakMs, sample.latencyMs);
    }
  }
  if (current !== null) bursts.push(current);
  return bursts;
}

function percentile(sorted, value) {
  if (sorted.length === 0) return null;
  if (value === 100) return sorted[sorted.length - 1];
  const rank = (value / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function rounded(value) {
  return value === null ? null : Number(value.toFixed(3));
}
