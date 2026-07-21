import fs from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import nodeDataChannel from "node-datachannel";

const {
  BENCH_PROVIDER = "both",
  BENCH_SAMPLES = "1000",
  BENCH_WARMUP = "100",
  BENCH_RATE_HZ,
  BENCH_INTERVAL_MS = "50",
  BENCH_PAYLOAD_BYTES = "16",
  BENCH_TRIALS = "1",
  BENCH_LATE_GRACE_MS = "3000",
  BENCH_KEEPALIVE_HZ,
  BENCH_KEEPALIVE_MODE = "forwarded",
  CALLS_APP_ID,
  CALLS_APP_SECRET,
  PULSEBEAM_ENDPOINT = "https://demo.pulsebeam.dev/api/v1/rooms/demo/participants",
} = process.env;

const config = {
  provider: BENCH_PROVIDER,
  samples: parsePositiveInteger(BENCH_SAMPLES, "BENCH_SAMPLES"),
  warmup: parseNonNegativeInteger(BENCH_WARMUP, "BENCH_WARMUP"),
  rateHz: BENCH_RATE_HZ === undefined ? null : parsePositiveNumber(BENCH_RATE_HZ, "BENCH_RATE_HZ"),
  intervalMs: BENCH_RATE_HZ === undefined
    ? parsePositiveNumber(BENCH_INTERVAL_MS, "BENCH_INTERVAL_MS")
    : 1000 / parsePositiveNumber(BENCH_RATE_HZ, "BENCH_RATE_HZ"),
  payloadBytes: parsePositiveInteger(BENCH_PAYLOAD_BYTES, "BENCH_PAYLOAD_BYTES"),
  trials: parsePositiveInteger(BENCH_TRIALS, "BENCH_TRIALS"),
  lateGraceMs: parseNonNegativeInteger(BENCH_LATE_GRACE_MS, "BENCH_LATE_GRACE_MS"),
  keepaliveHz: BENCH_KEEPALIVE_HZ === undefined
    ? null
    : parsePositiveNumber(BENCH_KEEPALIVE_HZ, "BENCH_KEEPALIVE_HZ"),
  keepaliveMode: BENCH_KEEPALIVE_HZ === undefined ? "none" : BENCH_KEEPALIVE_MODE,
};

if (!["both", "cloudflare", "pulsebeam"].includes(config.provider)) {
  throw new Error("BENCH_PROVIDER must be both, cloudflare, or pulsebeam");
}

if (!["none", "publisher", "forwarded"].includes(config.keepaliveMode)) {
  throw new Error("BENCH_KEEPALIVE_MODE must be none, publisher, or forwarded");
}

if (config.keepaliveHz !== null && config.provider !== "cloudflare") {
  throw new Error("Keepalive experiments currently require BENCH_PROVIDER=cloudflare");
}

if (config.payloadBytes < 16) {
  throw new Error("BENCH_PAYLOAD_BYTES must be at least 16 bytes for the sequence and timestamp header");
}

if ((config.provider === "both" || config.provider === "cloudflare") && (!CALLS_APP_ID || !CALLS_APP_SECRET)) {
  throw new Error("CALLS_APP_ID and CALLS_APP_SECRET are required for Cloudflare trials");
}

const resultsDir = path.resolve("results");
await fs.mkdir(resultsDir, { recursive: true });

nodeDataChannel.initLogger("Warning", (level, message) => {
  if (level === "Error" || level === "Fatal") {
    process.stderr.write(`[webrtc:${level}] ${message}\n`);
  }
});

const providers = config.provider === "both"
  ? ["cloudflare", "pulsebeam"]
  : [config.provider];
const trialPlan = buildAlternatingPlan(providers, config.trials);
const runId = `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${process.pid}`;
const summaries = [];

process.stdout.write(
  `Starting ${trialPlan.length} trial(s): ${config.samples} measured + ${config.warmup} warmup messages, ` +
  `${config.rateHz ?? (1000 / config.intervalMs)} Hz (${config.intervalMs.toFixed(6)} ms interval), ` +
  `${config.payloadBytes} byte payload (${formatMegabitsPerSecond(config.payloadBytes, config.intervalMs)} Mbit/s), ` +
  `keepalive=${config.keepaliveMode}${config.keepaliveHz === null ? "" : `@${config.keepaliveHz}Hz`}\n`,
);

