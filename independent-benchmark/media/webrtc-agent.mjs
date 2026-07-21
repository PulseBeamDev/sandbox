import fs from "node:fs/promises";
import path from "node:path";
import nodeDataChannel from "node-datachannel";
import { assertClock, clockDiagnostics } from "./clock.mjs";
import { createCoordination } from "./coordination.mjs";
import { epochMicros } from "./marker.mjs";
import {
  AnnexBAccessUnitParser,
  codecBuildInfo,
  DEFAULT_MEDIA,
  H264RtpDepacketizer,
  runTimestampedSource,
  startAnnexBDecoder,
  startAnnexBEncoder,
} from "./codec.mjs";

const env = process.env;
const config = {
  role: env.MEDIA_ROLE,
  provider: env.MEDIA_PROVIDER,
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
  cloudflarePrerollMs: nonNegativeInt(env.MEDIA_CLOUDFLARE_PREROLL_MS ?? "1000", "MEDIA_CLOUDFLARE_PREROLL_MS"),
  cloudflareSubscribeAttempts: positiveInt(
    env.MEDIA_CLOUDFLARE_SUBSCRIBE_ATTEMPTS ?? "5",
    "MEDIA_CLOUDFLARE_SUBSCRIBE_ATTEMPTS",
  ),
  cloudflareSubscribeRetryMs: positiveInt(
    env.MEDIA_CLOUDFLARE_SUBSCRIBE_RETRY_MS ?? "1000",
    "MEDIA_CLOUDFLARE_SUBSCRIBE_RETRY_MS",
  ),
  debugSignal: env.MEDIA_DEBUG_SIGNAL === "1",
  pulsebeamEndpoint: env.PULSEBEAM_ENDPOINT,
  callsAppId: env.CALLS_APP_ID,
  callsAppSecret: env.CALLS_APP_SECRET,
};

if (!["publisher", "subscriber"].includes(config.role)) {
  throw new Error("MEDIA_ROLE must be publisher or subscriber");
}
if (!["cloudflare", "pulsebeam"].includes(config.provider)) {
  throw new Error("MEDIA_PROVIDER must be cloudflare or pulsebeam");
}
if (config.provider === "pulsebeam" && !config.pulsebeamEndpoint) {
  throw new Error("PULSEBEAM_ENDPOINT is required for PulseBeam media trials");
}
if (config.provider === "cloudflare" && (!config.callsAppId || !config.callsAppSecret)) {
  throw new Error("CALLS_APP_ID and CALLS_APP_SECRET are required for Cloudflare media trials");
}

await fs.mkdir(config.outputDir, { recursive: true });
nodeDataChannel.initLogger("Warning", (level, message) => {
  if (["Error", "Fatal"].includes(level)) process.stderr.write(`[webrtc:${level}] ${message}\n`);
});

const coordination = await createCoordination({
  role: config.role,
  port: config.coordinatorPort,
  url: config.coordinatorUrl,
  token: config.token,
});
let connection;
let encoder;
let decoder;

