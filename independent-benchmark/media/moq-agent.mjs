import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertClock, clockDiagnostics } from "./clock.mjs";
import { createCoordination } from "./coordination.mjs";
import { epochMicros } from "./marker.mjs";
import {
  codecBuildInfo,
  DEFAULT_MEDIA,
  runTimestampedSource,
  startFragmentedMp4Decoder,
  startFragmentedMp4Encoder,
} from "./codec.mjs";

const env = process.env;
const config = {
  role: env.MEDIA_ROLE,
  provider: env.MEDIA_PROVIDER ?? "moq",
  implementation: env.MOQ_IMPLEMENTATION ?? "cloudflare/moq-rs draft-16 fMP4 subgroup streams",
  clientFlavor: env.MOQ_CLIENT_FLAVOR ?? "cloudflare-main",
  coordinatorPort: positiveInt(env.MEDIA_COORDINATOR_PORT ?? "8080", "MEDIA_COORDINATOR_PORT"),
  coordinatorUrl: env.MEDIA_COORDINATOR_URL,
  token: env.MEDIA_TOKEN,
  runId: env.MEDIA_RUN_ID ?? new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
  corridor: env.MEDIA_CORRIDOR ?? "unspecified",
  outputDir: path.resolve(env.MEDIA_OUTPUT_DIR ?? "results-media"),
  width: positiveInt(env.MEDIA_WIDTH ?? String(DEFAULT_MEDIA.width), "MEDIA_WIDTH"),
  height: positiveInt(env.MEDIA_HEIGHT ?? String(DEFAULT_MEDIA.height), "MEDIA_HEIGHT"),
  fps: positiveInt(env.MEDIA_FPS ?? String(DEFAULT_MEDIA.fps), "MEDIA_FPS"),
  bitrate: positiveInt(env.MEDIA_BITRATE ?? String(DEFAULT_MEDIA.bitrate), "MEDIA_BITRATE"),
  keyframeInterval: positiveInt(env.MEDIA_GOP ?? String(DEFAULT_MEDIA.keyframeInterval), "MEDIA_GOP"),
  sourceProfile: env.MEDIA_SOURCE_PROFILE ?? "checkerboard",
  strictCbr: env.MEDIA_STRICT_CBR === "1",
  warmupFrames: nonNegativeInt(env.MEDIA_WARMUP_FRAMES ?? "150", "MEDIA_WARMUP_FRAMES"),
  samples: positiveInt(env.MEDIA_SAMPLES ?? "900", "MEDIA_SAMPLES"),
  cooldownFrames: nonNegativeInt(env.MEDIA_COOLDOWN_FRAMES ?? "60", "MEDIA_COOLDOWN_FRAMES"),
  graceMs: nonNegativeInt(env.MEDIA_GRACE_MS ?? "5000", "MEDIA_GRACE_MS"),
  requireSync: env.MEDIA_REQUIRE_SYNC === "1",
  maxClockOffsetMs: positiveNumber(env.MEDIA_CLOCK_MAX_OFFSET_MS ?? "1", "MEDIA_CLOCK_MAX_OFFSET_MS"),
  relayUrl: env.MOQ_RELAY_URL,
  broadcast: env.MOQ_BROADCAST ?? `g2g-${env.MEDIA_RUN_ID ?? "media"}`,
  tlsHostName: env.MOQ_TLS_HOST_NAME,
  ignoreRemoteRelayUrl: env.MOQ_IGNORE_REMOTE_RELAY_URL === "1",
  tlsDisableVerify: env.MOQ_TLS_DISABLE_VERIFY === "1",
  tlsRoot: env.MOQ_TLS_ROOT,
  rustLog: env.MOQ_RUST_LOG ?? "off",
  fmp4LowLatency: env.MEDIA_FMP4_LOW_LATENCY === "1",
  moqDevLatencyMax: env.MOQ_DEV_LATENCY_MAX ?? "100ms",
  // moq.dev documents a zero fragment cap as per-frame fMP4 output. A one-frame
  // duration cap actually flushes the previous buffer only after the next frame
  // arrives, creating two-frame bursts at 30 fps.
  moqDevFragmentDuration: env.MOQ_DEV_FRAGMENT_DURATION ?? "0ms",
  pubBin: path.resolve(env.MOQ_PUB_BIN ?? ".tools/moq-media/bin/moq-pub"),
  subBin: path.resolve(env.MOQ_SUB_BIN ?? ".tools/moq-media/bin/moq-sub"),
};