try {
  for (let index = 0; index < trialPlan.length; index += 1) {
    const provider = trialPlan[index];
    const trialNumber = Math.floor(index / providers.length) + 1;
    process.stdout.write(`Trial ${index + 1}/${trialPlan.length}: ${provider}\n`);

    const startedAt = performance.now();
    const connection = provider === "cloudflare"
      ? await connectCloudflare()
      : await connectPulseBeam();
    const connectMs = performance.now() - startedAt;

    try {
      const raw = await measure(connection, config);
      const summary = summarize({
        provider,
        trialNumber,
        connectMs,
        raw,
        publisherPc: connection.publisherPc,
        subscriberPc: connection.subscriberPc,
      });
      summaries.push(summary);

      const trialStem = `${runId}-${String(index + 1).padStart(2, "0")}-${provider}`;
      await fs.writeFile(
        path.join(resultsDir, `${trialStem}.jsonl`),
        raw.received.map((sample) => JSON.stringify({ provider, trialNumber, ...sample })).join("\n") + "\n",
      );
      await fs.writeFile(
        path.join(resultsDir, `${trialStem}.summary.json`),
        JSON.stringify(summary, null, 2) + "\n",
      );
      printSummary(summary);
    } finally {
      closeConnection(connection);
      await sleep(500);
    }
  }

  const reportPath = path.join(resultsDir, `${runId}-report.json`);
  await fs.writeFile(reportPath, JSON.stringify({ runId, config, trialPlan, summaries }, null, 2) + "\n");
  process.stdout.write(`Report: ${reportPath}\n`);
} finally {
  nodeDataChannel.cleanup();
}

function buildAlternatingPlan(providerList, trials) {
  const plan = [];
  for (let trial = 0; trial < trials; trial += 1) {
    const order = trial % 2 === 0 ? providerList : [...providerList].reverse();
    plan.push(...order);
  }
  return plan;
}

async function connectPulseBeam() {
  const publisher = await createPulseBeamPeer("publisher", "v1/rt/pub/ping");
  const subscriber = await createPulseBeamPeer("subscriber", "v1/rt/sub/ping");
  return {
    publisherPc: publisher.pc,
    publisherChannel: publisher.channel,
    subscriberPc: subscriber.pc,
    subscriberChannel: subscriber.channel,
    auxChannels: [],
  };
}

async function createPulseBeamPeer(role, label) {
  const pc = new nodeDataChannel.PeerConnection(`pulsebeam-${role}`, {
    iceServers: [],
    disableAutoNegotiation: true,
  });
  const offerPromise = nextLocalDescription(pc, "offer", 15000);
  const channel = pc.createDataChannel(label, {
    unordered: true,
    maxRetransmits: 0,
  });
  pc.setLocalDescription("offer");
  const offer = await offerPromise;

  const response = await fetchWithTimeout(PULSEBEAM_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: offer.sdp,
  }, 15000);
  if (!response.ok) {
    throw new Error(`PulseBeam ${role} signaling failed: HTTP ${response.status} ${await response.text()}`);
  }

  pc.setRemoteDescription(await response.text(), "answer");
  await Promise.all([
    waitForPeerState(pc, "connected", 20000),
    waitForChannelOpen(channel, 20000),
  ]);
  return { pc, channel };
}