try {
  const clock = await clockDiagnostics();
  if (config.requireSync) assertClock(clock, config.maxClockOffsetMs);
  if (config.role === "publisher") {
    connection = config.provider === "pulsebeam"
      ? await createPulseBeamPublisher()
      : await createCloudflarePublisher();
    await coordination.exchange(connection.exchangeInfo);

    encoder = startAnnexBEncoder(config);
    const parser = new AnnexBAccessUnitParser((accessUnit) => connection.sendFrame(accessUnit));
    encoder.output.on("data", (chunk) => parser.push(chunk));
    encoder.output.on("end", () => parser.flush());
    let preroll;
    if (config.provider === "cloudflare") {
      // Cloudflare rejects remote subscriptions until it has observed media on
      // the published track. Keep an unmeasured stream alive while the
      // subscriber negotiates, then begin IDs 0..N only after both sides are ready.
      const abort = new AbortController();
      const promise = runTimestampedSource(encoder.input, {
        ...config,
        startFrameId: 0xf0000000,
        signal: abort.signal,
      });
      await coordination.ready();
      abort.abort();
      preroll = await promise;
      // Let the encoder/parser drain the final preroll access unit before the
      // measured elementary-stream byte counter starts.
      await sleep(100);
    } else {
      await coordination.ready();
    }
    const warmup = await runTimestampedSource(encoder.input, {
      ...config,
      frames: config.warmupFrames,
      startFrameId: 0,
    });
    await sleep(100);
    const measuredEncodedStartBytes = connection.sentBytes;
    const measuredEncodedStartFrames = connection.sentFrames;
    const measured = await runTimestampedSource(encoder.input, {
      ...config,
      frames: config.samples,
      startFrameId: config.warmupFrames,
    });
    await sleep(100);
    const measuredEncodedBytes = connection.sentBytes - measuredEncodedStartBytes;
    const measuredEncodedFrames = connection.sentFrames - measuredEncodedStartFrames;
    const cooldown = await runTimestampedSource(encoder.input, {
      ...config,
      frames: config.cooldownFrames,
      startFrameId: config.warmupFrames + config.samples,
    });
    encoder.input.end();
    await waitForExit(encoder.process, 10_000);
    const measuredDurationSeconds = config.samples / config.fps;
    const source = summarizeSourcePhases(warmup, measured, cooldown);

    const summary = baseSummary({
      mode: "publisher",
      clock,
      source: preroll ? {
        prerollSent: preroll.sent,
        prerollSkipped: preroll.skipped,
        ...source,
      } : source,
      transport: peerStats(connection.pc),
      encodedFrames: connection.sentFrames,
      encodedBytes: connection.sentBytes,
      measuredElementaryStream: {
        frames: measuredEncodedFrames,
        bytes: measuredEncodedBytes,
        bitrateBps: measuredEncodedBytes * 8 / measuredDurationSeconds,
      },
      sendFailures: connection.sendFailures,
    });
    await writeSummary(summary);
  } else {
    const remote = await coordination.exchange({ provider: config.provider, role: config.role });
    const state = createReceiverState(epochMicros());
    const onAccessUnit = (accessUnit) => decoder.input.write(accessUnit);
    if (config.provider === "cloudflare") await sleep(config.cloudflarePrerollMs);
    connection = config.provider === "pulsebeam"
      ? await createPulseBeamSubscriber(onAccessUnit)
      : await createCloudflareSubscriberWithRetry(remote, onAccessUnit);
    decoder = startAnnexBDecoder({
      width: config.width,
      height: config.height,
      onFrame: (frame) => receiveFrame(state, frame),
      onInvalidFrame: () => receiveInvalidFrame(state),
    });
    // The depacketizer is connected before ready; decoder is now available.
    connection.setFrameSink(onAccessUnit);
    await coordination.ready();

    const runtimeMs = ((config.warmupFrames + config.samples + config.cooldownFrames) / config.fps) * 1000
      + config.graceMs;
    await sleep(runtimeMs);
    decoder.input.end();
    await waitForExit(decoder.process, 10_000);

    const summary = baseSummary({
      mode: "subscriber",
      clock,
      ...summarizeReceiver(state),
      depacketizer: connection.depacketizer.stats,
      ...(config.provider === "cloudflare" ? {
        cloudflareSubscription: connection.cloudflareSubscription,
      } : {}),
      transport: peerStats(connection.pc),
    });
    await writeRaw(state.samples);
    await writeSummary(summary);
  }
} finally {
  try { encoder?.process.kill("SIGTERM"); } catch {}
  try { decoder?.process.kill("SIGTERM"); } catch {}
  try { connection?.close(); } catch {}
  coordination.close();
  await sleep(250);
  nodeDataChannel.cleanup();
}

async function createPulseBeamPublisher() {
  const pc = createPeerConnection("pulsebeam-media-publisher", []);
  const { track, sendFrame, counters } = addH264Sender(pc);
  const offer = await createLocalDescription(pc, "offer");
  const response = await fetchWithTimeout(config.pulsebeamEndpoint, {
    method: "POST", headers: { "Content-Type": "application/sdp" }, body: offer.sdp,
  }, 20_000);
  if (!response.ok) throw new Error(`PulseBeam publisher failed: HTTP ${response.status} ${await response.text()}`);
  pc.setRemoteDescription(await response.text(), "answer");
  await Promise.all([waitForPeerState(pc, "connected", 30_000), waitForTrackOpen(track, 30_000)]);
  return senderConnection(pc, track, sendFrame, counters, { provider: "pulsebeam", role: "publisher" });
}

