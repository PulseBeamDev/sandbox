import { StatsCollector } from "./stats.js";

const channelConfig = {
  maxRetransmits: 0,
  ordered: false
};
const local = "http://localhost:7070";
const demo = "https://demo.pulsebeam.dev";
const endpoint = `${demo}/api/v1/rooms/demo/participants`;

export async function spawnDataPublisher() {
  const pc = new RTCPeerConnection();
  const sender = pc.createDataChannel(`v1/rt/pub/ping`, channelConfig);
  sender.onopen = _ => {
    const buffer = new ArrayBuffer(8);
    const view = new Float64Array(buffer);

    setInterval(() => {
      view[0] = performance.now();
      sender.send(buffer);
    }, 500);
  };
  await connectToPulseBeam(pc);
}

export async function spawnDataSubscriber() {
  const stats = new StatsCollector(10000);
  const pc = new RTCPeerConnection();
  const receiver = pc.createDataChannel(`v1/rt/sub/ping`, channelConfig);
  let tick = 0;
  receiver.onmessage = ev => {
    const now = performance.now();

    const view = new Float64Array(ev.data);
    const sentTime = view[0];

    const duration = now - sentTime;
    console.log(`received RTT: ${duration.toFixed(4)} ms`);
    stats.add(duration);
    tick += 1;

    if (tick % 30 === 0) {
      stats.report();
    }
  };
  await connectToPulseBeam(pc);
}

async function connectToPulseBeam(pc) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: offer.sdp,
  });

  await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
}