async function connectCloudflare() {
  const publisher = await createCloudflareSession("publisher");
  const publisherChannelInfo = await cloudflareApi(
    `/sessions/${publisher.sessionId}/datachannels/new`,
    {
      method: "POST",
      body: {
        dataChannels: [{ location: "local", dataChannelName: "channel-one" }],
      },
    },
  );
  const publisherChannel = publisher.pc.createDataChannel("channel-one", {
    negotiated: true,
    id: publisherChannelInfo.dataChannels[0].id,
    unordered: true,
    maxRetransmits: 0,
  });
  await waitForChannelOpen(publisherChannel, 15000);

  const subscriber = await createCloudflareSession("subscriber");
  const subscriberChannelInfo = await cloudflareApi(
    `/sessions/${subscriber.sessionId}/datachannels/new`,
    {
      method: "POST",
      body: {
        dataChannels: [{
          location: "remote",
          sessionId: publisher.sessionId,
          dataChannelName: "channel-one",
          waitForAck: false,
        }],
      },
    },
  );
  const subscriberChannel = subscriber.pc.createDataChannel("channel-one-subscribed", {
    negotiated: true,
    id: subscriberChannelInfo.dataChannels[0].id,
    unordered: true,
    maxRetransmits: 0,
  });
  await waitForChannelOpen(subscriberChannel, 15000);

  let keepalivePublisherChannel = null;
  let keepaliveSubscriberChannel = null;
  if (config.keepaliveHz !== null) {
    const keepalivePublisherInfo = await cloudflareApi(
      `/sessions/${publisher.sessionId}/datachannels/new`,
      {
        method: "POST",
        body: {
          dataChannels: [{ location: "local", dataChannelName: "channel-keepalive" }],
        },
      },
    );
    keepalivePublisherChannel = publisher.pc.createDataChannel("channel-keepalive", {
      negotiated: true,
      id: keepalivePublisherInfo.dataChannels[0].id,
      unordered: true,
      maxRetransmits: 0,
    });
    await waitForChannelOpen(keepalivePublisherChannel, 15000);

    if (config.keepaliveMode === "forwarded") {
      const keepaliveSubscriberInfo = await cloudflareApi(
        `/sessions/${subscriber.sessionId}/datachannels/new`,
        {
          method: "POST",
          body: {
            dataChannels: [{
              location: "remote",
              sessionId: publisher.sessionId,
              dataChannelName: "channel-keepalive",
              waitForAck: false,
            }],
          },
        },
      );
      keepaliveSubscriberChannel = subscriber.pc.createDataChannel("channel-keepalive-subscribed", {
        negotiated: true,
        id: keepaliveSubscriberInfo.dataChannels[0].id,
        unordered: true,
        maxRetransmits: 0,
      });
      await waitForChannelOpen(keepaliveSubscriberChannel, 15000);
    }
  }

  return {
    publisherPc: publisher.pc,
    publisherChannel,
    subscriberPc: subscriber.pc,
    subscriberChannel,
    keepalivePublisherChannel,
    keepaliveSubscriberChannel,
    auxChannels: [
      publisher.serverEvents,
      subscriber.serverEvents,
      keepalivePublisherChannel,
      keepaliveSubscriberChannel,
    ],
  };
}

async function createCloudflareSession(role) {
  const created = await cloudflareApi("/sessions/new", { method: "POST" });
  const pc = new nodeDataChannel.PeerConnection(`cloudflare-${role}`, {
    iceServers: ["stun:stun.cloudflare.com:3478"],
    disableAutoNegotiation: true,
  });
  const offerPromise = nextLocalDescription(pc, "offer", 15000);
  const serverEvents = pc.createDataChannel("server-events");
  pc.setLocalDescription("offer");
  const offer = await offerPromise;

  const established = await cloudflareApi(
    `/sessions/${created.sessionId}/datachannels/establish`,
    {
      method: "POST",
      body: {
        dataChannel: { location: "remote", dataChannelName: "server-events" },
        sessionDescription: { type: "offer", sdp: offer.sdp },
      },
    },
  );

  if (established.requiresImmediateRenegotiation) {
    const answerPromise = nextLocalDescription(pc, "answer", 15000);
    pc.setRemoteDescription(established.sessionDescription.sdp, "offer");
    pc.setLocalDescription("answer");
    const answer = await answerPromise;
    await cloudflareApi(`/sessions/${created.sessionId}/renegotiate`, {
      method: "PUT",
      body: { sessionDescription: { type: "answer", sdp: answer.sdp } },
    });
  } else {
    pc.setRemoteDescription(established.sessionDescription.sdp, "answer");
  }

  await waitForPeerState(pc, "connected", 20000);
  return { pc, serverEvents, sessionId: created.sessionId };
}

