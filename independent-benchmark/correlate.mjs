import fs from "node:fs/promises";

const [firstPath, secondPath, thresholdText = "50"] = process.argv.slice(2);
if (!firstPath || !secondPath) {
  throw new Error("Usage: npm run correlate -- <first.jsonl> <second.jsonl> [tail-threshold-ms]");
}

const thresholdMs = Number(thresholdText);
if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
  throw new Error("tail-threshold-ms must be a positive number");
}

const first = await readSamples(firstPath);
const second = await readSamples(secondPath);
const overlapStart = Math.max(first[0].receivedAtUnixMs, second[0].receivedAtUnixMs);
const overlapEnd = Math.min(first.at(-1).receivedAtUnixMs, second.at(-1).receivedAtUnixMs);
if (overlapStart >= overlapEnd) throw new Error("The sample files have no wall-clock overlap");

const firstLabel = first[0].provider ?? "first";
const secondLabel = second[0].provider ?? "second";
const firstTails = tailsInOverlap(first, overlapStart, overlapEnd, thresholdMs);
const secondTails = tailsInOverlap(second, overlapStart, overlapEnd, thresholdMs);
const sharedBadSeconds = badSecondBuckets(
  [...firstTails, ...secondTails],
  overlapStart,
);

const matchedWithin50Ms = firstTails.filter((sample) => (
  secondTails.some((other) => Math.abs(other.receivedAtUnixMs - sample.receivedAtUnixMs) <= 50)
)).length;

const maxima = pairedBucketMaxima(first, second, overlapStart, overlapEnd, 1000);
const output = {
  overlap: {
    start: new Date(overlapStart).toISOString(),
    end: new Date(overlapEnd).toISOString(),
    seconds: (overlapEnd - overlapStart) / 1000,
  },
  thresholdMs,
  tails: {
    [firstLabel]: firstTails.length,
    [secondLabel]: secondTails.length,
    [`${firstLabel}MatchedWithin50MsOf${capitalize(secondLabel)}`]: matchedWithin50Ms,
  },
  oneSecondMaximumCorrelation: pearson(maxima),
  excludedSharedIncidentSeconds: sharedBadSeconds.size,
  clean: {
    [firstLabel]: cleanSummary(first, overlapStart, overlapEnd, sharedBadSeconds),
    [secondLabel]: cleanSummary(second, overlapStart, overlapEnd, sharedBadSeconds),
  },
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

async function readSamples(filePath) {
  const samples = (await fs.readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .sort((a, b) => a.receivedAtUnixMs - b.receivedAtUnixMs);
  if (samples.length === 0) throw new Error(`${filePath} has no samples`);
  return samples;
}

function tailsInOverlap(samples, start, end, threshold) {
  return samples.filter((sample) => (
    sample.receivedAtUnixMs >= start
    && sample.receivedAtUnixMs <= end
    && latency(sample) > threshold
  ));
}

function badSecondBuckets(samples, start) {
  return new Set(samples.map((sample) => Math.floor((sample.receivedAtUnixMs - start) / 1000)));
}

function pairedBucketMaxima(firstSamples, secondSamples, start, end, bucketMs) {
  const first = bucketMaxima(firstSamples, start, end, bucketMs);
  const second = bucketMaxima(secondSamples, start, end, bucketMs);
  const paired = [];
  for (const [bucket, firstMax] of first) {
    if (second.has(bucket)) paired.push([firstMax, second.get(bucket)]);
  }
  return paired;
}

function bucketMaxima(samples, start, end, bucketMs) {
  const buckets = new Map();
  for (const sample of samples) {
    if (sample.receivedAtUnixMs < start || sample.receivedAtUnixMs > end) continue;
    const bucket = Math.floor((sample.receivedAtUnixMs - start) / bucketMs);
    buckets.set(bucket, Math.max(buckets.get(bucket) ?? -Infinity, latency(sample)));
  }
  return buckets;
}

function pearson(pairs) {
  const firstMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const secondMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let numerator = 0;
  let firstSquares = 0;
  let secondSquares = 0;
  for (const [first, second] of pairs) {
    const firstDelta = first - firstMean;
    const secondDelta = second - secondMean;
    numerator += firstDelta * secondDelta;
    firstSquares += firstDelta * firstDelta;
    secondSquares += secondDelta * secondDelta;
  }
  return numerator / Math.sqrt(firstSquares * secondSquares);
}

function cleanSummary(samples, start, end, excludedSeconds) {
  const values = samples
    .filter((sample) => (
      sample.receivedAtUnixMs >= start
      && sample.receivedAtUnixMs <= end
      && !excludedSeconds.has(Math.floor((sample.receivedAtUnixMs - start) / 1000))
    ))
    .map(latency)
    .sort((a, b) => a - b);
  return {
    samples: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    p999: percentile(values, 99.9),
    max: percentile(values, 100),
  };
}

function latency(sample) {
  const value = sample.latencyMs ?? sample.roundTripMs;
  if (!Number.isFinite(value)) throw new Error("Sample has no numeric latencyMs or roundTripMs");
  return value;
}

function percentile(sorted, value) {
  if (sorted.length === 0) return null;
  if (value === 100) return sorted.at(-1);
  const rank = (value / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