async function createPulseBeamSubscriber() {
  const pc = createPeerConnection("pulsebeam-media-subscriber", []);
  const video = new nodeDataChannel.Video("video", "RecvOnly");
  video.addH264Codec(102);
  const track = pc.addTrack(video);
  const holder = receiverConnection(pc, track);
  const offer = await createLocalDescription(pc, "offer");
  const response = await fetchWithTimeout(config.pulsebeamEndpoint, {
    method: "POST", headers: { "Content-Type": "application/sdp" }, body: offer.sdp,
  }, 20_000);
  if (!response.ok) throw new Error(`PulseBeam subscriber failed: HTTP ${response.status} ${await response.text()}`);
  pc.setRemoteDescription(await response.text(), "answer");
  await Promise.all([waitForPeerState(pc, "connected", 30_000), waitForTrackOpen(track, 30_000)]);
  return holder;
}

async function createCloudflarePublisher() {
  const created = await cloudflareApi("/sessions/new", { method: "POST" });
  const pc = createPeerConnection("cloudflare-media-publisher", ["stun:stun.cloudflare.com:3478"]);
  const { track, sendFrame, counters } = addH264Sender(pc);
  const offer = await createLocalDescription(pc, "offer");
  const published = await cloudflareApi(`/sessions/${created.sessionId}/tracks/new`, {
    method: "POST",
    body: {
      sessionDescription: { type: "offer", sdp: offer.sdp },
      tracks: [{ location: "local", mid: track.mid(), trackName: "g2g-video" }],
    },
  });
  debugSignal("cloudflare publisher negotiation", {
    requestedMid: track.mid(),
    returnedTracks: published.tracks,
    offerVideo: sdpMediaSection(offer.sdp, "video"),
    answerVideo: sdpMediaSection(published.sessionDescription.sdp, "video"),
  });
  pc.setRemoteDescription(published.sessionDescription.sdp, "answer");
  await Promise.all([waitForPeerState(pc, "connected", 30_000), waitForTrackOpen(track, 30_000)]);
  return senderConnection(pc, track, sendFrame, counters, {
    provider: "cloudflare",
    role: "publisher",
    sessionId: created.sessionId,
    trackName: published.tracks?.[0]?.trackName ?? "g2g-video",
  });
}

async function createCloudflareSubscriber(remote) {
  if (!remote.sessionId || !remote.trackName) throw new Error("Cloudflare publisher did not exchange track identity");
  const created = await cloudflareApi("/sessions/new", { method: "POST" });
  const pc = createPeerConnection("cloudflare-media-subscriber", ["stun:stun.cloudflare.com:3478"]);
  let resolveTrack;
  const trackPromise = new Promise((resolve) => { resolveTrack = resolve; });
  pc.onTrack((track) => resolveTrack(track));
  const subscribed = await cloudflareApi(`/sessions/${created.sessionId}/tracks/new`, {
    method: "POST",
    body: {
      tracks: [{ location: "remote", sessionId: remote.sessionId, trackName: remote.trackName }],
    },
  });
  const trackErrors = (subscribed.tracks ?? []).filter((track) => track.errorCode);
  if (trackErrors.length) {
    pc.close();
    const error = new Error(`Cloudflare remote track failed: ${JSON.stringify(trackErrors)}`);
    error.cloudflareTrackErrors = trackErrors.map(({ errorCode, errorDescription }) => ({
      errorCode,
      errorDescription,
    }));
    throw error;
  }
  if (!subscribed.sessionDescription?.sdp) {
    pc.close();
    throw new Error("Cloudflare remote track response did not contain an SDP offer");
  }
  debugSignal("cloudflare subscriber offer", {
    remote,
    returnedTracks: subscribed.tracks,
    offerVideo: sdpMediaSection(subscribed.sessionDescription.sdp, "video"),
  });
  const answerPromise = nextLocalDescription(pc, "answer", 20_000);
  pc.setRemoteDescription(subscribed.sessionDescription.sdp, "offer");
  const track = await Promise.race([
    trackPromise,
    sleep(20_000).then(() => { throw new Error("Cloudflare remote track timed out"); }),
  ]);
  const holder = receiverConnection(pc, track);
  pc.setLocalDescription("answer");
  const answer = await answerPromise;
  debugSignal("cloudflare subscriber answer", {
    trackMid: track.mid(),
    answerVideo: sdpMediaSection(answer.sdp, "video"),
  });
  await cloudflareApi(`/sessions/${created.sessionId}/renegotiate`, {
    method: "PUT", body: { sessionDescription: { type: "answer", sdp: answer.sdp } },
  });
  await Promise.all([waitForPeerState(pc, "connected", 30_000), waitForTrackOpen(track, 30_000)]);
  return holder;
}

