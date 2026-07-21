import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const artifactRoot = path.join(root, "results-hosted-moq-gcp-20260718");
const managedRoot = path.join(root, "results-cloudflare-managed-moq-gcp-20260720");
const media = JSON.parse(await fs.readFile(path.join(artifactRoot, "media-analysis.json"), "utf8"));
const managedControl = JSON.parse(await fs.readFile(path.join(managedRoot, "control-analysis.json"), "utf8"));
const managedMedia = JSON.parse(await fs.readFile(path.join(managedRoot, "media-analysis.json"), "utf8"));
const regions = [
  { corridor: "west-virginia", label: "Virginia", attempts: 3 },
  { corridor: "west-frankfurt", label: "Frankfurt", attempts: 2 },
  { corridor: "west-tokyo", label: "Tokyo", attempts: 2 },
];

const control = [];
for (const region of regions) {
  const directory = path.join(
    artifactRoot,
    "control-trials",
    `hosted-pinned-${region.label.toLowerCase()}-moqdev-control-36000samples`,
    "origin",
  );
  const summaryPath = await findFile(directory, (name) => name.endsWith("-A.summary.json"));
  control.push(JSON.parse(await fs.readFile(summaryPath, "utf8")));
}

const mediaCompletion = regions.map((region) => {
  const aggregate = media.aggregate.find((row) => row.corridor === region.corridor) ?? null;
  return {
    ...region,
    completed: aggregate?.completedTrials ?? 0,
    aggregate,
  };
});

const managedMediaCompletion = regions.map((region) => {
  const aggregate = managedMedia.aggregate.find((row) => row.corridor === region.corridor) ?? null;
  return {
    ...region,
    attempts: 3,
    completed: aggregate?.completedTrials ?? 0,
    aggregate,
  };
});

const failures = [
  await parseFailure("west-frankfurt", 1, "hosted-frankfurt-moqdev-r1-subscriber.log"),
  await parseFailure("west-frankfurt", 2, "hosted-a2-frankfurt-moqdev-r1-subscriber.log"),
  await parseFailure("west-tokyo", 1, "hosted-tokyo-moqdev-r1-subscriber.log"),
];

const zeroLatencySummaries = await collectJson(
  path.join(root, "results-hosted-moq-zero-gcp-20260718"),
  (name) => name.endsWith("subscriber.summary.json"),
);

const managedVirginiaFailure = await parseManagedMediaFailure();
const managed60Hz = await parseJsonLog(path.join(
  root,
  "results-cloudflare-managed-moq-60hz-gcp-20260720",
  "ssh-logs",
  "cfmanaged60-virginia-control-18000samples-origin.log",
));

const output = {
  generatedAt: new Date().toISOString(),
  target: {
    provider: "moq.dev public demo CDN",
    relayUrl: "https://cdn.moq.dev/anon",
    implementation: "moq.dev/moq",
    revision: "b0115deeed82792a4dee41bb783b580fa03fbbfe",
    client: "moq-cli 0.8.7",
    warning: "Public, unauthenticated demo cluster; not a production SLA service.",
  },
  topology: {
    publisher: "us-west2-a",
    subscribers: ["us-east4-a", "europe-west3-a", "asia-northeast1-b"],
    media: "publisher and subscriber used their normally resolved CDN edges",
    control: "both endpoints pinned to the California-resolved CDN ingress for comparison with the west relay topology",
    multiEdgeControlQualification: "failed: 0/600 echoes when endpoints used separate west/east CDN edges",
  },
  workload: {
    media: "1280x720, 30 fps, H.264 baseline, strict 4 Mbps, per-frame fragmented MP4, capture-to-decoded-presentable-frame",
    control: "120 Hz, 1,100-byte latest-state updates, application round trip, 36,000 measured messages",
  },
  control,
  media: {
    completion: mediaCompletion,
    failures,
    rejectedTrials: media.rejectedTrials,
  },
  tuning: {
    accepted: "latency-max=100ms, fragment-duration=0ms",
    rejected: "latency-max=0ms",
    rejectedRuns: zeroLatencySummaries.map((summary) => ({
      runId: summary.runId,
      expected: summary.expected,
      received: summary.received,
      lost: summary.lost,
      p50Ms: summary.latencyMs?.p50 ?? null,
      p99Ms: summary.latencyMs?.p99 ?? null,
    })),
  },
  cloudflareManagedMoq: {
    status: "measured",
    measuredAt: "2026-07-20",
    target: {
      provider: "Cloudflare Managed MoQ",
      endpoint: "https://draft-14.cloudflare.mediaoverquic.com/[managed-credential]",
      protocol: "draft-ietf-moq-transport-14",
      clientRevision: "d98b8fc798bae9904916bf959206aaaac3ee5472",
    },
    control: {
      workload: "120 Hz, 1,100-byte QUIC datagrams, application round trip, 36,000 measured messages per corridor",
      aggregates: managedControl.aggregates,
      diagnostic60Hz: managed60Hz,
    },
    media: {
      workload: "1280x720, 30 fps, H.264 baseline, strict 4 Mbps, capture-to-decoded-presentable-frame",
      completion: managedMediaCompletion,
      failures: [managedVirginiaFailure],
      rejectedTrials: managedMedia.rejectedTrials,
    },
  },
};

const outputPath = path.join(artifactRoot, "hosted-moq-analysis.json");
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(outputPath);

async function parseFailure(corridor, attempt, name) {
  const logPath = path.join(artifactRoot, "ssh-logs", name);
  const text = await fs.readFile(logPath, "utf8");
  const counts = text.match(/"received":(\d+),"expected":(\d+)/);
  const firstFrameTimeout = text.includes("first decoded frame timed out");
  const code = text.match(/remote error: code=(\d+)/)?.[1] ?? null;
  return {
    corridor,
    attempt,
    received: counts ? Number(counts[1]) : 0,
    expected: counts ? Number(counts[2]) : 9000,
    reason: firstFrameTimeout
      ? "first decoded frame timed out"
      : text.includes("connection error: closed")
        ? "relay transport connection closed"
        : code
          ? `relay remote error code ${code}`
          : "subscriber failed",
    log: path.relative(root, logPath),
  };
}

async function findFile(directory, predicate) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, predicate).catch(() => null);
      if (nested) return nested;
    } else if (predicate(entry.name)) {
      return candidate;
    }
  }
  throw new Error(`No matching file under ${directory}`);
}

async function collectJson(directory, predicate) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collectJson(candidate, predicate));
    else if (predicate(entry.name)) output.push(JSON.parse(await fs.readFile(candidate, "utf8")));
  }
  return output.sort((a, b) => a.runId.localeCompare(b.runId));
}

async function parseManagedMediaFailure() {
  const logPath = path.join(
    managedRoot,
    "ssh-logs",
    "cfmanaged-virginia-media-r2-subscriber.log",
  );
  const text = await fs.readFile(logPath, "utf8");
  const counts = text.match(/"received":(\d+),"expected":(\d+)/);
  return {
    corridor: "west-virginia",
    attempt: 2,
    received: counts ? Number(counts[1]) : 0,
    expected: counts ? Number(counts[2]) : 9000,
    reason: text.includes("connection error: closed")
      ? "WebTransport connection closed"
      : "subscriber failed",
    log: path.relative(root, logPath),
  };
}

async function parseJsonLog(logPath) {
  const text = await fs.readFile(logPath, "utf8");
  const line = text.split("\n").find((entry) => entry.trim().startsWith("{"));
  if (!line) throw new Error(`No JSON record in ${logPath}`);
  return JSON.parse(line);
}