if (!["publisher", "subscriber"].includes(config.role)) {
  throw new Error("MEDIA_ROLE must be publisher or subscriber");
}
if (!config.relayUrl) throw new Error("MOQ_RELAY_URL is required");
if (!["cloudflare-main", "cloudflare-draft14", "cloudflare-draft07", "moq-dev"].includes(config.clientFlavor)) {
  throw new Error("MOQ_CLIENT_FLAVOR must be cloudflare-main, cloudflare-draft14, cloudflare-draft07, or moq-dev");
}
await fs.access(config.role === "publisher" ? config.pubBin : config.subBin);
await fs.mkdir(config.outputDir, { recursive: true });

const coordination = await createCoordination({
  role: config.role,
  port: config.coordinatorPort,
  url: config.coordinatorUrl,
  token: config.token,
});
let encoder;
let decoder;
let moq;
let encodedBytes = 0;

try {
  const clock = await clockDiagnostics();
  if (config.requireSync) assertClock(clock, config.maxClockOffsetMs);
  if (config.role === "publisher") {
    encoder = startFragmentedMp4Encoder(config);
    moq = spawn(config.pubBin, moqPublisherArgs(), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RUST_LOG: config.rustLog },
    });
    const moqLogs = observeProcess(moq, publisherProcessLabel(), { retainStdout: true });
    ignoreBrokenPipe(moq.stdin);
    ignoreBrokenPipe(encoder.input);
    encoder.output.on("data", (chunk) => { encodedBytes += chunk.length; });
    encoder.output.pipe(moq.stdin);

    // Keep a high-ID pre-roll flowing so late subscribers can receive init data
    // and an IDR. These frames are outside the measured ID range.
    const prerollAbort = new AbortController();
    const prerollPromise = runTimestampedSource(encoder.input, {
      ...config,
      startFrameId: 0xf0000000,
      signal: prerollAbort.signal,
    });
    await sleep(1000);
    if (moq.exitCode !== null) {
      throw new Error(`${publisherProcessLabel()} exited during pre-roll: ${JSON.stringify(moqLogs.snapshot())}`);
    }
    await coordination.exchange({
      provider: config.provider, role: "publisher", relayUrl: config.relayUrl, broadcast: config.broadcast,
    });
    await Promise.race([
      coordination.ready(),
      rejectOnExit(moq, publisherProcessLabel(), moqLogs),
    ]);
    prerollAbort.abort();
    const preroll = await prerollPromise;
    await sleep(100);
    const warmup = await Promise.race([
      runTimestampedSource(encoder.input, {
        ...config,
        frames: config.warmupFrames,
        startFrameId: 0,
      }),
      rejectOnExit(moq, publisherProcessLabel(), moqLogs),
    ]);
    await sleep(100);
    const measuredEncodedStartBytes = encodedBytes;
    const measured = await Promise.race([
      runTimestampedSource(encoder.input, {
        ...config,
        frames: config.samples,
        startFrameId: config.warmupFrames,
      }),
      rejectOnExit(moq, publisherProcessLabel(), moqLogs),
    ]);
    await sleep(100);
    const measuredEncodedBytes = encodedBytes - measuredEncodedStartBytes;
    const cooldown = await Promise.race([
      runTimestampedSource(encoder.input, {
        ...config,
        frames: config.cooldownFrames,
        startFrameId: config.warmupFrames + config.samples,
      }),
      rejectOnExit(moq, publisherProcessLabel(), moqLogs),
    ]);
    encoder.input.end();
    await waitForExit(encoder.process, 10_000);
    const measuredDurationSeconds = config.samples / config.fps;
    const source = summarizeSourcePhases(warmup, measured, cooldown);
    await sleep(1000);
    moq.kill("SIGTERM");

    const summary = baseSummary({
      mode: "publisher",
      clock,
      source: {
        prerollSent: preroll.sent,
        prerollSkipped: preroll.skipped,
        ...source,
      },
      process: moqLogs.snapshot(),
      measuredElementaryStream: {
        frames: config.samples,
        bytes: measuredEncodedBytes,
        bitrateBps: measuredEncodedBytes * 8 / measuredDurationSeconds,
      },
    });
    await writeSummary(summary);
  } else {
    const remote = await coordination.exchange({ provider: config.provider, role: "subscriber" });
    // A hosted anycast/CDN name can resolve to a different ingress at each
    // endpoint. In that case, keep the subscriber's locally selected relay
    // URL instead of inheriting the publisher's IP through coordination.
    const relayUrl = config.ignoreRemoteRelayUrl
      ? config.relayUrl
      : (remote.relayUrl ?? config.relayUrl);
    const broadcast = remote.broadcast ?? config.broadcast;
    const state = createReceiverState(epochMicros());
    let resolveFirstFrame;
    const firstFrame = new Promise((resolve) => { resolveFirstFrame = resolve; });
    decoder = startFragmentedMp4Decoder({
      width: config.width,
      height: config.height,
      lowLatency: config.fmp4LowLatency,
      onFrame: (frame) => {
        receiveFrame(state, frame);
        resolveFirstFrame();
      },
      onInvalidFrame: () => receiveInvalidFrame(state),
    });
    moq = spawn(config.subBin, moqSubscriberArgs(relayUrl, broadcast), {
      stdio: ["ignore", "pipe", "pipe"],
      // moq-sub's stdout is the fMP4 byte stream. Any Rust tracing here
      // corrupts media, so subscriber logging must remain disabled.
      env: { ...process.env, RUST_LOG: "off" },
    });
    const moqLogs = observeProcess(moq, subscriberProcessLabel());
    moq.stdout.pipe(decoder.input);
    await Promise.race([
      firstFrame,
      sleep(30_000).then(() => {
        throw new Error(`MoQ first decoded frame timed out: ${JSON.stringify({
          moq: moqLogs.snapshot(),
          decoder: decoder.diagnostics.snapshot(),
        })}`);
      }),
    ]);
    await coordination.ready();

    const runtimeMs = ((config.warmupFrames + config.samples + config.cooldownFrames) / config.fps) * 1000
      + config.graceMs;
    const completion = await Promise.race([
      sleep(runtimeMs).then(() => "runtime"),
      waitForExit(moq, runtimeMs + 1000).then(() => "transport-exit"),
    ]);
    if (completion === "transport-exit" && state.seen.size < config.samples) {
      throw new Error(`MoQ subscriber transport exited before all measured frames arrived: ${JSON.stringify({
        received: state.seen.size,
        expected: config.samples,
        moq: moqLogs.snapshot(),
      })}`);
    }
    if (moq.exitCode === null) moq.kill("SIGTERM");
    await waitForExit(moq, 5000).catch(() => {});
    decoder.input.end();
    await waitForExit(decoder.process, 10_000);

    const summary = baseSummary({
      mode: "subscriber",
      clock,
      ...summarizeReceiver(state),
      process: moqLogs.snapshot(),
    });
    await writeRaw(state.samples);
    await writeSummary(summary);
  }
} finally {
  try { encoder?.process.kill("SIGTERM"); } catch {}
  try { decoder?.process.kill("SIGTERM"); } catch {}
  try { moq?.kill("SIGTERM"); } catch {}
  coordination.close();
}

