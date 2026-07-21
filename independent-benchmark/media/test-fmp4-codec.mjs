import { once } from "node:events";
import { Transform } from "node:stream";
import {
  DEFAULT_MEDIA,
  runTimestampedSource,
  startFragmentedMp4Decoder,
  startFragmentedMp4Encoder,
} from "./codec.mjs";

const warmup = 30;
const expected = 180;
const cooldown = 30;
async function runCase(name, intermediary) {
  const received = [];
  let invalid = 0;
  const decoder = startFragmentedMp4Decoder({
    width: DEFAULT_MEDIA.width,
    height: DEFAULT_MEDIA.height,
    onFrame: (frame) => {
      if (frame.frameId < warmup || frame.frameId >= warmup + expected) return;
      received.push({
        frameId: frame.frameId,
        latencyMs: Number(frame.presentedUs - frame.captureUs) / 1000,
      });
    },
    onInvalidFrame: () => { invalid += 1; },
  });
  const encoder = startFragmentedMp4Encoder();
  if (intermediary) encoder.output.pipe(intermediary).pipe(decoder.input);
  else encoder.output.pipe(decoder.input);

  await runTimestampedSource(encoder.input, { frames: warmup + expected + cooldown });
  encoder.input.end();
  await once(encoder.process, "exit");
  await once(decoder.process, "exit");

  if (received.length !== expected || invalid) {
    throw new Error(`${name} marker test failed: received=${received.length}/${expected}, invalid=${invalid}`);
  }
  const latencies = received.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  return {
    expected,
    received: received.length,
    invalid,
    p50Ms: percentile(latencies, 0.5),
    p99Ms: percentile(latencies, 0.99),
    maxMs: latencies.at(-1),
  };
}

class WholeMp4AtomTransform extends Transform {
  constructor() {
    super();
    this.pending = Buffer.alloc(0);
  }

  _transform(chunk, _encoding, callback) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    while (this.pending.length >= 8) {
      const size32 = this.pending.readUInt32BE(0);
      let size;
      if (size32 === 1) {
        if (this.pending.length < 16) break;
        size = Number(this.pending.readBigUInt64BE(8));
      } else if (size32 === 0) {
        callback(new Error("EOF-sized MP4 atoms are unsupported in this test"));
        return;
      } else {
        size = size32;
      }
      if (size < 8) {
        callback(new Error(`invalid MP4 atom size ${size}`));
        return;
      }
      if (this.pending.length < size) break;
      this.push(this.pending.subarray(0, size));
      this.pending = this.pending.subarray(size);
    }
    callback();
  }

  _flush(callback) {
    if (this.pending.length) callback(new Error(`trailing partial MP4 atom: ${this.pending.length} bytes`));
    else callback();
  }
}

const direct = await runCase("direct-streaming-atoms");
const wholeAtomBuffered = await runCase("whole-atom-buffered", new WholeMp4AtomTransform());
process.stdout.write(`${JSON.stringify({ direct, wholeAtomBuffered }, null, 2)}\n`);

function percentile(values, quantile) {
  return values[Math.min(values.length - 1, Math.floor(values.length * quantile))];
}
