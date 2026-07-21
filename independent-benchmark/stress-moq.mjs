#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(import.meta.dirname);
const agent = path.resolve(
  args.agent ?? path.join(root, "moq-agent/target/release/moq-benchmark-agent"),
);
const relayUrl = args.url ?? "https://localhost:4443/stress";
const outputRoot = path.resolve(args.output ?? path.join(root, "results-moq-stress/full"));
const profile = args.profile ?? "full";
const startupPairs =
  profile === "boundaries" ? 0 : profile === "startup-only" ? 20 : profile === "quick" ? 10 : 50;
const loadPairs =
  profile === "boundaries" || profile === "startup-only" ? 0 : profile === "quick" ? 4 : 12;

await mkdir(outputRoot, { recursive: true });

const startup = [];
const startupBatchSize = profile === "startup-only" ? 5 : 10;
for (let offset = 0; offset < startupPairs; offset += startupBatchSize) {
  const batch = Array.from(
    { length: Math.min(startupBatchSize, startupPairs - offset) },
    (_, index) => {
      const pair = offset + index;
      const skewMs =
        profile === "startup-only"
          ? pair % 2 === 0
            ? 750
            : -750
          : pair % 2 === 0
            ? 25 + (pair * 73) % 400
            : -(25 + (pair * 97) % 400);
      return runPair({
        category: "startup",
        id: `startup-${String(pair + 1).padStart(2, "0")}`,
        skewMs,
        samples: 48,
        warmup: 24,
        rateHz: 240,
        payloadBytes: 1100,
        startDelayMs: 100,
      });
    },
  );
  startup.push(...(await Promise.all(batch)));
}

const load = await Promise.all(
  Array.from({ length: loadPairs }, (_, index) =>
    runPair({
      category: "concurrent-load",
      id: `load-${String(index + 1).padStart(2, "0")}`,
      skewMs: index % 2 === 0 ? 0 : 20,
      samples: profile === "quick" ? 1_000 : 5_000,
      warmup: profile === "quick" ? 100 : 500,
      rateHz: 500,
      payloadBytes: 1100,
      startDelayMs: 500,
    }),
  ),
);

const rateSweep = [];
const rateValues =
  profile === "boundaries"
    ? [550, 600, 650, 700, 750, 800, 850, 900, 950]
    : profile === "startup-only"
      ? []
      : [120, 500, 1_000, 2_000];
for (const rateHz of rateValues) {
  rateSweep.push(
    await runPair({
      category: "rate-sweep",
      id: `rate-${rateHz}`,
      skewMs: 20,
      samples: rateHz * (profile === "quick" ? 1 : profile === "boundaries" ? 3 : 4),
      warmup: Math.ceil(rateHz / 2),
      rateHz,
      payloadBytes: 1100,
      startDelayMs: 300,
    }),
  );
}

const payloadSweep = await Promise.all(
  (profile === "boundaries"
    ? [1152, 1154, 1156, 1158, 1160, 1162, 1164, 1166, 1168, 1170, 1172, 1174]
    : profile === "startup-only"
      ? []
    : [1100, 1125, 1150, 1175, 1190, 1200]
  ).map((payloadBytes) =>
    runPair({
      category: "payload-sweep",
      id: `payload-${payloadBytes}`,
      skewMs: 20,
      samples: profile === "quick" ? 240 : 600,
      warmup: 60,
      rateHz: 500,
      payloadBytes,
      startDelayMs: 300,
    }),
  ),
);

const summary = {
  generatedAt: new Date().toISOString(),
  implementation: "cloudflare/moq-rs draft-ietf-moq-transport-16",
  relayUrl,
  profile,
  startup: summarize(startup),
  concurrentLoad: summarize(load),
  rateSweep: rateSweep.map(compactPair),
  payloadSweep: payloadSweep.map(compactPair),
  details: { startup, concurrentLoad: load, rateSweep, payloadSweep },
};

