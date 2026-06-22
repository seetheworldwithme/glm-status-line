import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createSseParser } from "../src/proxy/sseParser.js";
import { createRateTracker } from "../src/proxy/rateTracker.js";
import {
  getLiveRateFilePath,
  isLiveRateStreaming,
  readLiveRate,
  writeLiveRate
} from "../src/proxy/status.js";
import { startProxyServer } from "../src/proxy/server.js";
import {
  renderLaunchdPlist,
  renderSystemdUnit,
  installService,
  uninstallService,
  buildProxyServiceCommand
} from "../src/proxy/service.js";
import { installProxy, uninstallProxy } from "../src/proxy/installer.js";
import { loadConfig } from "../src/shared/config.js";
import { getCacheRoot } from "../src/shared/utils.js";

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

test("sse parser emits events across chunk boundaries", () => {
  const parser = createSseParser();
  const events = parser.feed(
    'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n'
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "message_start");
  assert.equal(events[1].event, "message_delta");
  const payload = JSON.parse(events[1].data);
  assert.equal(payload.usage.output_tokens, 42);
});

test("sse parser keeps a partial event until the blank-line terminator arrives", () => {
  const parser = createSseParser();
  assert.equal(parser.feed('event: message_delta\ndata: {"type":"mes').length, 0);
  const events = parser.feed('sage_delta"}\n\n');
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0].data).type, "message_delta");
});

test("sse parser joins multiple data: lines with newline", () => {
  const parser = createSseParser();
  const [evt] = parser.feed('data: line1\ndata: line2\n\n');
  assert.equal(evt.data, "line1\nline2");
});

test("sse parser ignores comment lines", () => {
  const parser = createSseParser();
  const events = parser.feed(': keep-alive\n\nevent: ping\ndata: {}\n\n');
  // The comment-only block yields no event; the ping block yields one.
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "ping");
});

// ---------------------------------------------------------------------------
// rate tracker
// ---------------------------------------------------------------------------

test("rate tracker computes tok/s over the sliding window", () => {
  const writes = [];
  const tracker = createRateTracker({ writeLiveRate: async (d) => writes.push(d), ticker: false });
  tracker.onMessageStart(1000);
  tracker.onMessageDelta(30, 1300); // 30 tokens in 300ms
  tracker.onMessageDelta(60, 1600); // +30 tokens in 300ms
  const snap = tracker.snapshot(1600);
  // window [1000-2500, 1600] holds readings at 1300 & 1600: (60-30)/0.3 = 100
  assert.equal(snap.state, "streaming");
  assert.equal(snap.rate, 100);
  assert.equal(snap.outputTokens, 60);
  tracker.stop();
});

test("rate tracker prunes readings outside the window", () => {
  const tracker = createRateTracker({ writeLiveRate: async () => {}, ticker: false });
  tracker.onMessageStart(1000);
  tracker.onMessageDelta(100, 1100);
  tracker.onMessageDelta(200, 2000);
  // Far in the future: the 2000 reading is older than windowMs (2500ms) before 10_000
  const snap = tracker.snapshot(10_000);
  assert.equal(snap.rate, null); // nothing measurable left in window
  tracker.stop();
});

test("rate tracker sets idle + final average on message_stop", () => {
  const tracker = createRateTracker({ writeLiveRate: async () => {}, ticker: false });
  tracker.onMessageStart(1000);
  tracker.onMessageDelta(50, 1500);
  tracker.onMessageStop(1000); // final: 1000 tokens over (1000->1000)?? use a real gap
  tracker.stop();

  // Re-run with a clean gap to assert final average.
  const t2 = createRateTracker({ writeLiveRate: async () => {}, ticker: false });
  t2.onMessageStart(0);
  t2.onMessageDelta(100, 1000);
  t2.onMessageStop(2000); // 100 tokens, but stop at 2000 -> 100/2 = 50
  const snap = t2.snapshot(2000);
  assert.equal(snap.state, "idle");
  assert.equal(snap.rate, 50);
  t2.stop();
});

test("rate tracker ignores non-progress deltas", () => {
  const tracker = createRateTracker({ writeLiveRate: async () => {}, ticker: false });
  tracker.onMessageStart(1000);
  tracker.onMessageDelta(30, 1300);
  tracker.onMessageDelta(30, 1500); // duplicate cumulative — must not add a reading
  tracker.onMessageDelta(30, 1700); // still no progress
  const snap = tracker.snapshot(1700);
  // With a single distinct reading the rate falls back to the overall average
  // (30 tokens / 0.7s ≈ 43); outputTokens tracks the last cumulative seen.
  assert.equal(snap.outputTokens, 30);
  assert.equal(snap.rate, 43);
  tracker.stop();
});

// ---------------------------------------------------------------------------
// status file
// ---------------------------------------------------------------------------

