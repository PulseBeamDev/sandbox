import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import nodeDataChannel from "node-datachannel";

const {
  DIST_ROLE,
  DIST_PROVIDER,
  DIST_COORDINATOR_URL,
  DIST_COORDINATOR_PORT = "8080",
  DIST_TOKEN,
  DIST_RUN_ID = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
  DIST_CORRIDOR = "unspecified",
  DIST_SAMPLES = "7200",
  DIST_WARMUP = "1200",
  DIST_RATE_HZ = "120",
  DIST_PAYLOAD_BYTES = "1200",
  DIST_LATE_GRACE_MS = "5000",
  DIST_OUTPUT_DIR = "results-distributed",
  CALLS_APP_ID,
  CALLS_APP_SECRET,
  PULSEBEAM_ENDPOINT,
} = process.env;

const config = {
  role: DIST_ROLE,
  provider: DIST_PROVIDER,
  coordinatorPort: parsePositiveInteger(DIST_COORDINATOR_PORT, "DIST_COORDINATOR_PORT"),
  token: DIST_TOKEN,
  runId: DIST_RUN_ID,
  corridor: DIST_CORRIDOR,
  samples: parsePositiveInteger(DIST_SAMPLES, "DIST_SAMPLES"),
  warmup: parseNonNegativeInteger(DIST_WARMUP, "DIST_WARMUP"),
  rateHz: parsePositiveNumber(DIST_RATE_HZ, "DIST_RATE_HZ"),
  payloadBytes: parsePositiveInteger(DIST_PAYLOAD_BYTES, "DIST_PAYLOAD_BYTES"),
  lateGraceMs: parseNonNegativeInteger(DIST_LATE_GRACE_MS, "DIST_LATE_GRACE_MS"),
  outputDir: path.resolve(DIST_OUTPUT_DIR),
};
config.intervalMs = 1000 / config.rateHz;

if (!["A", "B"].includes(config.role)) throw new Error("DIST_ROLE must be A or B");
if (!["cloudflare", "pulsebeam"].includes(config.provider)) {
  throw new Error("DIST_PROVIDER must be cloudflare or pulsebeam");
}
if (!config.token) throw new Error("DIST_TOKEN is required");
if (config.role === "B" && !DIST_COORDINATOR_URL) {
  throw new Error("DIST_COORDINATOR_URL is required for role B");
}
if (config.payloadBytes < 16) throw new Error("DIST_PAYLOAD_BYTES must be at least 16");
if (config.provider === "cloudflare" && (!CALLS_APP_ID || !CALLS_APP_SECRET)) {
  throw new Error("CALLS_APP_ID and CALLS_APP_SECRET are required for Cloudflare");
}
if (config.provider === "pulsebeam" && !PULSEBEAM_ENDPOINT) {
  throw new Error("PULSEBEAM_ENDPOINT is required for PulseBeam");
}

await fs.mkdir(config.outputDir, { recursive: true });
nodeDataChannel.initLogger("Warning", (level, message) => {
  if (level === "Error" || level === "Fatal") process.stderr.write(`[webrtc:${level}] ${message}\n`);
});

const coordination = config.role === "A"
  ? await startCoordinator(config.coordinatorPort, config.token)
  : createCoordinatorClient(DIST_COORDINATOR_URL, config.token);
let connection;

try {
  process.stderr.write(
    `Connecting ${config.provider} role ${config.role} for ${config.corridor} `
    + `(${config.payloadBytes} bytes @ ${config.rateHz} Hz)\n`,
  );
  const local = config.provider === "cloudflare"
    ? await createCloudflarePublisher(config.role)
    : await createPulseBeamDuplex(config.role);
  const remoteInfo = await coordination.exchange(local.exchangeInfo);
  connection = config.provider === "cloudflare"
    ? await completeCloudflareSubscriber(local, remoteInfo.sessionId, config.role)
    : local;

  if (config.role === "B") installEchoHandler(connection);
  await coordination.ready();

  const result = config.role === "A"
    ? await runOriginBenchmark(connection)
    : await waitAsReflector(connection);
  const stem = `${config.runId}-${config.provider}-${config.role}`;
  if (result.raw !== undefined) {
    await fs.writeFile(
      path.join(config.outputDir, `${stem}.jsonl`),
      result.raw.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
    );
  }
  await fs.writeFile(
    path.join(config.outputDir, `${stem}.summary.json`),
    JSON.stringify(result.summary, null, 2) + "\n",
  );
  process.stdout.write(`${JSON.stringify(result.summary)}\n`);
} finally {
  try { coordination.close?.(); } catch {}
  if (connection) closeConnection(connection);
  await sleep(250);
  nodeDataChannel.cleanup();
}