await writeFile(
  path.join(outputRoot, "stress-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify({
  startup: summary.startup,
  concurrentLoad: summary.concurrentLoad,
  rateSweep: summary.rateSweep,
  payloadSweep: summary.payloadSweep,
}, null, 2)}\n`);

async function runPair(test) {
  const pairDir = path.join(outputRoot, test.category, test.id);
  await mkdir(pairDir, { recursive: true });
  const base = [
    "--url",
    `${relayUrl}/${test.category}/${test.id}`,
    "--run-id",
    test.id,
    "--corridor",
    "local-stress",
    "--samples",
    String(test.samples),
    "--warmup",
    String(test.warmup),
    "--rate-hz",
    String(test.rateHz),
    "--payload-bytes",
    String(test.payloadBytes),
    "--start-delay-ms",
    String(test.startDelayMs),
    "--late-grace-ms",
    "750",
    "--reflector-shutdown-grace-ms",
    "250",
    "--publish-ready-timeout-ms",
    "5000",
    "--subscribe-timeout-ms",
    "10000",
    "--subscribe-retry-initial-ms",
    "20",
    "--subscribe-retry-max-ms",
    "250",
    "--tls-disable-verify",
    "--output-dir",
    pairDir,
  ];

  const firstRole = test.skewMs < 0 ? "b" : "a";
  const secondRole = firstRole === "a" ? "b" : "a";
  const startedAt = Date.now();
  const first = runProcess(firstRole, [...base, "--role", firstRole], pairDir);
  await delay(Math.abs(test.skewMs));
  const second = runProcess(secondRole, [...base, "--role", secondRole], pairDir);
  const results = await Promise.all([first, second]);
  const byRole = Object.fromEntries(results.map((result) => [result.role.toUpperCase(), result]));
  const origin = byRole.A?.summary;
  const reflector = byRole.B?.summary;

  return {
    ...test,
    elapsedMs: Date.now() - startedAt,
    passed:
      byRole.A?.exitCode === 0 &&
      byRole.B?.exitCode === 0 &&
      origin?.received === origin?.expected &&
      origin?.sendFailures === 0 &&
      origin?.duplicates === 0 &&
      origin?.outOfOrder === 0 &&
      reflector?.echoFailures === 0,
    originExitCode: byRole.A?.exitCode ?? null,
    reflectorExitCode: byRole.B?.exitCode ?? null,
    origin: origin ?? null,
    reflector: reflector ?? null,
  };
}

function runProcess(role, processArgs, pairDir) {
  return new Promise((resolve) => {
    const child = spawn(agent, processArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.on("close", async (exitCode, signal) => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      await Promise.all([
        writeFile(path.join(pairDir, `${role}.stdout`), stdoutText),
        writeFile(path.join(pairDir, `${role}.stderr`), stderrText),
      ]);
      resolve({
        role,
        exitCode,
        signal,
        summary: parseSummary(stdoutText),
      });
    });
  });
}

function parseSummary(text) {
  for (const line of text.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // Skip non-JSON logging lines.
    }
  }
  return null;
}

function summarize(pairs) {
  const origins = pairs.map((pair) => pair.origin).filter(Boolean);
  const expected = origins.reduce((total, item) => total + item.expected, 0);
  const received = origins.reduce((total, item) => total + item.received, 0);
  const setup = origins.map((item) => item.setupMs).sort((a, b) => a - b);
  const subscribeAttempts = pairs.flatMap((pair) =>
    [pair.origin?.subscribeAttempts, pair.reflector?.subscribeAttempts].filter(Number.isFinite),
  );
  return {
    pairs: pairs.length,
    passed: pairs.filter((pair) => pair.passed).length,
    failed: pairs.filter((pair) => !pair.passed).length,
    expected,
    received,
    lost: expected - received,
    lossPercent: expected === 0 ? 0 : ((expected - received) / expected) * 100,
    sendFailures: origins.reduce((total, item) => total + item.sendFailures, 0),
    duplicates: origins.reduce((total, item) => total + item.duplicates, 0),
    outOfOrder: origins.reduce((total, item) => total + item.outOfOrder, 0),
    setupMsP50: percentile(setup, 0.5),
    setupMsP99: percentile(setup, 0.99),
    maxSubscribeAttempts: subscribeAttempts.length ? Math.max(...subscribeAttempts) : 0,
    pairsRequiringRetry: pairs.filter(
      (pair) => pair.origin?.subscribeAttempts > 1 || pair.reflector?.subscribeAttempts > 1,
    ).length,
    worstRoundTripP99Ms: origins.length
      ? Math.max(...origins.map((item) => item.roundTripMs.p99))
      : 0,
    worstSendScheduleLagP99Ms: origins.length
      ? Math.max(...origins.map((item) => item.sendScheduleLagMs.p99))
      : 0,
  };
}

function compactPair(pair) {
  return {
    id: pair.id,
    rateHz: pair.rateHz,
    payloadBytes: pair.payloadBytes,
    passed: pair.passed,
    expected: pair.origin?.expected ?? 0,
    received: pair.origin?.received ?? 0,
    lost: pair.origin?.lost ?? null,
    sendFailures: pair.origin?.sendFailures ?? null,
    roundTripP50Ms: pair.origin?.roundTripMs?.p50 ?? null,
    roundTripP99Ms: pair.origin?.roundTripMs?.p99 ?? null,
    scheduleLagP99Ms: pair.origin?.sendScheduleLagMs?.p99 ?? null,
    setupMs: pair.origin?.setupMs ?? null,
    subscribeAttempts: pair.origin?.subscribeAttempts ?? null,
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = quantile * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    result[value.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}
