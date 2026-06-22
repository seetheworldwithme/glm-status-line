// Live streaming-rate status file, written by the rate proxy and read by the
// status line. The proxy rewrites this file (atomically) on every tick while a
// response is streaming, so the short-lived status line process can pick up a
// near-real-time tok/s without doing any network work itself.
//
// Shape: { state, rate, outputTokens, startedAt, lastActivityAt, updatedAt }
//   state           — "streaming" | "idle"
//   rate            — instantaneous output tok/s over the sliding window (null if unknown)
//   outputTokens    — cumulative output tokens for the current turn
//   startedAt       — epoch ms when the current turn started
//   lastActivityAt  — epoch ms of the last SSE delta seen
//   updatedAt       — epoch ms when this file was last written

import path from "node:path";

import { getCacheRoot } from "../shared/utils.js";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile.js";
import { PROXY_STALE_MS } from "../shared/constants.js";

export function getLiveRateFilePath() {
  return path.join(getCacheRoot(), "glm-status-line", "live-rate.json");
}

export async function writeLiveRate(data, filePath = getLiveRateFilePath()) {
  await writeJsonFile(filePath, data);
}

export async function readLiveRate(filePath = getLiveRateFilePath()) {
  const data = await readJsonFile(filePath, null);
  if (!data || typeof data !== "object") {
    return null;
  }

  return data;
}

// The status line shows the proxy rate only while a turn is actively streaming
// AND the file is fresh (proxy is alive and writing). Otherwise it falls back
// to the transcript-based rate.
export function isLiveRateStreaming(data, now = Date.now()) {
  return Boolean(
    data &&
      data.state === "streaming" &&
      Number.isFinite(data.updatedAt) &&
      now - data.updatedAt < PROXY_STALE_MS &&
      Number.isFinite(data.rate) &&
      data.rate > 0
  );
}
