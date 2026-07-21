import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

const intervalMs = Number(process.env.RESOURCE_INTERVAL_MS ?? "1000");
const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
if (!Number.isFinite(intervalMs) || intervalMs < 250 || !Number.isFinite(ticksPerSecond)) {
  throw new Error("invalid resource monitor timing configuration");
}

let stopped = false;
let previousAt = process.hrtime.bigint();
let previousCpu = await readCpu();
let previousProcesses = new Map();
process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });

while (!stopped) {
  await sleep(intervalMs);
  const now = process.hrtime.bigint();
  const elapsedSeconds = Number(now - previousAt) / 1e9;
  const cpu = await readCpu();
  const processSnapshot = await readProcesses();
  const memory = await readMemory();
  const network = await readNetwork();

  const processes = [];
  for (const [pid, current] of processSnapshot) {
    const previous = previousProcesses.get(pid);
    const cpuTicks = previous ? current.cpuTicks - previous.cpuTicks : null;
    processes.push({
      ...current,
      cpuPercent: cpuTicks === null
        ? null
        : cpuTicks / ticksPerSecond / elapsedSeconds * 100,
    });
  }
  processes.sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1));

  process.stdout.write(`${JSON.stringify({
    capturedAt: new Date().toISOString(),
    elapsedSeconds,
    machineCpuPercent: cpuPercent(previousCpu, cpu),
    memory,
    network,
    benchmarkProcesses: processes.filter(({ command }) => isBenchmarkProcess(command)),
    topProcesses: processes.slice(0, 12),
  })}\n`);

  previousAt = now;
  previousCpu = cpu;
  previousProcesses = processSnapshot;
}

async function readCpu() {
  const text = await fs.readFile("/proc/stat", "utf8");
  const fields = text.split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = fields[3] + (fields[4] ?? 0);
  return { total: fields.reduce((sum, value) => sum + value, 0), idle };
}

function cpuPercent(previous, current) {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  return total > 0 ? (total - idle) / total * 100 : null;
}

async function readMemory() {
  const text = await fs.readFile("/proc/meminfo", "utf8");
  const values = Object.fromEntries(text.trim().split("\n").map((line) => {
    const match = line.match(/^([^:]+):\s+(\d+)/);
    return match ? [match[1], Number(match[2]) * 1024] : [line, null];
  }));
  return {
    totalBytes: values.MemTotal,
    availableBytes: values.MemAvailable,
    usedPercent: (values.MemTotal - values.MemAvailable) / values.MemTotal * 100,
  };
}

async function readNetwork() {
  const text = await fs.readFile("/proc/net/dev", "utf8");
  let receivedBytes = 0;
  let transmittedBytes = 0;
  for (const line of text.trim().split("\n").slice(2)) {
    const [, valuesText] = line.split(":");
    if (!valuesText) continue;
    const values = valuesText.trim().split(/\s+/).map(Number);
    receivedBytes += values[0] ?? 0;
    transmittedBytes += values[8] ?? 0;
  }
  return { receivedBytes, transmittedBytes };
}

async function readProcesses() {
  const output = new Map();
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map(async (entry) => {
    const pid = Number(entry.name);
    try {
      const root = `/proc/${pid}`;
      const [stat, cmdline, status, io, cgroup] = await Promise.all([
        fs.readFile(`${root}/stat`, "utf8"),
        fs.readFile(`${root}/cmdline`),
        fs.readFile(`${root}/status`, "utf8"),
        fs.readFile(`${root}/io`, "utf8").catch(() => ""),
        fs.readFile(`${root}/cgroup`, "utf8").catch(() => ""),
      ]);
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const command = cmdline.toString().replaceAll("\0", " ").trim()
        || stat.slice(stat.indexOf("(") + 1, close);
      const rssMatch = status.match(/^VmRSS:\s+(\d+) kB/m);
      const readMatch = io.match(/^read_bytes:\s+(\d+)/m);
      const writeMatch = io.match(/^write_bytes:\s+(\d+)/m);
      const cgroupPath = cgroup.match(/^0::(.+)$/m)?.[1] ?? null;
      output.set(pid, {
        pid,
        command,
        cpuTicks: Number(fields[11]) + Number(fields[12]),
        rssBytes: rssMatch ? Number(rssMatch[1]) * 1024 : null,
        readBytes: readMatch ? Number(readMatch[1]) : null,
        writeBytes: writeMatch ? Number(writeMatch[1]) : null,
        cgroupPath,
        cgroupCpu: cgroupPath ? await readCgroupCpu(cgroupPath) : null,
      });
    } catch {
      // Processes may exit at any point between /proc enumeration and reads.
    }
  }));
  return output;
}

async function readCgroupCpu(cgroupPath) {
  try {
    const text = await fs.readFile(`/sys/fs/cgroup${cgroupPath}/cpu.stat`, "utf8");
    return Object.fromEntries(text.trim().split("\n").map((line) => {
      const [key, value] = line.split(/\s+/);
      return [key, Number(value)];
    }));
  } catch {
    return null;
  }
}

function isBenchmarkProcess(command) {
  return /(?:media\/(?:webrtc|moq)-agent\.mjs|ffmpeg|moq-(?:pub|sub|relay)|pulsebeam)/.test(command);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
