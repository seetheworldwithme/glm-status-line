// Real-time generation speed (output tokens / second) for the current Claude
// Code session, computed from its transcript file.
//
// The transcript records each assistant message with a `timestamp` and a
// `message.usage` object. We pair each assistant turn with the message that
// preceded it (the prompt/tool-result that triggered it), treat the gap as the
// turn's wall-clock duration, and divide output_tokens by it. We average the
// last few measurable turns to smooth single-turn jitter.
//
// This is decode throughput (output tokens/s), not total throughput — input
// and cache-read are prefilled in a burst and would massively overstate the
// rate. It reflects the most recent COMPLETED turn(s); a turn in flight is not
// in the transcript yet.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCacheRoot } from "../../shared/utils.js";

const TTL_MS = 10_000; // recompute at most every 10s
const TAIL_LINES = 200; // only the recent tail is needed for a live rate
const MIN_TURN_DUR_SEC = 0.5; // ignore sub-0.5s turns (timing noise)
const RECENT_TURNS = 3; // smooth over the last few turns

function projectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

function cacheFile() {
  return path.join(getCacheRoot(), "glm-status-line", "rate.json");
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Locate <sessionId>.jsonl under any project dir. Returns null if not found.
async function findSessionTranscript(sessionId, root = projectsDir()) {
  if (!sessionId) return null;
  const target = `${sessionId}.jsonl`;
  let projects;
  try {
    projects = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const full = path.join(root, proj.name, target);
    try {
      const stat = await fs.stat(full);
      if (stat.isFile()) return full;
    } catch {
      // not here — keep looking
    }
  }
  return null;
}

// Parse the tail of a transcript into {ts, type, output} entries, sorted.
function parseRecentMessages(content) {
  const lines = content.split("\n");
  const tail = lines.slice(-TAIL_LINES);
  const messages = [];

  for (const line of tail) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const ts = entry?.timestamp ? Date.parse(entry.timestamp) : null;
    if (!Number.isFinite(ts)) continue;

    const type = entry?.type || entry?.message?.role || "";
    const output = num(entry?.message?.usage?.output_tokens);
    messages.push({ ts, type, output });
  }

  messages.sort((a, b) => a.ts - b.ts);
  return messages;
}

// Build measurable turns (output tokens + duration) from message history, then
// average the last RECENT_TURNS. Returns null if nothing measurable.
function computeRate(messages) {
  const turns = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.type !== "assistant" || !m.output) continue;

    // Nearest preceding message with an earlier timestamp is the trigger.
    let prev = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (messages[j].ts < m.ts) {
        prev = messages[j];
        break;
      }
    }
    if (!prev) continue;

    const durationSec = (m.ts - prev.ts) / 1000;
    if (durationSec >= MIN_TURN_DUR_SEC) {
      turns.push({ output: m.output, durationSec });
    }
  }

  if (turns.length === 0) return null;

  const recent = turns.slice(-RECENT_TURNS);
  const output = recent.reduce((sum, t) => sum + t.output, 0);
  const durationSec = recent.reduce((sum, t) => sum + t.durationSec, 0);
  if (durationSec <= 0) return null;

  return {
    rate: Math.round(output / durationSec),
    turns: recent.length,
    output,
    durationSec
  };
}

// Cached accessor. `sessionId` comes from the status-line stdin. Never throws —
// returns null on any failure so the segment stays hidden gracefully.
export async function getSessionRate(sessionId, now = Date.now(), options = {}) {
  if (!sessionId) return null;
  const cachePath = options.cacheFile || cacheFile();
  const ttlMs = options.ttlMs ?? TTL_MS;

  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const cached = JSON.parse(raw);
    if (
      cached &&
      cached.sessionId === sessionId &&
      Number.isFinite(cached.computedAt) &&
      now - cached.computedAt < ttlMs
    ) {
      return cached.result;
    }
  } catch {
    // cache miss / corrupt — recompute
  }

  let result = null;
  try {
    const file = options.transcriptFile || (await findSessionTranscript(sessionId, options.projectsDir));
    if (file) {
      const content = await fs.readFile(file, "utf8");
      result = computeRate(parseRecentMessages(content));
    }
  } catch {
    result = null;
  }

  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({ sessionId, computedAt: now, result }), "utf8");
  } catch {
    // cache write failure is non-fatal
  }

  return result;
}

export { computeRate, parseRecentMessages, findSessionTranscript };
