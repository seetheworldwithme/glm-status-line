import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateMultiplier,
  computeMultiplierDisplay,
  formatMultiplier,
  isPeakTime,
  isPremiumModel,
  isPromoActive,
  isValidHhmm,
  isValidYmd,
  parseModelList,
  resolveMultiplierConfig,
  DEFAULT_MULTIPLIER_CONFIG
} from "../src/core/multiplier/index.js";
import { formatStatus } from "../src/core/status/format.js";

// Strip ANSI escape sequences so assertions match the visible text only.
const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, "");

// 2026-06-18 08:00 UTC == 16:00 UTC+8 (inside the 14:00–18:00 peak window)
const PEAK_NOW = new Date("2026-06-18T08:00:00Z").getTime();
// 2026-06-18 01:00 UTC == 09:00 UTC+8 (off-peak)
const OFF_PEAK_NOW = new Date("2026-06-18T01:00:00Z").getTime();

const SUCCESS_RESULT = {
  kind: "success",
  level: "Lite",
  quotas: [
    { key: "token_5h", leftPercent: 91, usedPercent: 9, nextResetTime: PEAK_NOW + 3 * 3600_000 },
    { key: "token_week", leftPercent: 47, usedPercent: 53, nextResetTime: PEAK_NOW + 4 * 86_400_000 }
  ],
  mcp: { leftPercent: 53, usedPercent: 47 }
};

test("formatMultiplier renders whole numbers without decimals", () => {
  assert.equal(formatMultiplier(3.0), "3x");
  assert.equal(formatMultiplier(2.0), "2x");
});

test("formatMultiplier renders fractional rates", () => {
  assert.equal(formatMultiplier(2.5), "2.5x");
  assert.equal(formatMultiplier(1.25), "1.25x");
});

test("calculateMultiplier returns 1.0 for non-premium models", () => {
  assert.equal(calculateMultiplier("glm-4.7", {}, PEAK_NOW), 1.0);
  assert.equal(calculateMultiplier("claude-sonnet", {}, PEAK_NOW), 1.0);
});

test("calculateMultiplier returns 1.0 when no model is provided", () => {
  assert.equal(calculateMultiplier(undefined, {}, PEAK_NOW), 1.0);
  assert.equal(calculateMultiplier("", {}, PEAK_NOW), 1.0);
});

test("calculateMultiplier applies the peak rate during peak hours", () => {
  assert.equal(calculateMultiplier("glm-5.2", {}, PEAK_NOW), DEFAULT_MULTIPLIER_CONFIG.peak);
});

test("calculateMultiplier applies the promo off-peak rate while promo is active", () => {
  // Promo is active through 2026-09-30; off-peak rate is the promo rate (1.0).
  assert.equal(calculateMultiplier("glm-5.2", {}, OFF_PEAK_NOW), DEFAULT_MULTIPLIER_CONFIG.promoOffPeak);
});

test("calculateMultiplier falls back to the regular off-peak rate after promo expires", () => {
  const expired = { promoExpires: "2000-01-01" };
  assert.equal(calculateMultiplier("glm-5.2", expired, OFF_PEAK_NOW), DEFAULT_MULTIPLIER_CONFIG.offPeak);
});

test("calculateMultiplier respects custom premium models", () => {
  assert.equal(calculateMultiplier("glm-4.7", { premiumModels: ["glm-4.7"] }, PEAK_NOW), 3.0);
});

test("computeMultiplierDisplay hides rates at or below 1.0", () => {
  assert.equal(computeMultiplierDisplay("glm-4.7", {}, PEAK_NOW), null);
  // Premium but promo-off-peak (1.0) is still hidden.
  assert.equal(computeMultiplierDisplay("glm-5.2", {}, OFF_PEAK_NOW), null);
});

test("computeMultiplierDisplay exposes the rate only for premium models above 1.0", () => {
  const display = computeMultiplierDisplay("glm-5.2", {}, PEAK_NOW);
  assert.deepEqual(display, { value: 3, text: "3x" });
});

test("isPeakTime treats the window endpoints as inclusive and uses UTC+8", () => {
  assert.strictEqual(isPeakTime("14:00", "18:00", PEAK_NOW), true);
  assert.strictEqual(isPeakTime("14:00", "18:00", OFF_PEAK_NOW), false);
  assert.strictEqual(isPeakTime("bad", "18:00", PEAK_NOW), null);
});

test("isPromoActive compares dates inclusively in UTC+8", () => {
  assert.equal(isPromoActive("2099-12-31", PEAK_NOW), true);
  assert.equal(isPromoActive("2000-01-01", PEAK_NOW), false);
  assert.equal(isPromoActive("not-a-date", PEAK_NOW), false);
});

test("isPremiumModel matches case-insensitively by substring", () => {
  assert.equal(isPremiumModel("GLM-5.2", ["glm-5.2"]), true);
  assert.equal(isPremiumModel("glm-5.2[1M]", ["glm-5.2"]), true);
  assert.equal(isPremiumModel("glm-4.7", ["glm-5"]), false);
});

test("validation helpers accept well-formed values", () => {
  assert.equal(isValidHhmm("14:00"), true);
  assert.equal(isValidHhmm("9:5"), false);
  assert.equal(isValidHhmm("25:00"), false);
  assert.equal(isValidYmd("2026-09-30"), true);
  assert.equal(isValidYmd("2026-13-01"), false);
});

test("parseModelList splits and trims a comma list", () => {
  assert.deepEqual(parseModelList("glm-5, glm-5.2 ,glm-5-turbo"), ["glm-5", "glm-5.2", "glm-5-turbo"]);
  assert.deepEqual(parseModelList(["a", " b "]), ["a", "b"]);
});

test("resolveMultiplierConfig layers overrides onto defaults", () => {
  const cfg = resolveMultiplierConfig({ peak: 5.0, peakStart: "10:00" });
  assert.equal(cfg.peak, 5.0);
  assert.equal(cfg.peakStart, "10:00");
  // Untouched fields keep their defaults.
  assert.equal(cfg.offPeak, DEFAULT_MULTIPLIER_CONFIG.offPeak);
});

test("status line renders the MCP consumption bar", () => {
  const out = stripAnsi(formatStatus(SUCCESS_RESULT, { now: PEAK_NOW }));
  assert.match(out, /MCP/);
  assert.match(out, /47%/);
});

test("status line renders 倍率 for a premium model during peak", () => {
  const out = stripAnsi(
    formatStatus(SUCCESS_RESULT, {
      now: PEAK_NOW,
      modelId: "glm-5.2",
      multiplierConfig: resolveMultiplierConfig()
    })
  );
  assert.match(out, /倍率 3x/);
});

test("status line hides 倍率 for a non-premium model", () => {
  const out = stripAnsi(
    formatStatus(SUCCESS_RESULT, {
      now: PEAK_NOW,
      modelId: "glm-4.7",
      multiplierConfig: resolveMultiplierConfig()
    })
  );
  assert.doesNotMatch(out, /倍率/);
});

test("status line hides 倍率 at or below 1x (promo off-peak)", () => {
  const out = stripAnsi(
    formatStatus(SUCCESS_RESULT, {
      now: OFF_PEAK_NOW,
      modelId: "glm-5.2",
      multiplierConfig: resolveMultiplierConfig()
    })
  );
  assert.doesNotMatch(out, /倍率/);
});
