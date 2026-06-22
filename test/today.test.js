import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  scanTodayTotals,
  startOfLocalDay,
  dateKey,
  getTodayUsage
} from "../src/core/today/index.js";
import { formatTokens } from "../src/shared/utils.js";
import { formatStatus } from "../src/core/status/format.js";

const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, "");

function assistantLine(id, usage, isoTs) {
  return JSON.stringify({
    type: "assistant",
    message: { id, role: "assistant", usage },
    timestamp: isoTs
  });
}

async function makeTempProjects() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "glm-today-"));
  const projDir = path.join(root, "proj-x");
  await fs.mkdir(projDir, { recursive: true });
  return { root, projDir };
}

test("formatTokens auto-switches k / M", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(800), "0.8k");
  assert.equal(formatTokens(1200), "1.2k");
  assert.equal(formatTokens(45000), "45k");
  assert.equal(formatTokens(999000), "999k");
  assert.equal(formatTokens(1_000_000), "1.0M");
  assert.equal(formatTokens(2_222_298), "2.2M");
  assert.equal(formatTokens(48_196_000), "48.2M");
  assert.equal(formatTokens(undefined), "0");
  assert.equal(formatTokens(-5), "0");
});

test("dateKey is local YYYY-MM-DD", () => {
  const now = new Date("2026-06-18T22:00:00").getTime(); // local late evening
  assert.equal(dateKey(now), (() => {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })());
});

test("scanTodayTotals sums only today's assistant usage", async () => {
  const { root, projDir } = await makeTempProjects();
  const now = Date.now();
  const sinceMs = startOfLocalDay(now).getTime();

  const todayTs = new Date(now - 60_000).toISOString();
  const yesterdayTs = new Date(sinceMs - 60_000).toISOString();

  const content = [
    assistantLine("m-today", {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 100
    }, todayTs),
    assistantLine("m-yesterday", {
      input_tokens: 9999,
      output_tokens: 9999,
      cache_read_input_tokens: 9999,
      cache_creation_input_tokens: 9999
    }, yesterdayTs)
  ].join("\n") + "\n";

  await fs.writeFile(path.join(projDir, "sess.jsonl"), content);

  const { totals } = await scanTodayTotals(now, sinceMs, { projectsDir: root });
  assert.deepEqual(totals, { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100 });

  await fs.rm(root, { recursive: true, force: true });
});

test("scanTodayTotals de-duplicates entries sharing a message id", async () => {
  const { root, projDir } = await makeTempProjects();
  const now = Date.now();
  const sinceMs = startOfLocalDay(now).getTime();
  const ts = new Date(now - 30_000).toISOString();

  const dup = assistantLine("dup", {
    input_tokens: 100,
    output_tokens: 100,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 100
  }, ts);

  await fs.writeFile(path.join(projDir, "sess.jsonl"), `${dup}\n${dup}\n`);

  const { totals } = await scanTodayTotals(now, sinceMs, { projectsDir: root });
  assert.equal(totals.input, 100); // counted once despite duplicate lines

  await fs.rm(root, { recursive: true, force: true });
});

test("scanTodayTotals skips files not modified since local midnight", async () => {
  const { root, projDir } = await makeTempProjects();
  const now = Date.now();
  const sinceMs = startOfLocalDay(now).getTime();

  await fs.writeFile(
    path.join(projDir, "old.jsonl"),
    assistantLine("old", { input_tokens: 5000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, new Date(sinceMs - 86_400_000).toISOString())
  );
  // Set mtime to yesterday so the pre-filter skips it entirely.
  const yesterday = (sinceMs - 3600_000) / 1000;
  await fs.utimes(path.join(projDir, "old.jsonl"), yesterday, yesterday);

  const { totals, scanned } = await scanTodayTotals(now, sinceMs, { projectsDir: root });
  assert.equal(scanned, 0);
  assert.deepEqual(totals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

  await fs.rm(root, { recursive: true, force: true });
});

test("getTodayUsage caches results and survives a second call", async () => {
  const { root, projDir } = await makeTempProjects();
  const now = Date.now();
  const ts = new Date(now - 10_000).toISOString();
  await fs.writeFile(
    path.join(projDir, "sess.jsonl"),
    assistantLine("c1", { input_tokens: 250, output_tokens: 250, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ts)
  );

  const cachePath = path.join(root, "today.json");
  const first = await getTodayUsage(now, { projectsDir: root, cacheFile: cachePath, ttlMs: 60_000 });
  assert.equal(first.input, 250);

  // Cache file written.
  const cacheRaw = JSON.parse(await fs.readFile(cachePath, "utf8"));
  assert.equal(cacheRaw.date, dateKey(now));

  // Second call within TTL returns cached value (no recompute), even after
  // deleting the source transcript.
  await fs.rm(path.join(projDir, "sess.jsonl"), { force: true });
  const second = await getTodayUsage(now, { projectsDir: root, cacheFile: cachePath, ttlMs: 60_000 });
  assert.equal(second.input, 250);

  await fs.rm(root, { recursive: true, force: true });
});

const SUCCESS_RESULT = {
  kind: "success",
  level: "Max",
  quotas: [
    { key: "token_5h", leftPercent: 93, usedPercent: 7, nextResetTime: Date.now() + 3 * 3600_000 }
  ],
  mcp: { leftPercent: 99, usedPercent: 1 }
};

test("status line renders the today segment with four k values", () => {
  const out = stripAnsi(
    formatStatus(SUCCESS_RESULT, {
      todayUsage: { input: 1200, output: 800, cacheRead: 45000, cacheWrite: 3000 }
    })
  );
  assert.match(out, /今日 in 1\.2k out 0\.8k cr 45k cw 3\.0k/);
});

test("status line hides the today segment when there is no usage", () => {
  const out = stripAnsi(
    formatStatus(SUCCESS_RESULT, { todayUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  );
  assert.doesNotMatch(out, /今日/);
});

test("status line hides the today segment when todayUsage is absent", () => {
  const out = stripAnsi(formatStatus(SUCCESS_RESULT, {}));
  assert.doesNotMatch(out, /今日/);
});