async function createPulseBeamDuplex(role) {
  const pc = new nodeDataChannel.PeerConnection(`pulsebeam-${role}`, {
    iceServers: [],
    disableAutoNegotiation: true,
  });
  const publishedName = role === "A" ? "control" : "telemetry";
  const subscribedName = role === "A" ? "telemetry" : "control";
  const channelConfig = { unordered: true, maxRetransmits: 0 };
  const publisherChannel = pc.createDataChannel(`v1/rt/pub/${publishedName}`, channelConfig);
  const subscriberChannel = pc.createDataChannel(`v1/rt/sub/${subscribedName}`, channelConfig);
  const offerPromise = nextLocalDescription(pc, "offer", 15000);
  pc.setLocalDescription("offer");
  const offer = await offerPromise;
  const response = await fetchWithTimeout(PULSEBEAM_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: offer.sdp,
  }, 15000);
  if (!response.ok) throw new Error(`PulseBeam signaling failed: HTTP ${response.status} ${await response.text()}`);
  pc.setRemoteDescription(await response.text(), "answer");
  await Promise.all([
    waitForPeerState(pc, "connected", 20000),
    waitForChannelOpen(publisherChannel, 20000),
    waitForChannelOpen(subscriberChannel, 20000),
  ]);
  return {
    pc,
    publisherChannel,
    subscriberChannel,
    auxChannels: [],
    exchangeInfo: { provider: "pulsebeam", role },
  };
}

async function createCloudflarePublisher(role) {
  const session = await createCloudflareSession(role);
  const publishedName = role === "A" ? "control" : "telemetry";
  const channelInfo = await cloudflareApi(`/sessions/${session.sessionId}/datachannels/new`, {
    method: "POST",
    body: { dataChannels: [{ location: "local", dataChannelName: publishedName }] },
  });
  const publisherChannel = session.pc.createDataChannel(`${publishedName}-published`, {
    negotiated: true,
    id: channelInfo.dataChannels[0].id,
    unordered: true,
    maxRetransmits: 0,
  });
  await waitForChannelOpen(publisherChannel, 15000);
  return {
    pc: session.pc,
    sessionId: session.sessionId,
    publisherChannel,
    subscriberChannel: null,
    auxChannels: [session.serverEvents],
    exchangeInfo: { provider: "cloudflare", role, sessionId: session.sessionId },
  };
}

