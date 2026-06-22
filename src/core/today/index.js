// "Today" token usage, aggregated from Claude Code transcripts.
//
// Zhipu does not expose a daily-token-usage API (verified: only
// /monitor/usage/quota/limit exists, and it gives a 5-hour rolling percentage,
// not a natural-day total). So we sum `message.usage` across today's Claude Code
// transcript files under ~/.claude/projects/*/*.jsonl.
//
// Counts are Claude-Code-session throughput (input + output + cache_read +
// cache_creation), not GLM quota-weighted tokens — a real "how much I processed
// today" figure. Results are cached per local-day with a short TTL so frequent
// status-line refreshes don't re-scan the filesystem.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCacheRoot, padTwoDigits } from "../../shared/utils.js";

const TTL_MS = 60_000; // recompute at most once per minute

function projectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

function cacheFile() {
  return path.join(getCacheRoot(), "glm-status-line", "today.json");
}

function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateKey(now) {
  const d = startOfLocalDay(now);
  return `${d.getFullYear()}-${padTwoDigits(d.getMonth() + 1)}-${padTwoDigits(d.getDate())}`;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Sum the four usage buckets from every assistant message logged today across
// all Claude Code projects. `sinceMs` is local-midnight epoch ms.
async function scanTodayTotals(now, sinceMs, options = {}) {
  const root = options.projectsDir || projectsDir();
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let scanned = 0;

  let projects;
  try {
    projects = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { totals, scanned };
  }

  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    let files;
    try {
      files = await fs.readdir(path.join(root, proj.name));
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = path.join(root, proj.name, file);

      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      // Pre-filter: a file not modified since local midnight can't hold today's usage.
      if (stat.mtimeMs < sinceMs) continue;

      let content;
      try {
        content = await fs.readFile(full, "utf8");
      } catch {
        continue;
      }

      scanned += 1;
      const seen = new Set();

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let entry;
        try {
          entry = JSON.parse(trimmed);
        } catch {
          continue;
        }

        const usage = entry?.message?.usage;
        if (!usage) continue;

        // De-duplicate by message id in case a transcript records a turn twice.
        const id = entry?.message?.id;
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }

        // Keep only entries timestamped today; fall back to file mtime if absent.
        const ts = entry?.timestamp ? Date.parse(entry.timestamp) : stat.mtimeMs;
        if (Number.isFinite(ts) && ts < sinceMs) continue;

        totals.input += num(usage.input_tokens);
        totals.output += num(usage.output_tokens);
        totals.cacheRead += num(usage.cache_read_input_tokens);
        totals.cacheWrite += num(usage.cache_creation_input_tokens);
      }
    }
  }

  return { totals, scanned };
}

// Cached accessor: returns today's totals, recomputing only when the local day
// rolls over or the TTL elapses. Never throws — on any error returns zeros so
// the status line degrades gracefully (segment hidden when all zero).
export async function getTodayUsage(now = Date.now(), options = {}) {
  const key = dateKey(now);
  const cachePath = options.cacheFile || cacheFile();

  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const cached = JSON.parse(raw);
    if (
      cached &&
      cached.date === key &&
      Number.isFinite(cached.computedAt) &&
      now - cached.computedAt < (options.ttlMs ?? TTL_MS)
    ) {
      return cached.totals;
    }
  } catch {
    // cache miss / corrupt — recompute below
  }

  const sinceMs = startOfLocalDay(now).getTime();
  const { totals } = await scanTodayTotals(now, sinceMs, options);

  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({ date: key, computedAt: now, totals }),
      "utf8"
    );
  } catch {
    // cache write failure is non-fatal
  }

  return totals;
}

export function isTodayUsageNonZero(totals) {
  if (!totals) return false;
  return totals.input > 0 || totals.output > 0 || totals.cacheRead > 0 || totals.cacheWrite > 0;
}

// Exported for tests.
export { scanTodayTotals, dateKey, startOfLocalDay };
