// Sliding-window output-token rate, fed by the proxy's SSE parser.
//
// Anthropic streaming emits `message_delta` events whose `usage.output_tokens`
// is a *cumulative* count that updates as tokens are produced. We record each
// reading with its timestamp and compute instantaneous tok/s over a short
// sliding window (PROXY_RATE_WINDOW_MS). A periodic ticker rewrites the
// live-rate status file so the status line sees fresh values even between
// usage readings, and flips to "idle" once deltas stop arriving.
//
// This measures decode throughput only (output tokens), matching the existing
// transcript-based rate, but live instead of post-hoc.

import {
  PROXY_IDLE_TIMEOUT_MS,
  PROXY_RATE_WINDOW_MS,
  PROXY_WRITE_INTERVAL_MS
} from "../shared/constants.js";
import { writeLiveRate } from "./status.js";

export function createRateTracker(options = {}) {
  const nowFn = options.now ?? Date.now;
  const windowMs = options.windowMs ?? PROXY_RATE_WINDOW_MS;
  const writeIntervalMs = options.writeIntervalMs ?? PROXY_WRITE_INTERVAL_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? PROXY_IDLE_TIMEOUT_MS;
  const writeImpl = options.writeLiveRate ?? writeLiveRate;
  // The periodic writer is only useful when running on the real clock (it
  // advances live-rate staleness via Date.now()). Tests that drive synthetic
  // timestamps pass `ticker: false` so the writer never fires spuriously.
  const autoTick = options.ticker !== false;

  let readings = []; // { ts, cum } cumulative output_tokens readings, newest last
  let startedAt = null;
  let lastActivityAt = null;
  let lastCum = 0;
  let state = "idle"; // "streaming" | "idle"
  let lastRate = null; // rate of the most recently finished turn (for idle display)
  let writeTimer = null;

  function computeRate(now) {
    const cutoff = now - windowMs;
    readings = readings.filter((r) => r.ts >= cutoff);

    if (readings.length >= 2) {
      const first = readings[0];
      const last = readings[readings.length - 1];
      const dtSec = (last.ts - first.ts) / 1000;
      if (dtSec > 0) {
        return Math.round((last.cum - first.cum) / dtSec);
      }
    }

    // Window has fewer than 2 points — fall back to overall average since the
    // turn started, so early in a turn we still show something sensible.
    if (readings.length >= 1 && startedAt !== null) {
      const dtSec = (now - startedAt) / 1000;
      if (dtSec > 0.3) {
        return Math.round(readings[readings.length - 1].cum / dtSec);
      }
    }

    return null;
  }

  function snapshot(now) {
    const ts = now ?? nowFn();
    const rate = state === "streaming" ? computeRate(ts) : lastRate;
    return {
      state,
      rate: Number.isFinite(rate) ? rate : null,
      outputTokens: lastCum,
      startedAt,
      lastActivityAt,
      updatedAt: ts
    };
  }

  function flush(now) {
    // Fire-and-forget; a write failure must never break streaming.
    Promise.resolve(writeImpl(snapshot(now))).catch(() => {});
  }

  function startTicker() {
    if (writeTimer) {
      return;
    }
    writeTimer = setInterval(() => {
      const now = nowFn();
      // Auto-flip to idle if no delta has arrived for a while (e.g. stream
      // ended without a clean message_stop).
      if (state === "streaming" && lastActivityAt !== null && now - lastActivityAt > idleTimeoutMs) {
        state = "idle";
      }
      flush(now);
    }, writeIntervalMs);
    if (writeTimer.unref) {
      writeTimer.unref();
    }
  }

  function stopTicker() {
    if (writeTimer) {
      clearInterval(writeTimer);
      writeTimer = null;
    }
  }

  return {
    onMessageStart(now) {
      const ts = now ?? nowFn();
      readings = [];
      startedAt = ts;
      lastActivityAt = ts;
      lastCum = 0;
      lastRate = null;
      state = "streaming";
      if (autoTick) {
        startTicker();
      }
      flush(ts);
    },

    onMessageDelta(cumTokens, now) {
      const ts = now ?? nowFn();
      lastActivityAt = ts;
      if (!Number.isFinite(cumTokens) || cumTokens < 0) {
        return;
      }
      const prev = readings.length ? readings[readings.length - 1].cum : -1;
      if (cumTokens !== prev) {
        readings.push({ ts, cum: cumTokens });
        lastCum = cumTokens;
      }
    },

    onTextDelta(now) {
      // content_block_delta: pure activity signal — keeps state "streaming"
      // alive between sparse usage readings.
      lastActivityAt = now ?? nowFn();
    },

    onMessageStop(now) {
      const ts = now ?? nowFn();
      lastActivityAt = ts;
      // Final average over the whole turn becomes the idle display rate.
      if (startedAt !== null) {
        const dtSec = (ts - startedAt) / 1000;
        if (dtSec > 0) {
          lastRate = Math.round(lastCum / dtSec);
        }
      }
      state = "idle";
      flush(ts);
    },

    snapshot,
    stop() {
      stopTicker();
    }
  };
}