function moqPublisherArgs() {
  const tls = config.tlsRoot ? ["--tls-root", config.tlsRoot] : [];
  if (config.clientFlavor === "moq-dev") {
    return [
      "--client-connect", config.relayUrl,
      "--broadcast", config.broadcast,
      ...(config.tlsHostName ? ["--client-tls-host-name", config.tlsHostName] : []),
      ...(config.tlsRoot ? ["--client-tls-root", config.tlsRoot] : []),
      ...(config.tlsDisableVerify ? ["--client-tls-disable-verify"] : []),
      "import", "fmp4",
    ];
  }
  return [
    config.relayUrl,
    "--name", config.broadcast,
    ...(config.clientFlavor === "cloudflare-main" ? ["--publish"] : []),
    "--fps", String(config.fps),
    "--bitrate", String(config.bitrate),
    ...tls,
    ...(config.tlsDisableVerify ? ["--tls-disable-verify"] : []),
  ];
}

function moqSubscriberArgs(relayUrl, broadcast) {
  if (config.clientFlavor === "moq-dev") {
    return [
      "--client-connect", relayUrl,
      "--broadcast", broadcast,
      ...(config.tlsHostName ? ["--client-tls-host-name", config.tlsHostName] : []),
      ...(config.tlsRoot ? ["--client-tls-root", config.tlsRoot] : []),
      ...(config.tlsDisableVerify ? ["--client-tls-disable-verify"] : []),
      "export", "--catalog-format", "hang", "fmp4",
      "--latency-max", config.moqDevLatencyMax,
      "--fragment-duration", config.moqDevFragmentDuration,
    ];
  }
  return [
    relayUrl,
    "--name", broadcast,
    ...(config.clientFlavor === "cloudflare-main" ? ["--catalog"] : []),
    ...(config.tlsRoot ? ["--tls-root", config.tlsRoot] : []),
    ...(config.tlsDisableVerify ? ["--tls-disable-verify"] : []),
  ];
}

