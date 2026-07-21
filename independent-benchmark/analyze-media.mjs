import fs from "node:fs/promises";
import path from "node:path";

const resultsDir = path.resolve(process.argv[2] ?? "results-media");
const outputPath = path.resolve(process.argv[3] ?? "media-analysis.json");
const files = await walk(resultsDir);
const summaryFiles = files.filter((file) => file.endsWith(".summary.json"));
const summaries = await Promise.all(summaryFiles.map(async (summaryFile) => ({
  summaryFile,
  summary: JSON.parse(await fs.readFile(summaryFile, "utf8")),
})));
const summaryByTrialRole = new Map(summaries.map(({ summaryFile, summary }) => [
  trialRoleKey(summary),
  { summaryFile, summary },
]));
const trials = [];
const rejectedTrials = [];

for (const { summaryFile, summary } of summaries) {
  if (summary.role !== "subscriber") continue;
  const publisher = summaryByTrialRole.get(trialRoleKey({ ...summary, role: "publisher" }));
  const rawFile = summaryFile.replace(/\.summary\.json$/, ".jsonl");
  let raw = [];
  try {
    raw = (await fs.readFile(rawFile, "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {}
  const rejectionReasons = validateTrial(summary, publisher?.summary, raw);
  if (rejectionReasons.length) {
    rejectedTrials.push({
      summaryFile,
      publisherSummaryFile: publisher?.summaryFile ?? null,
      rawFile,
      runId: summary.runId,
      rejectionReasons,
    });
    continue;
  }
  trials.push({
    summaryFile,
    publisherSummaryFile: publisher.summaryFile,
    summary,
    publisherSummary: publisher.summary,
    raw,
  });
}

const groups = new Map();
for (const trial of trials) {
  const condition = trial.summary.runId.includes("-combined-") ? "media+control" : "media-only";
  const durationClass = classifyDuration(trial.summary);
  const key = [trial.summary.corridor, trial.summary.provider, condition, durationClass].join("\u0000");
  const group = groups.get(key) ?? {
    corridor: trial.summary.corridor,
    provider: trial.summary.provider,
    condition,
    durationClass,
    trials: [],
    latencies: [],
    presentationGaps: [],
    clockOffsets: [],
  };
  group.trials.push(trial.summary);
  group.latencies.push(...trial.raw.map((sample) => sample.latencyMs));
  for (let index = 1; index < trial.raw.length; index += 1) {
    group.presentationGaps.push(
      Number(BigInt(trial.raw[index].presentedUs) - BigInt(trial.raw[index - 1].presentedUs)) / 1000,
    );
  }
  group.clockOffsets.push(
    ...clockOffsets(trial.summary.clock),
    ...clockOffsets(trial.publisherSummary.clock),
  );
  groups.set(key, group);
}

const aggregate = [...groups.values()].map((group) => {
  const expected = group.trials.reduce((sum, trial) => sum + trial.expected, 0);
  const received = group.trials.reduce((sum, trial) => sum + trial.received, 0);
  return {
    corridor: group.corridor,
    provider: group.provider,
    condition: group.condition,
    durationClass: group.durationClass,
    completedTrials: group.trials.length,
    expected,
    received,
    lost: expected - received,
    lossPercent: expected ? (expected - received) / expected * 100 : null,
    duplicates: group.trials.reduce((sum, trial) => sum + trial.duplicates, 0),
    outOfOrder: group.trials.reduce((sum, trial) => sum + trial.outOfOrder, 0),
    invalidMarkers: group.trials.reduce((sum, trial) => sum + trial.invalidMarkers, 0),
    latencyMs: numericSummary(group.latencies),
    presentationGapMs: numericSummary(group.presentationGaps),
    freezesOver100Ms: group.presentationGaps.filter((value) => value > 100).length,
    freezesOver250Ms: group.presentationGaps.filter((value) => value > 250).length,
    maxReportedClockOffsetMs: group.clockOffsets.length
      ? Math.max(...group.clockOffsets.map(Math.abs))
      : null,
    joinLatencyMs: numericSummary(group.trials.map((trial) => trial.joinLatencyMs)),
    runs: group.trials.map((trial) => trial.runId),
  };
}).sort((a, b) => (
  a.corridor.localeCompare(b.corridor)
  || a.provider.localeCompare(b.provider)
  || a.condition.localeCompare(b.condition)
  || a.durationClass.localeCompare(b.durationClass)
));

const analysis = {
  generatedAt: new Date().toISOString(),
  resultsDir,
  measurement: "pixel timestamp at capture to marker recovery after H264 decode",
  caveat: "Headless cloud measurement ends at a decoded, presentable frame and excludes physical display scanout and camera sensor exposure.",
  aggregate,
  rejectedTrials,
  trials: trials.map(({
    summaryFile, publisherSummaryFile, rawFile, summary, publisherSummary,
  }) => ({ summaryFile, publisherSummaryFile, rawFile, summary, publisherSummary })),
};
await fs.writeFile(outputPath, JSON.stringify(analysis, null, 2) + "\n");
process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);

async function walk(directory) {
  const output = [];
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return output;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(target));
    else output.push(target);
  }
  return output;
}