async function completeCloudflareSubscriber(connection, remoteSessionId, role) {
  if (!remoteSessionId) throw new Error("The remote Cloudflare session ID was not exchanged");
  const remoteName = role === "A" ? "telemetry" : "control";
  const channelInfo = await cloudflareApi(`/sessions/${connection.sessionId}/datachannels/new`, {
    method: "POST",
    body: {
      dataChannels: [{
        location: "remote",
        sessionId: remoteSessionId,
        dataChannelName: remoteName,
        waitForAck: true,
      }],
    },
  });
  const subscriberChannel = connection.pc.createDataChannel(`${remoteName}-subscribed`, {
    negotiated: true,
    id: channelInfo.dataChannels[0].id,
    unordered: true,
    maxRetransmits: 0,
  });
  await waitForChannelOpen(subscriberChannel, 15000);
  subscriberChannel.sendMessage("ack");
  connection.subscriberChannel = subscriberChannel;
  return connection;
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
  const established = await cloudflareApi(`/sessions/${created.sessionId}/datachannels/establish`, {
    method: "POST",
    body: {
      dataChannel: { location: "remote", dataChannelName: "server-events" },
      sessionDescription: { type: "offer", sdp: offer.sdp },
    },
  });
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
  try { parsed = text ? JSON.parse(text) : {}; } catch {
    throw new Error(`Cloudflare API returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok || parsed.errorCode || parsed.success === false) {
    const description = parsed.errorDescription || parsed.errors?.[0]?.message || text;
    throw new Error(`Cloudflare API ${method} ${pathname} failed: HTTP ${response.status} ${description}`);
  }
  return parsed.result ?? parsed;
}

function installEchoHandler(connection) {
  const state = {
    received: 0,
    duplicates: 0,
    outOfOrder: 0,
    echoFailures: 0,
    highestSequence: -1,
    sequences: new Set(),
  };
  connection.echoState = state;
  connection.subscriberChannel.onMessage((message) => {
    const buffer = toBuffer(message);
    if (!buffer || buffer.length < 16) return;
    const sequence = buffer.readUInt32BE(0);
    if (state.sequences.has(sequence)) state.duplicates += 1;
    else state.sequences.add(sequence);
    if (sequence < state.highestSequence) state.outOfOrder += 1;
    else state.highestSequence = sequence;
    state.received += 1;
    if (!connection.publisherChannel.sendMessageBinary(buffer)) state.echoFailures += 1;
  });
}

async function runOriginBenchmark(connection) {
  const received = [];
  const receivedSequences = new Set();
  const sendMetadata = new Map();
  const sendScheduleLags = [];
  let duplicates = 0;
  let outOfOrder = 0;
  let highestMeasuredSequence = -1;
  let sendFailures = 0;
  let maxPublisherBufferedAmount = 0;
  const eventLoop = monitorEventLoopDelay({ resolution: 1 });
  eventLoop.enable();

  connection.subscriberChannel.onMessage((message) => {
    const buffer = toBuffer(message);
    if (!buffer || buffer.length < 16) return;
    const sequence = buffer.readUInt32BE(0);
    const sentAt = buffer.readDoubleBE(8);
    if (sequence < config.warmup) return;
    const measuredSequence = sequence - config.warmup;
    if (receivedSequences.has(measuredSequence)) {
      duplicates += 1;
      return;
    }
    receivedSequences.add(measuredSequence);
    if (measuredSequence < highestMeasuredSequence) outOfOrder += 1;
    else highestMeasuredSequence = measuredSequence;
    const metadata = sendMetadata.get(sequence);
    received.push({
      provider: config.provider,
      runId: config.runId,
      corridor: config.corridor,
      sequence: measuredSequence,
      roundTripMs: performance.now() - sentAt,
      receivedAtUnixMs: Date.now(),
      sendScheduleLagMs: metadata?.sendScheduleLagMs ?? null,
      publisherBufferedAmountBeforeSend: metadata?.publisherBufferedAmountBeforeSend ?? null,
    });
  });

  const total = config.warmup + config.samples;
  let nextSendAt = performance.now();
  for (let sequence = 0; sequence < total; sequence += 1) {
    const delay = nextSendAt - performance.now();
    if (delay > 0) await sleep(delay);
    const sendStartedAt = performance.now();
    const sendScheduleLagMs = Math.max(0, sendStartedAt - nextSendAt);
    const publisherBufferedAmountBeforeSend = connection.publisherChannel.bufferedAmount();
    maxPublisherBufferedAmount = Math.max(maxPublisherBufferedAmount, publisherBufferedAmountBeforeSend);
    sendScheduleLags.push(sendScheduleLagMs);
    sendMetadata.set(sequence, { sendScheduleLagMs, publisherBufferedAmountBeforeSend });
    const payload = Buffer.alloc(config.payloadBytes);
    payload.writeUInt32BE(sequence, 0);
    payload.writeUInt32BE(0, 4);
    payload.writeDoubleBE(performance.now(), 8);
    if (!connection.publisherChannel.sendMessageBinary(payload)) sendFailures += 1;
    nextSendAt += config.intervalMs;
  }
  await sleep(config.lateGraceMs);
  eventLoop.disable();
  received.sort((a, b) => a.sequence - b.sequence);
  const roundTrips = received.map((sample) => sample.roundTripMs).sort((a, b) => a - b);
  const summary = {
    provider: config.provider,
    role: config.role,
    runId: config.runId,
    corridor: config.corridor,
    mode: "application-round-trip",
    payloadBytes: config.payloadBytes,
    rateHz: config.rateHz,
    expected: config.samples,
    received: received.length,
    lost: config.samples - received.length,
    lossPercent: ((config.samples - received.length) / config.samples) * 100,
    duplicates,
    outOfOrder,
    sendFailures,
    maxPublisherBufferedAmount,
    roundTripMs: numericSummary(roundTrips),
    sendScheduleLagMs: numericSummary(sendScheduleLags),
    eventLoopDelayMs: {
      min: nanosecondsToMilliseconds(eventLoop.min),
      mean: nanosecondsToMilliseconds(eventLoop.mean),
      p50: nanosecondsToMilliseconds(eventLoop.percentile(50)),
      p99: nanosecondsToMilliseconds(eventLoop.percentile(99)),
      p999: nanosecondsToMilliseconds(eventLoop.percentile(99.9)),
      max: nanosecondsToMilliseconds(eventLoop.max),
    },
    transport: peerStats(connection.pc),
  };
  return { raw: received, summary };
}

async function waitAsReflector(connection) {
  const runtimeMs = ((config.warmup + config.samples) / config.rateHz) * 1000
    + config.lateGraceMs
    + 15000;
  await sleep(runtimeMs);
  const state = connection.echoState;
  return {
    summary: {
      provider: config.provider,
      role: config.role,
      runId: config.runId,
      corridor: config.corridor,
      mode: "reflector",
      payloadBytes: config.payloadBytes,
      rateHz: config.rateHz,
      received: state.received,
      duplicates: state.duplicates,
      outOfOrder: state.outOfOrder,
      echoFailures: state.echoFailures,
      maxPublisherBufferedAmount: connection.publisherChannel.bufferedAmount(),
      transport: peerStats(connection.pc),
    },
  };
}

async function startCoordinator(port, token) {
  let localInfo;
  let resolveLocalInfo;
  const localInfoPromise = new Promise((resolve) => { resolveLocalInfo = resolve; });
  let remoteInfo;
  let resolveRemoteInfo;
  const remoteInfoPromise = new Promise((resolve) => { resolveRemoteInfo = resolve; });
  let localReady = false;
  let resolveLocalReady;
  const localReadyPromise = new Promise((resolve) => { resolveLocalReady = resolve; });
  let resolveRemoteReady;
  const remoteReadyPromise = new Promise((resolve) => { resolveRemoteReady = resolve; });

  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === "POST" && request.url === "/exchange") {
        remoteInfo = JSON.parse(await readRequestBody(request));
        resolveRemoteInfo(remoteInfo);
        const info = await localInfoPromise;
        respondJson(response, 200, info);
        return;
      }
      if (request.method === "POST" && request.url === "/ready") {
        resolveRemoteReady();
        await localReadyPromise;
        respondJson(response, 200, { ready: true });
        return;
      }
      respondJson(response, 404, { error: "not found" });
    } catch (error) {
      respondJson(response, 500, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  process.stderr.write(`Coordinator listening on ${port}\n`);
  return {
    async exchange(info) {
      localInfo = info;
      resolveLocalInfo(localInfo);
      return remoteInfoPromise;
    },
    async ready() {
      localReady = true;
      resolveLocalReady();
      await remoteReadyPromise;
    },
    close() { server.close(); },
  };
}

function createCoordinatorClient(baseUrl, token) {
  return {
    async exchange(info) {
      return retryJson(`${baseUrl}/exchange`, token, info, 60000);
    },
    async ready() {
      await retryJson(`${baseUrl}/ready`, token, { ready: true }, 60000);
    },
  };
}

async function retryJson(url, token, body, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, 10000);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw new Error(`Coordinator request failed: ${lastError?.message ?? "timeout"}`);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > 65536) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function respondJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
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

function closeConnection(connection) {
  for (const channel of [
    connection.publisherChannel,
    connection.subscriberChannel,
    ...(connection.auxChannels ?? []),
  ]) {
    try { channel?.close(); } catch {}
  }
  try { connection.pc?.close(); } catch {}
}

function toBuffer(message) {
  if (Buffer.isBuffer(message)) return message;
  if (message instanceof ArrayBuffer) return Buffer.from(message);
  return null;
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
      } else if (["failed", "closed"].includes(state)) {
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

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

function numericSummary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: percentile(sorted, 0),
    mean: sorted.length === 0 ? null : sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    p999: percentile(sorted, 99.9),
    max: percentile(sorted, 100),
  };
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

function nanosecondsToMilliseconds(value) {
  return Number.isFinite(value) ? value / 1e6 : null;
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
