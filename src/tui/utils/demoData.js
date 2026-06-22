// Demo data matching the API response shape expected by buildStatusViewModel
export const DEMO_QUOTA_DATA = {
  kind: "success",
  level: "Lite",
  quotas: [
    {
      key: "token_5h",
      leftPercent: 91,
      usedPercent: 9,
      nextResetTime: Date.now() + 3 * 60 * 60 * 1000
    },
    {
      key: "token_week",
      leftPercent: 47,
      usedPercent: 53,
      nextResetTime: Date.now() + 4 * 24 * 60 * 60 * 1000
    }
  ],
  mcp: {
    leftPercent: 53,
    usedPercent: 47
  }
};

export const DEMO_CTX_MODEL = {
  usedPercent: 35,
  remainingPercent: 65,
  modelId: "glm-5.1",
  windowSize: 200_000,
  severity: "good"
};

// A premium model so the multiplier (倍率) segment renders in the TUI preview.
export const DEMO_MODEL_ID = "glm-5.2";

// Demo today-usage totals so the "today" segment renders in the TUI preview.
export const DEMO_TODAY_USAGE = {
  input: 1200,
  output: 800,
  cacheRead: 45000,
  cacheWrite: 3000
};

// Demo generation speed so the "rate" segment renders in the TUI preview.
export const DEMO_SESSION_RATE = { rate: 180, turns: 3, output: 540, durationSec: 3 };

// Snap the demo clock into the GLM peak window (14:00–18:00 UTC+8) so the
// preview always shows the 3x rate, regardless of the real wall-clock time.
export function demoPeakNow(realNow = Date.now()) {
  const UTC8 = 8 * 60 * 60 * 1000;
  const shifted = new Date(realNow + UTC8);
  shifted.setUTCHours(16, 0, 0, 0);
  return shifted.getTime() - UTC8;
}
