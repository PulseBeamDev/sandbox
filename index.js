const pc = new RTCPeerConnection();
const sender = pc.createDataChannel(`v1/rt/pub/ping`, {
  maxRetransmits: 0,
  ordered: false
});
const id = Math.floor(Math.random() * 100);
console.log("Your ID:", id);
sender.onopen = _ => {
  const buffer = new ArrayBuffer(8);
  const view = new Float64Array(buffer);
  const encoder = new TextEncoder();

  setInterval(() => {
    view[0] = performance.now();
    sender.send(buffer);
  }, 1000);
};
const receiver = pc.createDataChannel(`v1/rt/sub/ping`, {
  maxRetransmits: 0,
  ordered: false
});
receiver.onmessage = ev => {
  const now = performance.now();

  const view = new Float64Array(ev.data);
  const sentTime = view[0];

  const duration = now - sentTime;
  console.log(`received RTT: ${duration.toFixed(4)} ms`);
};

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

let local = "http://localhost:7070";
let demo = "https://demo.pulsebeam.dev";
const endpoint = `${demo}/api/v1/rooms/demo/participants`;

const res = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/sdp" },
  body: offer.sdp,
});

await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