test("isLiveRateStreaming is true only for fresh, streaming, positive rate", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "glm-rate-"));
  const file = path.join(tmp, "live.json");
  try {
    await writeLiveRate(
      { state: "streaming", rate: 88, outputTokens: 10, updatedAt: Date.now() },
      file
    );
    const live = await readLiveRate(file);
    assert.equal(isLiveRateStreaming(live), true);

    await writeLiveRate({ state: "idle", rate: 88, outputTokens: 10, updatedAt: Date.now() }, file);
    assert.equal(isLiveRateStreaming(await readLiveRate(file)), false);

    await writeLiveRate(
      { state: "streaming", rate: 0, outputTokens: 0, updatedAt: Date.now() },
      file
    );
    assert.equal(isLiveRateStreaming(await readLiveRate(file)), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// proxy server end-to-end (mock GLM SSE upstream)
// ---------------------------------------------------------------------------

function startMockUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } });
      let cum = 0;
      let n = 0;
      const iv = setInterval(() => {
        cum += 25;
        n += 1;
        send("message_delta", { type: "message_delta", usage: { output_tokens: cum } });
        if (n >= 20) {
          clearInterval(iv);
          send("message_stop", { type: "message_stop" });
          res.end();
        }
      }, 60);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("proxy forwards the SSE stream intact and writes a live rate", async () => {
  const upstream = await startMockUpstream();
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  // Redirect the status file to a temp cache root so we never touch the user's.
  const tmpCache = await fs.mkdtemp(path.join(os.tmpdir(), "glm-rate-"));
  const liveFile = path.join(tmpCache, "live-rate.json");

  const { port, close } = await startProxyServer({
    port: 0,
    upstream: upstreamBase,
    writeLiveRate: async (data) => fs.writeFile(liveFile, JSON.stringify(data))
  });

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({ model: "glm-5.2", stream: true })
    });
    assert.equal(resp.headers.get("content-type"), "text/event-stream");

    const seen = new Set();
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    // Read the first chunk, wait for the rate ticker to write a fresh value
    // (first tick ~300ms) while the stream is still active (~1.2s long).
    await reader.read();
    await new Promise((r) => setTimeout(r, 450));

    // Sample the live-rate file WHILE the stream is still active.
    const liveMid = JSON.parse(await fs.readFile(liveFile, "utf8"));
    assert.equal(liveMid.state, "streaming");
    assert.ok(Number.isFinite(liveMid.rate) && liveMid.rate > 0, `mid rate was ${liveMid.rate}`);

    // Now drain the rest and confirm the client saw the full event sequence.
    let chunkStr = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunkStr += dec.decode(value, { stream: true });
    }
    for (const m of chunkStr.matchAll(/"type":"([a-z_]+)"/g)) seen.add(m[1]);

    assert.ok(seen.has("message_delta"), "client received message_delta events");
    assert.ok(seen.has("message_stop"), "client received message_stop");
  } finally {
    close();
    upstream.close();
    await fs.rm(tmpCache, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// service file generation
// ---------------------------------------------------------------------------

test("launchd plist contains the proxy start command and KeepAlive", () => {
  const plist = renderLaunchdPlist({ nodePath: "/usr/bin/node", entryPath: "/pkg/src/cli/index.js" });
  assert.match(plist, /com\.glm-status-line\.proxy/);
  assert.match(plist, /\/usr\/bin\/node/);
  assert.match(plist, /\/pkg\/src\/cli\/index\.js/);
  assert.match(plist, /<string>proxy<\/string>/);
  assert.match(plist, /<string>start<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
  assert.match(plist, /<true\/>/);
});

test("systemd unit contains ExecStart and Restart", () => {
  const unit = renderSystemdUnit({ nodePath: "/usr/bin/node", entryPath: "/pkg/src/cli/index.js" });
  assert.match(unit, /\[Unit\]/);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/pkg\/src\/cli\/index\.js" "proxy" "start"/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("buildProxyServiceCommand argv is node entry proxy start", () => {
  const { argv } = buildProxyServiceCommand("/n", "/e/index.js");
  assert.deepEqual(argv, ["/n", "/e/index.js", "proxy", "start"]);
});

test("installService writes + loads the launchd plist on darwin", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "glm-home-"));
  const calls = [];
  const runner = async (argv) => {
    calls.push(argv);
    return { success: true };
  };
  try {
    const result = await installService({
      fs,
      runner,
      platform: "darwin",
      home,
      nodePath: "/usr/bin/node",
      entryPath: "/pkg/src/cli/index.js"
    });
    assert.equal(result.type, "launchd");
    assert.equal(result.installed, true);
    // unload (stale) then load
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], "launchctl");
    assert.equal(calls[1][1], "load");
    const plist = await fs.readFile(result.path, "utf8");
    assert.match(plist, /com\.glm-status-line\.proxy/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("installService writes + enables the systemd unit on linux", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "glm-home-"));
  const calls = [];
  const runner = async (argv) => {
    calls.push(argv);
    return { success: true };
  };
  try {
    const result = await installService({
      fs,
      runner,
      platform: "linux",
      home,
      nodePath: "/usr/bin/node",
      entryPath: "/pkg/src/cli/index.js"
    });
    assert.equal(result.type, "systemd");
    assert.equal(result.installed, true);
    // daemon-reload then enable --now
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].slice(0, 3), ["systemctl", "--user", "enable"]);
    const unit = await fs.readFile(result.path, "utf8");
    assert.match(unit, /ExecStart=/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("installService rejects unsupported platforms", async () => {
  const result = await installService({ platform: "win32", runner: async () => ({ success: true }) });
  assert.equal(result.installed, false);
  assert.equal(result.reason, "unsupported_platform");
});

test("uninstallService removes the plist and unloads on darwin", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "glm-home-"));
  const calls = [];
  const runner = async (argv) => {
    calls.push(argv);
    return { success: true };
  };
  await installService({ fs, runner, platform: "darwin", home, nodePath: "/n", entryPath: "/e" });
  const result = await uninstallService({ fs, runner, platform: "darwin", home });
  assert.equal(result.removed, true);
  assert.equal(result.type, "launchd");
  assert.ok(calls.some((c) => c[1] === "unload"));
  await fs.stat(result.path).then(
    () => assert.fail("plist should be removed"),
    () => {}
  );
  await fs.rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// installer: settings.json rewrite + tool config + backup/restore
