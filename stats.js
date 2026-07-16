export class StatsCollector {
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