function publisherProcessLabel() {
  return config.clientFlavor === "moq-dev" ? "moq import" : "moq-pub";
}

function subscriberProcessLabel() {
  return config.clientFlavor === "moq-dev" ? "moq export" : "moq-sub";
}

function createReceiverState(joinStartedUs) {
  return {
    samples: [], seen: new Set(), duplicates: 0, outOfOrder: 0,
    invalidMarkers: 0, totalInvalidMarkers: 0,
    highestFrameId: -1, highestDecodedFrameId: -1, allDecoded: 0,
    joinStartedUs, firstDecodedUs: null,
  };
}

function receiveFrame(state, frame) {
  state.allDecoded += 1;
  state.firstDecodedUs ??= frame.presentedUs;
  state.highestDecodedFrameId = Math.max(state.highestDecodedFrameId, frame.frameId);
  if (frame.frameId < config.warmupFrames || frame.frameId >= config.warmupFrames + config.samples) return;
  if (state.seen.has(frame.frameId)) {
    state.duplicates += 1;
    return;
  }
  if (frame.frameId < state.highestFrameId) state.outOfOrder += 1;
  state.highestFrameId = Math.max(state.highestFrameId, frame.frameId);
  state.seen.add(frame.frameId);
  state.samples.push({
    frameId: frame.frameId,
    captureUs: frame.captureUs.toString(),
    presentedUs: frame.presentedUs.toString(),
    latencyMs: Number(frame.presentedUs - frame.captureUs) / 1000,
  });
}

function receiveInvalidFrame(state) {
  state.totalInvalidMarkers += 1;
  const firstMeasured = config.warmupFrames;
  const lastMeasured = config.warmupFrames + config.samples - 1;
  if (state.highestDecodedFrameId >= firstMeasured - 1
      && state.highestDecodedFrameId < lastMeasured) {
    state.invalidMarkers += 1;
  }
}

function summarizeReceiver(state) {
  const latencies = state.samples.map((sample) => sample.latencyMs);
  const gaps = state.samples.slice(1).map((sample, index) =>
    Number(BigInt(sample.presentedUs) - BigInt(state.samples[index].presentedUs)) / 1000);
  return {
    expected: config.samples,
    received: state.seen.size,
    lost: config.samples - state.seen.size,
    lossPercent: (config.samples - state.seen.size) / config.samples * 100,
    duplicates: state.duplicates,
    outOfOrder: state.outOfOrder,
    invalidMarkers: state.invalidMarkers,
    totalInvalidMarkers: state.totalInvalidMarkers,
    decodedIncludingWarmup: state.allDecoded,
    joinLatencyMs: state.firstDecodedUs === null
      ? null
      : Number(state.firstDecodedUs - state.joinStartedUs) / 1000,
    latencyMs: numericSummary(latencies),
    presentationGapMs: numericSummary(gaps),
    freezesOver100Ms: gaps.filter((value) => value > 100).length,
    freezesOver250Ms: gaps.filter((value) => value > 250).length,
  };
}

