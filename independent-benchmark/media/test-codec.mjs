import { once } from "node:events";
import {
  AnnexBAccessUnitParser,
  DEFAULT_MEDIA,
  runTimestampedSource,
  startAnnexBDecoder,
  startAnnexBEncoder,
} from "./codec.mjs";
import { diagnoseMarker } from "./marker.mjs";

const expected = 180;
const received = [];
let invalid = 0;
let firstInvalid;
const decoder = startAnnexBDecoder({
  width: DEFAULT_MEDIA.width,
  height: DEFAULT_MEDIA.height,
  onFrame: (frame) => received.push({
    frameId: frame.frameId,
    latencyMs: Number(frame.presentedUs - frame.captureUs) / 1000,
  }),
  onInvalidFrame: (raw) => {
    invalid += 1;
    firstInvalid ??= Buffer.from(raw);
  },
});
const encoder = startAnnexBEncoder();
const parser = new AnnexBAccessUnitParser((accessUnit) => decoder.input.write(accessUnit));
encoder.output.on("data", (chunk) => parser.push(chunk));
encoder.output.on("end", () => {
  parser.flush();
  decoder.input.end();
});

await runTimestampedSource(encoder.input, { frames: expected });
encoder.input.end();
await once(encoder.process, "exit");
await once(decoder.process, "exit");

// FFmpeg's no-buffer mode intentionally begins at the second IDR rather than
// retaining a startup GOP. Production trials have a separate warmup period.
if (received.length < expected - DEFAULT_MEDIA.keyframeInterval - 2 || invalid) {
  throw new Error(`codec marker test failed: received=${received.length}/${expected}, invalid=${invalid}, diagnostics=${JSON.stringify(
    firstInvalid ? diagnoseMarker(firstInvalid, DEFAULT_MEDIA.width, DEFAULT_MEDIA.height) : null,
  )}`);
}
const latencies = received.map((sample) => sample.latencyMs).sort((a, b) => a - b);
process.stdout.write(`${JSON.stringify({
  expected,
  received: received.length,
  invalid,
  p50Ms: percentile(latencies, 0.5),
  p99Ms: percentile(latencies, 0.99),
  maxMs: latencies.at(-1),
}, null, 2)}\n`);

function percentile(values, quantile) {
  return values[Math.min(values.length - 1, Math.floor(values.length * quantile))];
}