async function createCloudflareSubscriberWithRetry(remote) {
  const failures = [];
  for (let attempt = 1; attempt <= config.cloudflareSubscribeAttempts; attempt += 1) {
    try {
      const connection = await createCloudflareSubscriber(remote);
      connection.cloudflareSubscription = { attempts: attempt, failures };
      return connection;
    } catch (error) {
      const retryable = error.cloudflareTrackErrors?.every(({ errorCode }) => [
        "not_found_track_error",
        "temporarily_unavailable_error",
      ].includes(errorCode));
      if (!retryable || attempt === config.cloudflareSubscribeAttempts) throw error;
      failures.push({
        attempt,
        errors: error.cloudflareTrackErrors,
      });
      await sleep(config.cloudflareSubscribeRetryMs * attempt);
    }
  }
  throw new Error("Cloudflare subscription retry loop exhausted unexpectedly");
}

function addH264Sender(pc) {
  const payloadType = 102;
  const ssrc = (Math.random() * 0xffff_ffff) >>> 0;
  const cname = `g2g-${config.runId}`;
  const video = new nodeDataChannel.Video("video", "SendOnly");
  video.addH264Codec(payloadType);
  video.addSSRC(ssrc, cname, "g2g-stream", "g2g-video");
  video.setBitrate(Math.ceil(config.bitrate / 1000));
  const track = pc.addTrack(video);
  const rtp = new nodeDataChannel.RtpPacketizationConfig(ssrc, cname, payloadType, 90_000);
  rtp.playoutDelayMin = 0;
  rtp.playoutDelayMax = 0;
  const packetizer = new nodeDataChannel.H264RtpPacketizer("StartSequence", rtp, 1200);
  packetizer.addToChain(new nodeDataChannel.RtcpSrReporter(rtp));
  packetizer.addToChain(new nodeDataChannel.RtcpNackResponder());
  track.setMediaHandler(packetizer);
  const counters = { sentFrames: 0, sentBytes: 0, sendFailures: 0 };
  let timestamp = (Math.random() * 0xffff_ffff) >>> 0;
  const step = Math.round(90_000 / config.fps);
  return {
    track,
    counters,
    sendFrame(accessUnit) {
      rtp.timestamp = timestamp;
      timestamp = (timestamp + step) >>> 0;
      if (track.sendMessageBinary(accessUnit)) {
        counters.sentFrames += 1;
        counters.sentBytes += accessUnit.length;
      } else counters.sendFailures += 1;
    },
  };
}

function senderConnection(pc, track, sendFrame, counters, exchangeInfo) {
  return {
    pc, track, exchangeInfo,
    sendFrame,
    get sentFrames() { return counters.sentFrames; },
    get sentBytes() { return counters.sentBytes; },
    get sendFailures() { return counters.sendFailures; },
    close() { try { track.close(); } finally { pc.close(); } },
  };
}

function receiverConnection(pc, track) {
  const depacketizer = new H264RtpDepacketizer((accessUnit) => sink?.(accessUnit));
  let sink;
  track.setMediaHandler(new nodeDataChannel.RtcpReceivingSession());
  track.onMessage((packet) => depacketizer.push(Buffer.from(packet)));
  return {
    pc, track, depacketizer,
    setFrameSink(value) { sink = value; },
    close() { try { track.close(); } finally { pc.close(); } },
  };
}

function createPeerConnection(name, iceServers) {
  return new nodeDataChannel.PeerConnection(name, {
    iceServers,
    disableAutoNegotiation: true,
    forceMediaTransport: true,
  });
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
  const received = state.seen.size;
  const latencies = state.samples.map((sample) => sample.latencyMs);
  const presentationGaps = state.samples.slice(1).map((sample, index) =>
    Number(BigInt(sample.presentedUs) - BigInt(state.samples[index].presentedUs)) / 1000);
  return {
    expected: config.samples,
    received,
    lost: config.samples - received,
    lossPercent: (config.samples - received) / config.samples * 100,
    duplicates: state.duplicates,
    outOfOrder: state.outOfOrder,
    invalidMarkers: state.invalidMarkers,
    totalInvalidMarkers: state.totalInvalidMarkers,
    decodedIncludingWarmup: state.allDecoded,
    joinLatencyMs: state.firstDecodedUs === null
      ? null
      : Number(state.firstDecodedUs - state.joinStartedUs) / 1000,
    latencyMs: numericSummary(latencies),
    presentationGapMs: numericSummary(presentationGaps),
    freezesOver100Ms: presentationGaps.filter((value) => value > 100).length,
    freezesOver250Ms: presentationGaps.filter((value) => value > 250).length,
  };
}