function baseSummary(details) {
  return {
    provider: config.provider,
    implementation: config.implementation,
    role: config.role,
    runId: config.runId,
    corridor: config.corridor,
    serviceHost: config.tlsHostName ?? new URL(config.relayUrl).host,
    measurement: "capture-to-decoded-presentable-frame",
    software: codecBuildInfo(),
    media: {
      codec: "H264 baseline",
      container: "fragmented MP4, one fragment per frame",
      width: config.width,
      height: config.height,
      fps: config.fps,
      bitrate: config.bitrate,
      strictCbr: config.strictCbr,
      sourceProfile: config.sourceProfile,
      keyframeInterval: config.keyframeInterval,
      warmupFrames: config.warmupFrames,
      measuredFrames: config.samples,
      cooldownFrames: config.cooldownFrames,
      encoder: "ffmpeg/libx264 ultrafast zerolatency",
      decoder: "ffmpeg software H264 low_delay",
      fmp4LowLatency: config.fmp4LowLatency,
    },
    ...details,
  };
}

function observeProcess(child, label, { retainStdout = false } = {}) {
  let stderr = "";
  let stdoutTail = "";
  let stdoutBytes = 0;
  const watchers = [];
  child.stdout?.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (retainStdout) stdoutTail = (stdoutTail + chunk.toString()).slice(-4096);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr = (stderr + text).slice(-65_536);
    for (const watcher of watchers) {
      if (watcher.pattern.test(stderr)) watcher.resolve();
    }
  });
  child.on("exit", (code, signal) => {
    for (const watcher of watchers) {
      watcher.reject(new Error(`${label} exited ${code ?? signal}: ${stderr.slice(-4096)}`));
    }
  });
  return {
    waitFor(pattern, timeoutMs) {
      if (pattern.test(stderr)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} log wait timed out: ${stderr}`)), timeoutMs);
        watchers.push({ pattern, resolve: () => { clearTimeout(timer); resolve(); }, reject });
      });
    },
    snapshot: () => ({
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      stdoutBytes,
      ...(retainStdout ? { stdoutTail } : {}),
      stderrTail: stderr.slice(-4096),
    }),
  };
}

function rejectOnExit(child, label, diagnostics) {
  return new Promise((_, reject) => child.once("exit", (code, signal) => {
    reject(new Error(`${label} exited during media production (${code ?? signal}): ${JSON.stringify(diagnostics.snapshot())}`));
  }));
}

function ignoreBrokenPipe(stream) {
  stream.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
  });
}

async function writeRaw(samples) {
  const file = path.join(config.outputDir, `${config.runId}-${safeProviderName()}-${config.role}.jsonl`);
  await fs.writeFile(file, samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
}

async function writeSummary(summary) {
  const file = path.join(config.outputDir, `${config.runId}-${safeProviderName()}-${config.role}.summary.json`);
  await fs.writeFile(file, JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function safeProviderName() {
  return config.provider.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function summarizeSourcePhases(warmup, measured, cooldown) {
  return {
    sent: warmup.sent + measured.sent + cooldown.sent,
    skipped: warmup.skipped + measured.skipped + cooldown.skipped,
    nextFrameId: cooldown.nextFrameId,
    phases: { warmup, measured, cooldown },
  };
}

function numericSummary(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    min: percentile(sorted, 0),
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    p50: percentile(sorted, 50), p95: percentile(sorted, 95),
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

function positiveInt(value, name) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function nonNegativeInt(value, name) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return number;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child process exit timed out"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
