import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeRate, getSessionRate } from "../src/core/rate/index.js";
import { formatStatus } from "../src/core/status/format.js";

const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, "");

test("computeRate averages recent assistant turns", () => {
  const messages = [
    { ts: 1000, type: "user", output: 0 },
    { ts: 4000, type: "assistant", output: 600 }, // 3s → 200/s
    { ts: 5000, type: "user", output: 0 },
    { ts: 8000, type: "assistant", output: 300 } // 3s → 100/s
  ];
  const result = computeRate(messages);
  // average of the two turns: (600+300) / (3+3) = 150
  assert.equal(result.rate, 150);
  assert.equal(result.turns, 2);
});

test("computeRate ignores sub-0.5s turns (timing noise)", () => {
  const messages = [
    { ts: 1000, type: "user", output: 0 },
    { ts: 1100, type: "assistant", output: 100 } // 0.1s → ignored
  ];
  assert.equal(computeRate(messages), null);
});

test("computeRate returns null when no assistant output", () => {
  assert.equal(computeRate([{ ts: 1000, type: "user", output: 0 }]), null);
  assert.equal(computeRate([]), null);
});

test("getSessionRate reads the session transcript and caches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "glm-rate-"));
  const projDir = path.join(root, "proj-y");
  await fs.mkdir(projDir, { recursive: true });

  const sessionId = "sess-abc";
  const base = Date.now();
  const transcript = [
    JSON.stringify({ type: "user", message: { role: "user" }, timestamp: new Date(base - 4000).toISOString() }),
    JSON.stringify({
      type: "assistant",
      message: { id: "a1", role: "assistant", usage: { output_tokens: 900 } },
      timestamp: new Date(base - 1000).toISOString()
    })
  ].join("\n") + "\n";
  await fs.writeFile(path.join(projDir, `${sessionId}.jsonl`), transcript);

  const cachePath = path.join(root, "rate.json");
  const result = await getSessionRate(sessionId, base, {
    projectsDir: root,
    cacheFile: cachePath,
    ttlMs: 60_000
  });
  assert.ok(result);
  // 900 output over 3s → 300/s
  assert.equal(result.rate, 300);

  // Cached: survives even after deleting the transcript.
  await fs.rm(path.join(projDir, `${sessionId}.jsonl`), { force: true });
  const cached = await getSessionRate(sessionId, base, {
    projectsDir: root,
    cacheFile: cachePath,
    ttlMs: 60_000
  });
  assert.equal(cached.rate, 300);

  await fs.rm(root, { recursive: true, force: true });
});

test("getSessionRate returns null for unknown session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "glm-rate-"));
  const cachePath = path.join(root, "rate.json");
  const result = await getSessionRate("does-not-exist", Date.now(), {
    projectsDir: root,
    cacheFile: cachePath,
    ttlMs: 60_000
  });
  assert.equal(result, null);
  await fs.rm(root, { recursive: true, force: true });
});

const SUCCESS_RESULT = {
  kind: "success",
  level: "Max",
  quotas: [{ key: "token_5h", leftPercent: 88, usedPercent: 12, nextResetTime: Date.now() + 3 * 3600_000 }],
  mcp: { leftPercent: 99, usedPercent: 1 }
};

test("status line renders the rate segment", () => {
  const out = stripAnsi(
    formatStatus(SUCCESS_RESULT, { sessionRate: { rate: 180, turns: 2, output: 540, durationSec: 3 } })
  );
  assert.match(out, /180 tok\/s/);
});

test("status line hides the rate segment when absent", () => {
  const out = stripAnsi(formatStatus(SUCCESS_RESULT, {}));
  assert.doesNotMatch(out, /tok\/s/);
});
