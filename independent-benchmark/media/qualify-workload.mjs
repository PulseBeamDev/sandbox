import { once } from "node:events";
import {
  AnnexBAccessUnitParser,
  DEFAULT_MEDIA,
  runTimestampedSource,
  startAnnexBDecoder,
  startAnnexBEncoder,
  startFragmentedMp4Decoder,
  startFragmentedMp4Encoder,
} from "./codec.mjs";
import { diagnoseMarker } from "./marker.mjs";

const media = {
  ...DEFAULT_MEDIA,
  strictCbr: true,
  sourceProfile: "translated-texture-v1",
};
const warmupFrames = 60;
const measuredFrames = 180;
const cooldownFrames = 30;
const bitrateTolerance = 0.05;

const results = {
  annexB: await runCase("annex-b", startAnnexBEncoder, startAnnexBDecoder),
  fragmentedMp4: await runCase(
    "fragmented-mp4",
    startFragmentedMp4Encoder,
    startFragmentedMp4Decoder,
  ),
};

for (const [name, result] of Object.entries(results)) {
  const error = Math.abs(result.measuredBitrateBps - media.bitrate) / media.bitrate;
  if (error > bitrateTolerance) {
    throw new Error(`${name} bitrate qualification failed: ${JSON.stringify(result)}`);
  }
  if (
    result.received !== measuredFrames
    || result.invalidMarkers !== 0
    || result.missingFrameIds.length !== 0
    || result.duplicateFrameIds.length !== 0
    || result.unexpectedFrameIds.length !== 0
    || result.outOfOrder !== 0
  ) {
    throw new Error(`${name} decode qualification failed: ${JSON.stringify(result)}`);
  }
  if (result.sourceSkips !== 0) {
    throw new Error(`${name} source scheduling qualification failed: ${JSON.stringify(result)}`);
  }
}

process.stdout.write(`${JSON.stringify({
  qualification: "passed",
  media,
  warmupFrames,
  measuredFrames,
  cooldownFrames,
  bitrateTolerancePercent: bitrateTolerance * 100,
  results,
}, null, 2)}\n`);

async function runCase(name, startEncoder, startDecoder) {
  const received = [];
  let invalidMarkers = 0;
  let totalInvalidMarkers = 0;
  let highestValidFrameId = -1;
  const invalidMarkerDiagnostics = [];
  let encodedBytes = 0;
  const decoder = startDecoder({
    width: media.width,
    height: media.height,
    onFrame: (frame) => {
      highestValidFrameId = Math.max(highestValidFrameId, frame.frameId);
      if (frame.frameId < warmupFrames || frame.frameId >= warmupFrames + measuredFrames) return;
      received.push({
        frameId: frame.frameId,
        latencyMs: Number(frame.presentedUs - frame.captureUs) / 1000,
      });
    },
    onInvalidFrame: (frame) => {
      totalInvalidMarkers += 1;
      const measuredWindowActive = highestValidFrameId >= warmupFrames - 1
        && highestValidFrameId < warmupFrames + measuredFrames - 1;
      if (measuredWindowActive) invalidMarkers += 1;
      if (invalidMarkerDiagnostics.length < 3) {
        invalidMarkerDiagnostics.push({
          afterFrameId: highestValidFrameId,
          countedInMeasuredWindow: measuredWindowActive,
          marker: diagnoseMarker(frame, media.width, media.height),
        });
      }
    },
  });
  const encoder = startEncoder(media);
  encoder.output.on("data", (chunk) => { encodedBytes += chunk.length; });

  if (name === "annex-b") {
    const parser = new AnnexBAccessUnitParser((accessUnit) => decoder.input.write(accessUnit));
    encoder.output.on("data", (chunk) => parser.push(chunk));
    encoder.output.on("end", () => {
      parser.flush();
      decoder.input.end();
    });
  } else {
    encoder.output.pipe(decoder.input);
  }

  const warmup = await runTimestampedSource(encoder.input, {
    ...media,
    frames: warmupFrames,
    startFrameId: 0,
  });
  await waitForEncoderDrain();
  const measuredStartBytes = encodedBytes;

  const measured = await runTimestampedSource(encoder.input, {
    ...media,
    frames: measuredFrames,
    startFrameId: warmupFrames,
  });
  await waitForEncoderDrain();
  const measuredBytes = encodedBytes - measuredStartBytes;

  const cooldown = await runTimestampedSource(encoder.input, {
    ...media,
    frames: cooldownFrames,
    startFrameId: warmupFrames + measuredFrames,
  });
  encoder.input.end();
  const [encoderCode] = await once(encoder.process, "exit");
  const [decoderCode] = await once(decoder.process, "exit");
  if (encoderCode !== 0 || decoderCode !== 0) {
    throw new Error(`${name} codec process failed: ${JSON.stringify({
      encoderCode,
      decoderCode,
      encoder: encoder.diagnostics.snapshot(),
      decoder: decoder.diagnostics.snapshot(),
    })}`);
  }

  const latencyValues = received.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const expectedIds = Array.from({ length: measuredFrames }, (_, index) => warmupFrames + index);
  const receivedIds = received.map(({ frameId }) => frameId);
  const receivedSet = new Set(receivedIds);
  const expectedSet = new Set(expectedIds);
  const counts = new Map();
  for (const frameId of receivedIds) counts.set(frameId, (counts.get(frameId) ?? 0) + 1);
  const duplicateFrameIds = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([frameId]) => frameId);
  let outOfOrder = 0;
  for (let index = 1; index < receivedIds.length; index += 1) {
    if (receivedIds[index] <= receivedIds[index - 1]) outOfOrder += 1;
  }
  return {
    measuredBytes,
    measuredBitrateBps: measuredBytes * 8 / (measuredFrames / media.fps),
    bitrateErrorPercent: (measuredBytes * 8 / (measuredFrames / media.fps) - media.bitrate)
      / media.bitrate * 100,
    expected: measuredFrames,
    received: received.length,
    invalidMarkers,
    totalInvalidMarkers,
    invalidMarkerDiagnostics,
    missingFrameIds: expectedIds.filter((frameId) => !receivedSet.has(frameId)),
    duplicateFrameIds,
    unexpectedFrameIds: [...receivedSet].filter((frameId) => !expectedSet.has(frameId)),
    outOfOrder,
    sourceSkips: warmup.skipped + measured.skipped + cooldown.skipped,
    firstFrameId: received.at(0)?.frameId ?? null,
    lastFrameId: received.at(-1)?.frameId ?? null,
    latencyMs: {
      p50: percentile(latencyValues, 0.5),
      p99: percentile(latencyValues, 0.99),
      max: latencyValues.at(-1) ?? null,
    },
  };
}

// Both encoders use zerolatency, but stdout delivery is asynchronous. A short
// idle interval makes the byte counter's warmup/measured boundary explicit.
async function waitForEncoderDrain() {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function percentile(values, quantile) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.floor(values.length * quantile))];
}