function baseSummary(details) {
  return {
    provider: config.provider,
    role: config.role,
    runId: config.runId,
    corridor: config.corridor,
    serviceHost: config.provider === "cloudflare"
      ? "rtc.live.cloudflare.com"
      : new URL(config.pulsebeamEndpoint).host,
    measurement: "capture-to-decoded-presentable-frame",
    software: {
      ...codecBuildInfo(),
      nodeDataChannel: nodeDataChannel.getLibraryVersion(),
    },
    media: {
      codec: "H264 baseline",
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
    },
    ...details,
  };
}

async function writeRaw(samples) {
  const file = path.join(config.outputDir, `${config.runId}-${config.provider}-${config.role}.jsonl`);
  await fs.writeFile(file, samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
}

async function writeSummary(summary) {
  const file = path.join(config.outputDir, `${config.runId}-${config.provider}-${config.role}.summary.json`);
  await fs.writeFile(file, JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function summarizeSourcePhases(warmup, measured, cooldown) {
  return {
    sent: warmup.sent + measured.sent + cooldown.sent,
    skipped: warmup.skipped + measured.skipped + cooldown.skipped,
    nextFrameId: cooldown.nextFrameId,
    phases: { warmup, measured, cooldown },
  };
}

async function cloudflareApi(pathname, { method, body } = {}) {
  const response = await fetchWithTimeout(`https://rtc.live.cloudflare.com/v1/apps/${config.callsAppId}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.callsAppSecret}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, 20_000);
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Cloudflare returned non-JSON (HTTP ${response.status})`); }
  if (!response.ok || parsed.errorCode || parsed.success === false) {
    throw new Error(`Cloudflare ${method} ${pathname} failed: HTTP ${response.status} ${parsed.errorDescription ?? text}`);
  }
  return parsed.result ?? parsed;
}

function debugSignal(label, value) {
  if (!config.debugSignal) return;
  process.stderr.write(`[signal] ${label}: ${JSON.stringify(value)}\n`);
}

function sdpMediaSection(sdp, kind) {
  const sections = sdp.split(/(?=^m=)/m);
  return sections.find((section) => section.startsWith(`m=${kind} `))?.trim() ?? null;
}

function createLocalDescription(pc, type) {
  const promise = nextLocalDescription(pc, type, 20_000);
  pc.setLocalDescription(type);
  return promise;
}

function nextLocalDescription(pc, expectedType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for local ${expectedType}`)), timeoutMs);
    pc.onLocalDescription((sdp, type) => {
      if (type !== expectedType) return;
      clearTimeout(timer);
      resolve({ sdp, type });
    });
  });
}

function waitForPeerState(pc, expected, timeoutMs) {
  if (pc.state() === expected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Peer connection timed out in ${pc.state()}`)), timeoutMs);
    pc.onStateChange((state) => {
      if (state === expected) {
        clearTimeout(timer);
        resolve();
      } else if (["failed", "closed"].includes(state)) {
        clearTimeout(timer);
        reject(new Error(`Peer connection entered ${state}`));
      }
    });
  });
}

function waitForTrackOpen(track, timeoutMs) {
  if (track.isOpen()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Media track open timed out")), timeoutMs);
    track.onOpen(() => { clearTimeout(timer); resolve(); });
    track.onError((error) => { clearTimeout(timer); reject(new Error(`Media track failed: ${error}`)); });
  });
}

function peerStats(pc) {
  const selected = pc.getSelectedCandidatePair();
  return {
    rttMs: pc.rtt(), bytesSent: pc.bytesSent(), bytesReceived: pc.bytesReceived(),
    selectedCandidatePair: selected ? {
      local: {
        address: selected.local.address,
        port: selected.local.port,
        type: selected.local.type,
        transport: selected.local.transportType,
        candidate: selected.local.candidate,
      },
      remote: {
        address: selected.remote.address,
        port: selected.remote.port,
        type: selected.remote.type,
        transport: selected.remote.transportType,
        candidate: selected.remote.candidate,
      },
    } : null,
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

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => { child.kill("SIGKILL"); throw new Error("child process exit timed out"); }),
  ]);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
