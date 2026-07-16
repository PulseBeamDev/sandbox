const channelConfig = {
  maxRetransmits: 0,
  ordered: false
};
const local = "http://localhost:7070";
const demo = "https://demo.pulsebeam.dev";
const endpoint = `${local}/api/v1/rooms/demo/participants`;

class StatsCollector {
  constructor(reportIntervalMs = 10000) {
    this.latencies = [];
    this.reportIntervalMs = reportIntervalMs;
    this.startReporting();
  }

  add(latency) {
    this.latencies.push(latency);
  }

  calculatePercentile(sorted, percentile) {
    if (sorted.length === 0) return 0;
    const index = Math.floor((sorted.length - 1) * (percentile / 100));
    return sorted[index];
  }

  report() {
    if (this.latencies.length === 0) {
      console.log("No data collected yet.");
      return;
    }

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const count = sorted.length;

    const min = sorted[0];
    const p50 = this.calculatePercentile(sorted, 50);
    const p90 = this.calculatePercentile(sorted, 90);
    const p95 = this.calculatePercentile(sorted, 95);
    const p99 = this.calculatePercentile(sorted, 99);
    const max = sorted[sorted.length - 1];

    console.log(`=== Latency Stats (Samples: ${count}) ===`);
    console.table({
      "Min Latency": `${min.toFixed(2)} ms`,
      "P50 (Median)": `${p50.toFixed(2)} ms`,
      "P90": `${p90.toFixed(2)} ms`,
      "P95": `${p95.toFixed(2)} ms`,
      "P99": `${p99.toFixed(2)} ms`,
      "Max Latency": `${max.toFixed(2)} ms`
    });
  }

  startReporting() {
    setInterval(() => {
      this.report();
    }, this.reportIntervalMs);
  }
}

async function spawnDataPublisher() {
  const pc = new RTCPeerConnection();
  const sender = pc.createDataChannel(`v1/rt/pub/ping`, channelConfig);
  sender.onopen = _ => {
    const buffer = new ArrayBuffer(8);
    const view = new Float64Array(buffer);

    setInterval(() => {
      view[0] = performance.now();
      sender.send(buffer);
    }, 1000);
  };
  await connectToPulseBeam(pc);
}

async function spawnDataSubscriber() {
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

spawnDataPublisher();
spawnDataSubscriber();
