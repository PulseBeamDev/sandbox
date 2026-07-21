import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function clockDiagnostics() {
  try {
    const { stdout } = await execFileAsync("chronyc", ["tracking"], { timeout: 5000 });
    const output = stdout.trim();
    const systemOffset = parseSignedChronySeconds(output, "System time");
    const lastOffset = parseChronyNumber(output, "Last offset");
    const rmsOffset = parseChronyNumber(output, "RMS offset");
    const rootDispersion = parseChronyNumber(output, "Root dispersion");
    return {
      source: "chronyc tracking",
      systemOffsetMs: milliseconds(systemOffset),
      lastOffsetMs: milliseconds(lastOffset),
      rmsOffsetMs: milliseconds(rmsOffset),
      rootDispersionMs: milliseconds(rootDispersion),
      output,
    };
  } catch {
    try {
      const { stdout } = await execFileAsync(
        "timedatectl",
        ["show", "--property=NTPSynchronized", "--value"],
        { timeout: 5000 },
      );
      return { source: "timedatectl", synchronized: stdout.trim() === "yes" };
    } catch {
      return { source: "unavailable" };
    }
  }
}

export function assertClock(clock, maxOffsetMs) {
  if (clock.source !== "chronyc tracking") {
    throw new Error(`chronyc tracking is required, got ${clock.source}`);
  }
  const offsets = [clock.systemOffsetMs, clock.lastOffsetMs].filter(Number.isFinite).map(Math.abs);
  if (!offsets.length) throw new Error("chronyc output did not contain a parseable clock offset");
  const observed = Math.max(...offsets);
  if (observed > maxOffsetMs) {
    throw new Error(`clock offset ${observed.toFixed(6)} ms exceeds ${maxOffsetMs} ms`);
  }
}

function parseSignedChronySeconds(output, field) {
  const match = output.match(new RegExp(`^${escapeRegExp(field)}\\s*:\\s*([+\\-0-9.eE]+) seconds (fast|slow)`, "m"));
  if (!match) return null;
  const value = Number(match[1]);
  return match[2] === "slow" ? -Math.abs(value) : Math.abs(value);
}

function parseChronyNumber(output, field) {
  const match = output.match(new RegExp(`^${escapeRegExp(field)}\\s*:\\s*([+\\-0-9.eE]+) seconds`, "m"));
  return match ? Number(match[1]) : null;
}

function milliseconds(seconds) {
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
