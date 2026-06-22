// Consumption multiplier (消耗倍率) for premium GLM models.
//
// Ported from glm-plan-usage (Rust) so this package can show the same peak /
// off-peak / promotional rate that the GLM Coding Plan charges for premium
// models. All time comparisons are done in UTC+8 (Beijing) because GLM's peak
// window 14:00–18:00 is defined in that timezone — using local time would make
// the multiplier wrong for anyone outside UTC+8.
//
// Display rule: the multiplier is only shown when the current model is premium
// AND the resolved rate is > 1.0 (matches "仅 premium 模型且 > 1x 时显示").

const UTC_PLUS_8_OFFSET_MS = 8 * 60 * 60 * 1000;

export const DEFAULT_MULTIPLIER_CONFIG = {
  premiumModels: ["glm-5", "glm-5.1", "glm-5.2", "glm-5-turbo"],
  peakStart: "14:00",
  peakEnd: "18:00",
  peak: 3.0,
  offPeak: 2.0,
  promoOffPeak: 1.0,
  promoExpires: "2026-09-30"
};

// Returns true when the multiplier segment should ever render (i.e. when the
// feature is reachable at all). Kept distinct from per-frame hide logic.
export function isPremiumModel(modelId, premiumModels = []) {
  if (typeof modelId !== "string" || !modelId) {
    return false;
  }
  const lower = modelId.toLowerCase();
  return premiumModels.some(
    (pm) => typeof pm === "string" && pm.length > 0 && lower.includes(pm.toLowerCase())
  );
}

function parseHhmm(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

export function isValidHhmm(value) {
  return parseHhmm(value) !== null;
}

export function isValidYmd(value) {
  if (typeof value !== "string") {
    return false;
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return false;
  }
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

// UTC+8 clock for a given epoch-ms. Fixed-offset math (not local time) so the
// peak window is correct regardless of the user's machine timezone.
function utc8Clock(now) {
  const shifted = new Date(now + UTC_PLUS_8_OFFSET_MS);
  const hours = shifted.getUTCHours();
  const minutes = shifted.getUTCMinutes();
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return {
    minutesSinceMidnight: hours * 60 + minutes,
    dateStr: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  };
}

// Returns true / false when the window is valid, or null when the configured
// times are malformed (in which case the caller treats it as "no peak info").
export function isPeakTime(peakStart, peakEnd, now = Date.now()) {
  const start = parseHhmm(peakStart);
  const end = parseHhmm(peakEnd);
  if (start === null || end === null) {
    return null;
  }
  const current = utc8Clock(now).minutesSinceMidnight;
  return current >= start && current <= end;
}

// Promo is active through (and including) its expiry date, evaluated in UTC+8.
export function isPromoActive(promoExpires, now = Date.now()) {
  if (!isValidYmd(promoExpires)) {
    return false;
  }
  return utc8Clock(now).dateStr <= promoExpires;
}

export function resolveMultiplierConfig(config = {}) {
  return { ...DEFAULT_MULTIPLIER_CONFIG, ...(config && typeof config === "object" ? config : {}) };
}

// Resolved rate for a model at a given time. Non-premium or unparseable config
// always yields 1.0 (i.e. not shown).
export function calculateMultiplier(modelId, config = {}, now = Date.now()) {
  const cfg = resolveMultiplierConfig(config);

  if (!isPremiumModel(modelId, cfg.premiumModels)) {
    return 1.0;
  }

  const peak = isPeakTime(cfg.peakStart, cfg.peakEnd, now);
  if (peak === null) {
    return 1.0;
  }
  if (peak) {
    return cfg.peak;
  }

  return isPromoActive(cfg.promoExpires, now) ? cfg.promoOffPeak : cfg.offPeak;
}

// "3x" for whole numbers, "2.5x" otherwise. Mirrors glm-plan-usage formatting.
export function formatMultiplier(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (Number.isInteger(value)) {
    return `${value}x`;
  }
  return `${Number(value.toFixed(2))}x`;
}

// Returns { value, text } only when the rate should be displayed — premium and
// strictly greater than 1.0. Otherwise null (segment stays hidden).
export function computeMultiplierDisplay(modelId, config = {}, now = Date.now()) {
  const value = calculateMultiplier(modelId, config, now);
  if (!(value > 1.0)) {
    return null;
  }
  const text = formatMultiplier(value);
  return text ? { value, text } : null;
}

// Parse a comma-separated premium model list, e.g. "glm-5, glm-5.2".
export function parseModelList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