// ---------------------------------------------------------------------------

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj));
}

test("installProxy rewrites ANTHROPIC_BASE_URL to the proxy and backs up the upstream", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "glm-inst-"));
  const settingsPath = path.join(tmp, "settings.json");
  const configPath = path.join(tmp, "glm-status-line.json");
  await writeJson(settingsPath, {
    env: { ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic", ANTHROPIC_AUTH_TOKEN: "secret" }
  });

  try {
    const result = await installProxy({
      settingsPath,
      configPath,
      platform: "darwin",
      home: tmp,
      nodePath: "/n",
      entryPath: "/e",
      runner: async () => ({ success: true })
    });
    assert.equal(result.installed, true);
    assert.equal(result.upstream, "https://open.bigmodel.cn/api/anthropic");
    assert.equal(result.proxyUrl, "http://127.0.0.1:7821");
    assert.equal(result.previousBaseUrl, "https://open.bigmodel.cn/api/anthropic");

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:7821");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "secret"); // untouched

    const tool = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(tool.upstreamBaseUrl, "https://open.bigmodel.cn/api/anthropic");
    assert.equal(tool.proxy.service.previousBaseUrl, "https://open.bigmodel.cn/api/anthropic");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("installProxy refuses when there is no GLM upstream", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "glm-inst-"));
  const settingsPath = path.join(tmp, "settings.json");
  const configPath = path.join(tmp, "glm-status-line.json");
  await writeJson(settingsPath, { env: { ANTHROPIC_AUTH_TOKEN: "x" } });
  try {
    const result = await installProxy({
      settingsPath,
      configPath,
      platform: "darwin",
      home: tmp,
      runner: async () => ({ success: true })
    });
    assert.equal(result.installed, false);
    assert.equal(result.reason, "no_upstream");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("uninstallProxy restores the previous base URL", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "glm-inst-"));
  const settingsPath = path.join(tmp, "settings.json");
  const configPath = path.join(tmp, "glm-status-line.json");
  await writeJson(settingsPath, {
    env: { ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic", ANTHROPIC_AUTH_TOKEN: "secret" }
  });

  try {
    await installProxy({
      settingsPath,
      configPath,
      platform: "darwin",
      home: tmp,
      nodePath: "/n",
      entryPath: "/e",
      runner: async () => ({ success: true })
    });
    const result = await uninstallProxy({
      settingsPath,
      configPath,
      platform: "darwin",
      home: tmp,
      runner: async () => ({ success: true })
    });
    assert.equal(result.removed, true);
    assert.equal(result.restoredBaseUrl, "https://open.bigmodel.cn/api/anthropic");

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic");

    const tool = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(tool.upstreamBaseUrl, undefined);
    assert.equal(tool.proxy, undefined);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// config.js isGLM passthrough (the critical integration fix)
// ---------------------------------------------------------------------------

test("loadConfig classifies via upstreamBaseUrl when base URL is the local proxy", async () => {
  const env = { ANTHROPIC_AUTH_TOKEN: "tok" };
  const overrides = {
    baseUrl: "http://127.0.0.1:7821", // local proxy
    upstreamBaseUrl: "https://open.bigmodel.cn/api/anthropic"
  };
  const config = await loadConfig(env, overrides);
  assert.equal(config.isGLM, true, "isGLM must stay true through the proxy");
  assert.equal(config.quotaUrl, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  assert.equal(config.upstreamBaseUrl, "https://open.bigmodel.cn/api/anthropic");
});

test("loadConfig returns isGLM false for a non-GLM upstream with no proxy passthrough", async () => {
  const config = await loadConfig(
    { ANTHROPIC_AUTH_TOKEN: "tok" },
    { baseUrl: "https://api.example.com" }
  );
  assert.equal(config.isGLM, false);
});