function validateTrial(summary, publisher, raw) {
  const reasons = [];
  if (!publisher) reasons.push("matching publisher summary is missing");
  if (!Number.isInteger(summary.media?.cooldownFrames) || summary.media.cooldownFrames < 1) {
    reasons.push("missing post-measurement cooldown");
  }
  if (summary.expected !== summary.media?.measuredFrames) {
    reasons.push("expected frame count differs from configured measured frames");
  }
  if (raw.length !== summary.received) reasons.push("raw sample count differs from summary");
  if (!Number.isInteger(summary.decodedIncludingWarmup) || summary.decodedIncludingWarmup < 1) {
    reasons.push("media path never produced a decoded frame");
  }
  if (publisher && JSON.stringify(summary.media) !== JSON.stringify(publisher.media)) {
    reasons.push("publisher and subscriber media settings differ");
  }
  if (summary.media?.sourceProfile !== "translated-texture-v1") {
    reasons.push("source profile is not the frozen translated texture v1");
  }
  if (summary.media?.strictCbr !== true) reasons.push("strict CBR is not enabled");
  // Missing, duplicate, out-of-order, and CRC-invalid decoded frames are
  // transport outcomes. They stay in the aggregate instead of invalidating a
  // poor trial. Only source/codec/clock/resource defects reject evidence.
  if (publisher?.source?.skipped !== 0) reasons.push("publisher source scheduling skip");
  if (publisher) {
    const observed = publisher.measuredElementaryStream;
    if (!observed || observed.frames !== summary.media?.measuredFrames) {
      reasons.push("measured elementary-stream frame count is missing or wrong");
    }
    const configuredBitrate = summary.media?.bitrate;
    const bitrateError = Math.abs(observed?.bitrateBps - configuredBitrate) / configuredBitrate;
    if (!Number.isFinite(bitrateError) || bitrateError > 0.05) {
      reasons.push("observed elementary-stream bitrate is outside the 5% gate");
    }
  }
  const minimumId = summary.media?.warmupFrames;
  const maximumId = minimumId + summary.media?.measuredFrames;
  if (raw.some(({ frameId }) => !Number.isInteger(frameId) || frameId < minimumId || frameId >= maximumId)) {
    reasons.push("raw sample contains a frame ID outside the measured interval");
  }
  if (new Set(raw.map(({ frameId }) => frameId)).size !== raw.length) {
    reasons.push("raw sample contains duplicate frame IDs");
  }
  if (summary.corridor !== "local") {
    validateCrossRegionClock("subscriber", summary.clock, reasons);
    validateCrossRegionClock("publisher", publisher?.clock, reasons);
  }
  return reasons;
}

function validateCrossRegionClock(role, clock, reasons) {
  if (clock?.source !== "chronyc tracking") {
    reasons.push(`${role} lacks chrony diagnostics`);
    return;
  }
  const offsets = clockOffsets(clock);
  if (!offsets.length) {
    reasons.push(`${role} has no parseable chrony clock offset`);
  } else if (Math.max(...offsets.map(Math.abs)) > 1) {
    reasons.push(`${role} clock offset exceeds 1 ms`);
  }
}

function clockOffsets(clock) {
  return [clock?.systemOffsetMs, clock?.lastOffsetMs].filter(Number.isFinite);
}

function trialRoleKey(summary) {
  return [summary.runId, summary.provider, summary.corridor, summary.role].join("\u0000");
}

function classifyDuration(summary) {
  const seconds = summary.expected / summary.media.fps;
  if (seconds >= 300) return "five-minute";
  if (seconds >= 60) return "one-minute";
  return "short";
}

function numericSummary(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: percentile(sorted, 0),
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    p50: percentile(sorted, 50), p90: percentile(sorted, 90), p95: percentile(sorted, 95),
    p99: percentile(sorted, 99), p999: percentile(sorted, 99.9), max: percentile(sorted, 100),
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (p === 100) return sorted.at(-1);
  const rank = p / 100 * (sorted.length - 1);
  const lower = Math.floor(rank);
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[Math.ceil(rank)] * weight;
}