async function cloudflareApi(pathname, { method, body } = {}) {
  const response = await fetchWithTimeout(
    `https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}${pathname}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${CALLS_APP_SECRET}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    15000,
  );
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Cloudflare API returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok || parsed.errorCode || parsed.success === false) {
    const description = parsed.errorDescription || parsed.errors?.[0]?.message || text;
    throw new Error(`Cloudflare API ${method} ${pathname} failed: HTTP ${response.status} ${description}`);
  }
  return parsed.result ?? parsed;
}

async function measure(connection, options) {
  const { publisherChannel, subscriberChannel } = connection;
  const received = [];
  const receivedSequences = new Set();
  const sendMetadata = new Map();
  const sendScheduleLags = [];
  let duplicates = 0;
  let outOfOrder = 0;
  let highestMeasuredSequenceSeen = -1;
  let sendFailures = 0;
  let maxPublisherBufferedAmount = 0;
  const eventLoop = monitorEventLoopDelay({ resolution: 1 });
  eventLoop.enable();
  const keepalive = startKeepalive(connection, options.keepaliveHz);

  subscriberChannel.onMessage((message) => {
    const buffer = Buffer.isBuffer(message)
      ? message
      : message instanceof ArrayBuffer
        ? Buffer.from(message)
        : null;
    if (!buffer || buffer.length < 16) return;

    const sequence = buffer.readUInt32BE(0);
    const sentAt = buffer.readDoubleBE(8);
    if (sequence < options.warmup) return;

    const measuredSequence = sequence - options.warmup;
    if (receivedSequences.has(measuredSequence)) {
      duplicates += 1;
      return;
    }
    receivedSequences.add(measuredSequence);
    if (measuredSequence < highestMeasuredSequenceSeen) {
      outOfOrder += 1;
    } else {
      highestMeasuredSequenceSeen = measuredSequence;
    }
    const metadata = sendMetadata.get(sequence);
    received.push({
      sequence: measuredSequence,
      latencyMs: performance.now() - sentAt,
      receivedAtUnixMs: Date.now(),
      sendScheduleLagMs: metadata?.sendScheduleLagMs ?? null,
      publisherBufferedAmountBeforeSend: metadata?.publisherBufferedAmountBeforeSend ?? null,
    });
  });

  const total = options.warmup + options.samples;
  let nextSendAt = performance.now();
  for (let sequence = 0; sequence < total; sequence += 1) {
    const delay = nextSendAt - performance.now();
    if (delay > 0) await sleep(delay);

    const sendStartedAt = performance.now();
    const sendScheduleLagMs = Math.max(0, sendStartedAt - nextSendAt);
    const publisherBufferedAmountBeforeSend = publisherChannel.bufferedAmount();
    maxPublisherBufferedAmount = Math.max(maxPublisherBufferedAmount, publisherBufferedAmountBeforeSend);
    sendScheduleLags.push(sendScheduleLagMs);
    sendMetadata.set(sequence, { sendScheduleLagMs, publisherBufferedAmountBeforeSend });

    const payload = Buffer.alloc(options.payloadBytes);
    payload.writeUInt32BE(sequence, 0);
    payload.writeUInt32BE(0, 4);
    payload.writeDoubleBE(performance.now(), 8);
    if (!publisherChannel.sendMessageBinary(payload)) sendFailures += 1;
    nextSendAt += options.intervalMs;
  }
  await sleep(options.lateGraceMs);
  keepalive.stop();
  const keepaliveStats = await keepalive.done;
  eventLoop.disable();

  received.sort((a, b) => a.sequence - b.sequence);
  return {
    received,
    duplicates,
    outOfOrder,
    sendFailures,
    maxPublisherBufferedAmount,
    sendScheduleLagMs: numericSummary(sendScheduleLags),
    eventLoopDelayMs: {
      min: nanosecondsToMilliseconds(eventLoop.min),
      mean: nanosecondsToMilliseconds(eventLoop.mean),
      p50: nanosecondsToMilliseconds(eventLoop.percentile(50)),
      p99: nanosecondsToMilliseconds(eventLoop.percentile(99)),
      p999: nanosecondsToMilliseconds(eventLoop.percentile(99.9)),
      max: nanosecondsToMilliseconds(eventLoop.max),
    },
    keepalive: keepaliveStats,
  };
}

function summarize({ provider, trialNumber, connectMs, raw, publisherPc, subscriberPc }) {
  const latencies = raw.received.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const received = raw.received.length;
  return {
    provider,
    trialNumber,
    expected: config.samples,
    received,
    lost: config.samples - received,
    lossPercent: ((config.samples - received) / config.samples) * 100,
    duplicates: raw.duplicates,
    outOfOrder: raw.outOfOrder,
    sendFailures: raw.sendFailures,
    maxPublisherBufferedAmount: raw.maxPublisherBufferedAmount,
    sendScheduleLagMs: raw.sendScheduleLagMs,
    eventLoopDelayMs: raw.eventLoopDelayMs,
    keepalive: raw.keepalive,
    connectMs,
    latencyMs: {
      min: percentile(latencies, 0),
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      p999: percentile(latencies, 99.9),
      max: percentile(latencies, 100),
      mean: latencies.length === 0 ? null : latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    },
    transport: {
      publisher: peerStats(publisherPc),
      subscriber: peerStats(subscriberPc),
    },
  };
}

function peerStats(pc) {
  const selected = pc.getSelectedCandidatePair();
  return {
    rttMs: pc.rtt(),
    bytesSent: pc.bytesSent(),
    bytesReceived: pc.bytesReceived(),
    selectedCandidatePair: selected === null ? null : {
      localType: selected.local.type,
      localTransport: selected.local.transportType,
      remoteType: selected.remote.type,
      remoteTransport: selected.remote.transportType,
    },
  };
}

function printSummary(summary) {
  const latency = Object.fromEntries(
    Object.entries(summary.latencyMs).map(([key, value]) => [key, value === null ? null : Number(value.toFixed(3))]),
  );
  process.stdout.write(`${JSON.stringify({
    provider: summary.provider,
    received: `${summary.received}/${summary.expected}`,
    lossPercent: Number(summary.lossPercent.toFixed(3)),
    outOfOrder: summary.outOfOrder,
    connectMs: Number(summary.connectMs.toFixed(1)),
    latencyMs: latency,
    eventLoopDelayMs: summary.eventLoopDelayMs,
    sendScheduleLagMs: summary.sendScheduleLagMs,
    keepalive: summary.keepalive,
    transport: summary.transport,
  })}\n`);
}

function startKeepalive(connection, rateHz) {
  if (rateHz === null || connection.keepalivePublisherChannel === null) {
    return { stop() {}, done: Promise.resolve(null) };
  }

  let stopped = false;
  let sent = 0;
  let received = 0;
  let sendFailures = 0;
  connection.keepaliveSubscriberChannel?.onMessage(() => {
    received += 1;
  });

  const intervalMs = 1000 / rateHz;
  const done = (async () => {
    let nextSendAt = performance.now();
    while (!stopped) {
      const delay = nextSendAt - performance.now();
      if (delay > 0) await sleep(delay);
      if (stopped) break;
      const payload = Buffer.allocUnsafe(8);
      payload.writeDoubleBE(performance.now(), 0);
      if (!connection.keepalivePublisherChannel.sendMessageBinary(payload)) sendFailures += 1;
      sent += 1;
      nextSendAt += intervalMs;
    }
    return { mode: config.keepaliveMode, rateHz, sent, received, sendFailures };
  })();

  return {
    stop() { stopped = true; },
    done,
  };
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

function numericSummary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: percentile(sorted, 0),
    mean: sorted.length === 0 ? null : sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(sorted, 50),
    p99: percentile(sorted, 99),
    p999: percentile(sorted, 99.9),
    max: percentile(sorted, 100),
  };
}

function nanosecondsToMilliseconds(value) {
  return Number.isFinite(value) ? value / 1e6 : null;
}

function formatMegabitsPerSecond(payloadBytes, intervalMs) {
  return ((payloadBytes * 8) / intervalMs / 1000).toFixed(3);
}

function nextLocalDescription(pc, expectedType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for local ${expectedType}`)), timeoutMs);
    pc.onLocalDescription((sdp, type) => {
      if (type !== expectedType) return;
      clearTimeout(timeout);
      resolve({ sdp, type });
    });
  });
}

function waitForPeerState(pc, expectedState, timeoutMs) {
  if (pc.state() === expectedState) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Peer connection timed out in ${pc.state()}`)), timeoutMs);
    pc.onStateChange((state) => {
      if (state === expectedState) {
        clearTimeout(timeout);
        resolve();
      } else if (state === "failed" || state === "closed") {
        clearTimeout(timeout);
        reject(new Error(`Peer connection entered ${state}`));
      }
    });
  });
}

function waitForChannelOpen(channel, timeoutMs) {
  if (channel.isOpen()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`DataChannel ${channel.getLabel()} timed out`)), timeoutMs);
    channel.onOpen(() => {
      clearTimeout(timeout);
      resolve();
    });
    channel.onError((error) => {
      clearTimeout(timeout);
      reject(new Error(`DataChannel ${channel.getLabel()} failed: ${error}`));
    });
  });
}

function closeConnection(connection) {
  for (const channel of [
    connection.publisherChannel,
    connection.subscriberChannel,
    ...(connection.auxChannels ?? []),
  ]) {
    try { channel?.close(); } catch {}
  }
  for (const pc of [connection.publisherPc, connection.subscriberPc]) {
    try { pc?.close(); } catch {}
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
