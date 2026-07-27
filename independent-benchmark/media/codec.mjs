import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createBaseFrame, epochMicros, readMarker, stampFrame } from "./marker.mjs";

export const DEFAULT_MEDIA = Object.freeze({
  width: 1280,
  height: 720,
  fps: 30,
  bitrate: 4_000_000,
  keyframeInterval: 30,
});

let cachedCodecBuildInfo;
export function codecBuildInfo() {
  if (cachedCodecBuildInfo) return cachedCodecBuildInfo;
  const result = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg -version failed: ${result.stderr}`);
  const lines = result.stdout.trim().split("\n");
  cachedCodecBuildInfo = Object.freeze({
    ffmpegVersion: lines[0] ?? null,
    ffmpegBuild: lines[1] ?? null,
    ffmpegConfiguration: lines.find((line) => line.startsWith("configuration:")) ?? null,
    node: process.version,
  });
  return cachedCodecBuildInfo;
}

export function startAnnexBEncoder(options = {}) {
  const media = { ...DEFAULT_MEDIA, ...options };
  const rateControl = encoderRateControl(media);
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "nobuffer", "-flags", "low_delay", "-avioflags", "direct",
    "-f", "rawvideo", "-pixel_format", "yuv420p",
    "-video_size", `${media.width}x${media.height}`,
    "-framerate", String(media.fps), "-i", "pipe:0",
    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-profile:v", "baseline", "-pix_fmt", "yuv420p",
    ...rateControl.args,
    "-g", String(media.keyframeInterval), "-keyint_min", String(media.keyframeInterval),
    "-bf", "0", "-x264-params", `${rateControl.x264}:aud=1:repeat-headers=1`,
    "-flush_packets", "1", "-f", "h264", "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const diagnostics = collectStderr(ffmpeg, "encoder");
  return { process: ffmpeg, input: ffmpeg.stdin, output: ffmpeg.stdout, media, diagnostics };
}

export function startFragmentedMp4Encoder(options = {}) {
  const media = { ...DEFAULT_MEDIA, ...options };
  const rateControl = encoderRateControl(media);
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "nobuffer", "-flags", "low_delay", "-avioflags", "direct",
    "-f", "rawvideo", "-pixel_format", "yuv420p",
    "-video_size", `${media.width}x${media.height}`,
    "-framerate", String(media.fps), "-i", "pipe:0",
    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-profile:v", "baseline", "-pix_fmt", "yuv420p",
    ...rateControl.args,
    "-g", String(media.keyframeInterval), "-keyint_min", String(media.keyframeInterval),
    "-bf", "0", "-x264-params", `${rateControl.x264}:repeat-headers=1`,
    "-f", "mp4", "-movflags", "empty_moov+frag_every_frame+separate_moof+omit_tfhd_offset+default_base_moof",
    "-flush_packets", "1", "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const diagnostics = collectStderr(ffmpeg, "fMP4 encoder");
  return { process: ffmpeg, input: ffmpeg.stdin, output: ffmpeg.stdout, media, diagnostics };
}

export function startAnnexBDecoder({ width, height, onFrame, onInvalidFrame } = {}) {
  const frameBytes = width * height * 3 / 2;
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning", "-fflags", "nobuffer", "-flags", "low_delay",
    "-avioflags", "direct", "-threads", "1",
    "-probesize", "32", "-analyzeduration", "0",
    "-f", "h264", "-i", "pipe:0", "-an", "-f", "rawvideo",
    "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-flush_packets", "1", "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const diagnostics = collectStderr(ffmpeg, "decoder");

  let pending = Buffer.alloc(0);
  ffmpeg.stdout.on("data", (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const raw = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      const marker = readMarker(raw, width, height);
      if (marker) onFrame?.({ ...marker, presentedUs: epochMicros() });
      else onInvalidFrame?.(raw);
    }
  });
  return { process: ffmpeg, input: ffmpeg.stdin, diagnostics };
}

export function startFragmentedMp4Decoder({
  width,
  height,
  onFrame,
  onInvalidFrame,
  lowLatency = false,
} = {}) {
  const frameBytes = width * height * 3 / 2;
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-flags", "low_delay",
    "-probesize", "1M", "-analyzeduration", "0",
    "-f", "mp4", "-i", "pipe:0", "-an", "-f", "rawvideo",
    "-pix_fmt", "yuv420p", "-fps_mode", "passthrough",
    ...(lowLatency ? ["-flush_packets", "1"] : []),
    "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const diagnostics = collectStderr(ffmpeg, "fMP4 decoder");

  let pending = Buffer.alloc(0);
  ffmpeg.stdout.on("data", (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const raw = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      const marker = readMarker(raw, width, height);
      if (marker) onFrame?.({ ...marker, presentedUs: epochMicros() });
      else onInvalidFrame?.(raw);
    }
  });
  return { process: ffmpeg, input: ffmpeg.stdin, diagnostics };
}

export async function runTimestampedSource(input, {
  width = DEFAULT_MEDIA.width,
  height = DEFAULT_MEDIA.height,
  fps = DEFAULT_MEDIA.fps,
  frames,
  startFrameId = 0,
  sourceProfile = "checkerboard",
  onCapture,
  signal,
} = {}) {
  const base = createBaseFrame(width, height, { sourceProfile });
  const intervalNs = BigInt(Math.round(1_000_000_000 / fps));
  let targetNs = process.hrtime.bigint();
  let frameId = startFrameId;
  let sent = 0;
  let skipped = 0;

  while (!signal?.aborted && (frames === undefined || sent < frames)) {
    const nowNs = process.hrtime.bigint();
    if (nowNs < targetNs) await sleepNs(targetNs - nowNs, signal);
    if (signal?.aborted) break;

    const scheduledNow = process.hrtime.bigint();
    if (scheduledNow - targetNs >= intervalNs) {
      const missed = Number((scheduledNow - targetNs) / intervalNs);
      frameId += missed;
      skipped += missed;
      targetNs += BigInt(missed) * intervalNs;
    }

    const captureUs = epochMicros();
    const frame = stampFrame(base, width, height, captureUs, frameId, { sourceProfile });
    onCapture?.({ captureUs, frameId });
    if (!input.write(frame)) await once(input, "drain");

    sent += 1;
    frameId += 1;
    targetNs += intervalNs;
  }
  return { sent, skipped, nextFrameId: frameId };
}

function encoderRateControl(media) {
  const strictCbr = Boolean(media.strictCbr);
  const bufferBits = Math.ceil(media.bitrate / media.fps);
  return {
    args: [
      "-b:v", String(media.bitrate),
      ...(strictCbr ? ["-minrate", String(media.bitrate)] : []),
      "-maxrate", String(media.bitrate),
      "-bufsize", String(bufferBits),
    ],
    x264: [
      "scenecut=0", "sync-lookahead=0", "rc-lookahead=0",
      ...(strictCbr ? ["force-cfr=1"] : []),
    ].join(":"),
  };
}

export class AnnexBAccessUnitParser {
  constructor(onAccessUnit) {
    this.onAccessUnit = onAccessUnit;
    this.pending = Buffer.alloc(0);
    this.current = [];
  }

  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const starts = findStartCodes(this.pending);
    if (starts.length < 2) return;

    for (let index = 0; index < starts.length - 1; index += 1) {
      const start = starts[index];
      const end = starts[index + 1];
      this.pushNal(this.pending.subarray(start.offset, end.offset), start.length);
    }
    this.pending = this.pending.subarray(starts.at(-1).offset);
  }

  flush() {
    const starts = findStartCodes(this.pending);
    if (starts.length === 1) this.pushNal(this.pending, starts[0].length);
    this.pending = Buffer.alloc(0);
    if (this.current.length) this.emit();
  }

  pushNal(nal, startLength) {
    if (nal.length <= startLength) return;
    const type = nal[startLength] & 0x1f;
    if (type === 9 && this.current.length) this.emit();
    this.current.push(Buffer.from(nal));
  }

  emit() {
    const accessUnit = Buffer.concat(this.current);
    this.current = [];
    this.onAccessUnit(accessUnit);
  }
}

export class H264RtpDepacketizer {
  constructor(onAccessUnit) {
    this.onAccessUnit = onAccessUnit;
    this.timestamp = null;
    this.parts = [];
    this.incomplete = false;
    this.lastSequence = null;
    this.stats = { packets: 0, bytes: 0, packetGaps: 0, frames: 0, droppedFrames: 0 };
  }

  push(packet) {
    const rtp = parseRtp(packet);
    if (!rtp) return;
    this.stats.packets += 1;
    this.stats.bytes += packet.length;

    if (this.timestamp !== null && rtp.timestamp !== this.timestamp) this.finishFrame();
    if (this.timestamp === null) this.timestamp = rtp.timestamp;

    if (this.lastSequence !== null && ((this.lastSequence + 1) & 0xffff) !== rtp.sequence) {
      this.stats.packetGaps += 1;
      this.incomplete = true;
    }
    this.lastSequence = rtp.sequence;

    const payload = rtp.payload;
    if (!payload.length) return;
    const nalType = payload[0] & 0x1f;
    if (nalType >= 1 && nalType <= 23) {
      this.parts.push(Buffer.from([0, 0, 0, 1]), payload);
    } else if (nalType === 24) {
      this.pushStapA(payload);
    } else if (nalType === 28) {
      this.pushFuA(payload);
    } else {
      this.incomplete = true;
    }

    if (rtp.marker) this.finishFrame();
  }

  pushStapA(payload) {
    let offset = 1;
    while (offset + 2 <= payload.length) {
      const length = payload.readUInt16BE(offset);
      offset += 2;
      if (!length || offset + length > payload.length) {
        this.incomplete = true;
        return;
      }
      this.parts.push(Buffer.from([0, 0, 0, 1]), payload.subarray(offset, offset + length));
      offset += length;
    }
  }

  pushFuA(payload) {
    if (payload.length < 2) {
      this.incomplete = true;
      return;
    }
    const start = Boolean(payload[1] & 0x80);
    const end = Boolean(payload[1] & 0x40);
    const reconstructed = (payload[0] & 0xe0) | (payload[1] & 0x1f);
    if (start) this.parts.push(Buffer.from([0, 0, 0, 1, reconstructed]), payload.subarray(2));
    else if (this.parts.length) this.parts.push(payload.subarray(2));
    else this.incomplete = true;
    if (end && !payload.length) this.incomplete = true;
  }

  finishFrame() {
    if (this.parts.length && !this.incomplete) {
      this.stats.frames += 1;
      this.onAccessUnit(Buffer.concat(this.parts));
    } else if (this.parts.length || this.incomplete) {
      this.stats.droppedFrames += 1;
    }
    this.timestamp = null;
    this.parts = [];
    this.incomplete = false;
  }
}

function parseRtp(packet) {
  if (!Buffer.isBuffer(packet)) packet = Buffer.from(packet);
  if (packet.length < 12 || (packet[0] >> 6) !== 2) return null;
  if (packet[1] >= 192 && packet[1] <= 223) return null; // RTCP packet types.
  const csrcCount = packet[0] & 0x0f;
  const extension = Boolean(packet[0] & 0x10);
  const padding = Boolean(packet[0] & 0x20);
  let offset = 12 + csrcCount * 4;
  if (offset > packet.length) return null;
  if (extension) {
    if (offset + 4 > packet.length) return null;
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  if (offset > packet.length) return null;
  const paddingBytes = padding ? packet.at(-1) : 0;
  const end = packet.length - paddingBytes;
  if (end < offset) return null;
  return {
    marker: Boolean(packet[1] & 0x80),
    payloadType: packet[1] & 0x7f,
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    payload: packet.subarray(offset, end),
  };
}

function findStartCodes(buffer) {
  const starts = [];
  for (let index = 0; index + 3 <= buffer.length;) {
    if (buffer[index] === 0 && buffer[index + 1] === 0 && buffer[index + 2] === 1) {
      starts.push({ offset: index, length: 3 });
      index += 3;
    } else if (index + 4 <= buffer.length && buffer[index] === 0 && buffer[index + 1] === 0
      && buffer[index + 2] === 0 && buffer[index + 3] === 1) {
      starts.push({ offset: index, length: 4 });
      index += 4;
    } else {
      index += 1;
    }
  }
  return starts;
}

function collectStderr(child, label) {
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_384); });
  child.on("exit", (code, signal) => {
    if (code && !child.killed) process.stderr.write(`${label} exited ${code}${signal ? ` (${signal})` : ""}: ${stderr}\n`);
  });
  return { snapshot: () => stderr };
}

async function sleepNs(durationNs, signal) {
  const deadline = process.hrtime.bigint() + durationNs;
  const milliseconds = Number(durationNs / 1_000_000n);
  if (milliseconds > 1) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds - 1);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  while (!signal?.aborted && process.hrtime.bigint() < deadline) {
    // Only used for the final sub-millisecond edge to reduce frame scheduler jitter.
  }
}
