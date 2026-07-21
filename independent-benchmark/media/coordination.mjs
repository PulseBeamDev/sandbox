import http from "node:http";

export async function createCoordination({ role, port, url, token }) {
  if (!token) throw new Error("MEDIA_TOKEN is required");
  if (role === "publisher") return startCoordinator(port, token);
  if (!url) throw new Error("MEDIA_COORDINATOR_URL is required for the subscriber");
  return createCoordinatorClient(url, token);
}

async function startCoordinator(port, token) {
  let localInfo;
  let resolveLocalInfo;
  const localInfoPromise = new Promise((resolve) => { resolveLocalInfo = resolve; });
  let resolveRemoteInfo;
  const remoteInfoPromise = new Promise((resolve) => { resolveRemoteInfo = resolve; });
  let localReady = false;
  let resolveLocalReady;
  const localReadyPromise = new Promise((resolve) => { resolveLocalReady = resolve; });
  let resolveRemoteReady;
  const remoteReadyPromise = new Promise((resolve) => { resolveRemoteReady = resolve; });

  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === "POST" && request.url === "/exchange") {
        const remoteInfo = JSON.parse(await readRequestBody(request));
        resolveRemoteInfo(remoteInfo);
        respondJson(response, 200, await localInfoPromise);
        return;
      }
      if (request.method === "POST" && request.url === "/ready") {
        resolveRemoteReady();
        await localReadyPromise;
        respondJson(response, 200, { ready: true });
        return;
      }
      respondJson(response, 404, { error: "not found" });
    } catch (error) {
      respondJson(response, 500, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  process.stderr.write(`Media coordinator listening on ${port}\n`);

  return {
    async exchange(info) {
      localInfo = info;
      resolveLocalInfo(info);
      return remoteInfoPromise;
    },
    async ready() {
      localReady = true;
      resolveLocalReady();
      await remoteReadyPromise;
    },
    close() { server.close(); },
  };
}

function createCoordinatorClient(baseUrl, token) {
  return {
    exchange: (info) => retryJson(`${baseUrl}/exchange`, token, info, 90_000),
    ready: () => retryJson(`${baseUrl}/ready`, token, { ready: true }, 90_000),
    close() {},
  };
}

async function retryJson(url, token, body, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, 10_000);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return response.json();
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw new Error(`Coordinator request failed: ${lastError?.message ?? "timeout"}`);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > 65_536) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function respondJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
