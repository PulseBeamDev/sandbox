import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const resultsDir = path.join(root, "results-fair-gcp-20260718");
const qualificationFile = path.join(
  resultsDir,
  "qualification/transport-bench-publisher-west/final/qualification/workload.json",
);
const analysisFile = path.join(resultsDir, "media-analysis.json");
const output = path.join(resultsDir, "MOQ-BITRATE-DERIVATION.json");
const qualification = JSON.parse(await fs.readFile(qualificationFile, "utf8"));
const analysis = JSON.parse(await fs.readFile(analysisFile, "utf8"));

const annexB = qualification.results.annexB;
const fmp4 = qualification.results.fragmentedMp4;
if (annexB.expected !== fmp4.expected || annexB.measuredBitrateBps !== 4_000_000) {
  throw new Error("The paired Annex-B/fMP4 qualification is not usable");
}
const averageFmp4OverheadBytesPerFrame =
  (fmp4.measuredBytes - annexB.measuredBytes) / annexB.expected;
const trials = analysis.trials
  .filter((trial) => trial.summary?.provider === "moq" && trial.summary?.media?.measuredFrames === 9000)
  .map((trial) => {
    const counter = trial.publisherSummary.measuredElementaryStream;
    const derivedH264Bytes = counter.bytes - averageFmp4OverheadBytesPerFrame * counter.frames;
    const durationSeconds = counter.frames / trial.summary.media.fps;
    return {
      runId: trial.summary.runId,
      frames: counter.frames,
      recordedFmp4Bytes: counter.bytes,
      recordedFmp4BitrateBps: counter.bitrateBps,
      derivedH264PayloadBytes: derivedH264Bytes,
      derivedH264PayloadBitrateBps: derivedH264Bytes * 8 / durationSeconds,
    };
  })
  .sort((a, b) => a.runId.localeCompare(b.runId));

if (trials.length !== 9 || trials.some((trial) => trial.derivedH264PayloadBitrateBps !== 4_000_000)) {
  throw new Error("MoQ bitrate derivation did not resolve to the frozen H.264 rate");
}

const result = {
  purpose: "Clarify that the MoQ publisher's historically named measuredElementaryStream counter records fMP4 output bytes.",
  method: "Subtract the average fMP4 container overhead observed by the paired qualification using the same encoder, source, cadence, and fragmentation settings.",
  qualification: {
    file: path.relative(root, qualificationFile),
    frames: annexB.expected,
    annexBBytes: annexB.measuredBytes,
    annexBBitrateBps: annexB.measuredBitrateBps,
    fmp4Bytes: fmp4.measuredBytes,
    fmp4BitrateBps: fmp4.measuredBitrateBps,
    averageFmp4OverheadBytesPerFrame,
    annexBInvalidMarkers: annexB.invalidMarkers,
    fmp4InvalidMarkers: fmp4.invalidMarkers,
  },
  trials,
};
await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(output);
