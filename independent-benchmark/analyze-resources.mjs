import fs from "node:fs/promises";
import path from "node:path";

const trialDir = path.resolve(process.argv[2]);
const outputPath = path.resolve(process.argv[3] ?? path.join(trialDir, "resource-analysis.json"));
const roles = (process.argv[4] ?? "publisher,subscriber,relay")
  .split(",")
  .map((role) => role.trim())
  .filter(Boolean);
const hosts = {};
const rejectionReasons = [];

for (const role of roles) {
  const file = path.join(trialDir, role, "resource-monitor.jsonl");
  let samples;
  try {
    samples = (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch (error) {
    rejectionReasons.push(`${role} resource log is missing or invalid: ${error.message}`);
    continue;
  }
  const cpu = samples.map(({ machineCpuPercent }) => machineCpuPercent).filter(Number.isFinite);
  const memory = samples.map(({ memory }) => memory?.usedPercent).filter(Number.isFinite);
  const processCpu = samples.flatMap(({ benchmarkProcesses }) => benchmarkProcesses ?? [])
    .map(({ cpuPercent }) => cpuPercent).filter(Number.isFinite);
  const throttledByCgroup = new Map();
  for (const sample of samples) {
    for (const process of sample.benchmarkProcesses ?? []) {
      if (!process.cgroupPath || !Number.isFinite(process.cgroupCpu?.throttled_usec)) continue;
      const observed = throttledByCgroup.get(process.cgroupPath) ?? [];
      observed.push(process.cgroupCpu.throttled_usec);
      throttledByCgroup.set(process.cgroupPath, observed);
    }
  }
  const throttledDeltaUs = [...throttledByCgroup.values()].reduce((sum, values) => (
    sum + Math.max(0, values.at(-1) - values[0])
  ), 0);
  hosts[role] = {
    samples: samples.length,
    machineCpuPercent: numericSummary(cpu),
    benchmarkProcessCpuPercent: numericSummary(processCpu),
    memoryUsedPercent: numericSummary(memory),
    throttledDeltaUs,
  };
  if (samples.length < 5) rejectionReasons.push(`${role} has fewer than five resource samples`);
  if (percentile(cpu, 95) >= 80) rejectionReasons.push(`${role} machine CPU P95 reached 80%`);
  if (throttledDeltaUs > 0) rejectionReasons.push(`${role} benchmark cgroup was CPU-throttled`);
}

const analysis = { trialDir, accepted: rejectionReasons.length === 0, rejectionReasons, hosts };
await fs.writeFile(outputPath, `${JSON.stringify(analysis, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);

function numericSummary(values) {
  return {
    count: values.length,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : null,
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p / 100 * (sorted.length - 1);
  const lower = Math.floor(rank);
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[Math.ceil(rank)] * weight;
}
