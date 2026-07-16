import { StatsCollector } from "./stats.js";

/// Based on the official example
/// https://github.com/cloudflare/realtime-examples/blob/main/echo-datachannels/index.html

// Cloudflare configuration constants
const APP_ID = "<APP_ID>"
// ❗ Note: Keep this secure on the server-side in production.
const APP_TOKEN = "<APP_TOKEN>"
const API_BASE = `https://rtc.live.cloudflare.com/v1/apps/${APP_ID}`;


const headers = {
  Authorization: `Bearer ${APP_TOKEN}`
};

const peerConnectionConfig = {
  iceServers: [
    {
      urls: "stun:stun.cloudflare.com:3478",
    },
  ],
  bundlePolicy: "max-bundle",
};

/**
 * Spawns a publisher session.
 */
export async function spawnDataPublisher() {
  const pc = new RTCPeerConnection(peerConnectionConfig);
  const sessionId = await createCallsSession();

  // 1. Establish transport
  await establishDataChannelTransport(pc, sessionId, true);

  // 2. Register local channel
  const channelRegisterResp = await fetch(
    `${API_BASE}/sessions/${sessionId}/datachannels/new`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        dataChannels: [
          {
            location: "local",
            dataChannelName: "channel-one",
          },
        ],
      }),
    }
  ).then((res) => {
    if (!res.ok) throw new Error(`Publisher Channel Creation failed: ${res.status}`);
    return res.json();
  });

  // 3. Create locally using Cloudflare's registered ID
  const channel = pc.createDataChannel("channel-one", {
    negotiated: true,
    id: channelRegisterResp.dataChannels[0].id,
    maxRetransmits: 0,
    ordered: false,
  });

  channel.onopen = () => {
    console.log("Publisher DataChannel opened.");
    const buffer = new ArrayBuffer(8);
    const view = new Float64Array(buffer);
    setInterval(() => {
      view[0] = performance.now();
      channel.send(buffer);
    }, 500);
  };

  return { sessionId };
}

/**
 * Spawns a subscriber session.
 */
export async function spawnDataSubscriber(targetSessionId) {
  const stats = new StatsCollector(10000);
  const pc = new RTCPeerConnection(peerConnectionConfig);
  const sessionId = await createCallsSession();

  // 1. Establish transport
  await establishDataChannelTransport(pc, sessionId, true);

  // 2. Request remote subscription
  const subscriptionResp = await fetch(
    `${API_BASE}/sessions/${sessionId}/datachannels/new`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        dataChannels: [
          {
            location: "remote",
            sessionId: targetSessionId,
            dataChannelName: "channel-one",
          },
        ],
      }),
    }
  ).then((res) => {
    if (!res.ok) throw new Error(`Subscription handshake failed: ${res.status}`);
    return res.json();
  });

  if (!subscriptionResp.dataChannels || subscriptionResp.dataChannels.length === 0) {
    throw new Error("Cloudflare did not return any valid downstream subscription channels.");
  }

  // 3. Bind local subscription channel
  const subscriberChannel = pc.createDataChannel("channel-one-subscribed", {
    negotiated: true,
    id: subscriptionResp.dataChannels[0].id,
    maxRetransmits: 0,
    ordered: false,
  });

  let tick = 0;
  subscriberChannel.onmessage = (ev) => {
    const now = performance.now();

    const view = new Float64Array(ev.data);
    const sentTime = view[0];

    const duration = now - sentTime;
    stats.add(duration);
    tick += 1;

    if (tick % 30 === 0) {
      console.log("Cloudflare");
      stats.report();
    }
  };
}

async function createCallsSession() {
  const res = await fetch(`${API_BASE}/sessions/new`, {
    method: "POST",
    headers,
  }).then((res) => {
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
    return res.json();
  });
  return res.sessionId;
}

async function establishDataChannelTransport(pc, sessionId, makeOffer) {
  let sdp = null;

  if (makeOffer) {
    const dc = pc.createDataChannel("server-events", { negotiated: false });
    dc.onmessage = (m) => console.log("Server event: ", m);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sdp = offer;
  }

  const response = await fetch(
    `${API_BASE}/sessions/${sessionId}/datachannels/establish`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        dataChannel: {
          location: "remote",
          dataChannelName: "server-events",
        },
        ...(sdp !== null ? { sessionDescription: { type: "offer", sdp: sdp.sdp } } : {})
      }),
    }
  ).then((res) => {
    if (!res.ok) throw new Error(`Transport establishment failed: ${res.status}`);
    return res.json();
  });

  if (response.requiresImmediateRenegotiation) {
    await pc.setRemoteDescription(response.sessionDescription);
    const localAnswer = await pc.createAnswer();
    await pc.setLocalDescription(localAnswer);

    const renegotiateResponse = await fetch(
      `${API_BASE}/sessions/${sessionId}/renegotiate`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          sessionDescription: {
            sdp: localAnswer.sdp,
            type: "answer",
          },
        }),
      }
    ).then((res) => {
      if (!res.ok) throw new Error(`Renegotiation failed: ${res.status}`);
      return res.json();
    });

    if (renegotiateResponse.errorCode) {
      throw new Error(renegotiateResponse.errorDescription);
    }
  } else {
    await pc.setRemoteDescription(response.sessionDescription);
  }
}
