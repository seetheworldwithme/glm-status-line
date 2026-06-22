import os from "node:os";
import path from "node:path";

import {
  TOOL_CONFIG_MANAGED_BY,
  TOOL_CONFIG_SCHEMA_VERSION,
  isValidDisplayMode,
  isValidResetFormat,
  isValidStatusStyle,
  isValidTheme,
  isValidWorkDays
} from "../shared/constants.js";
import { migrateOldConfig, needsMigration } from "../shared/migration.js";
import { normalizeOptionalString } from "../shared/utils.js";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile.js";
import {
  DEFAULT_MULTIPLIER_CONFIG,
  isValidHhmm,
  isValidYmd,
  parseModelList
} from "../core/multiplier/index.js";

// Validate a user-supplied multiplier override object. Only well-formed fields
// are kept; runtime merges the result over DEFAULT_MULTIPLIER_CONFIG so missing
// fields fall back to the bundled defaults.
function normalizeMultiplierConfig(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const out = {};
  const premiumModels = parseModelList(value.premiumModels);
  if (premiumModels.length > 0) {
    out.premiumModels = premiumModels;
  }
  if (isValidHhmm(value.peakStart)) {
    out.peakStart = value.peakStart;
  }
  if (isValidHhmm(value.peakEnd)) {
    out.peakEnd = value.peakEnd;
  }
  if (typeof value.peak === "number" && Number.isFinite(value.peak) && value.peak > 0) {
    out.peak = value.peak;
  }
  if (typeof value.offPeak === "number" && Number.isFinite(value.offPeak) && value.offPeak > 0) {
    out.offPeak = value.offPeak;
  }
  if (
    typeof value.promoOffPeak === "number" &&
    Number.isFinite(value.promoOffPeak) &&
    value.promoOffPeak > 0
  ) {
    out.promoOffPeak = value.promoOffPeak;
  }
  if (isValidYmd(value.promoExpires)) {
    out.promoExpires = value.promoExpires;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function getClaudeDir() {
  return path.join(os.homedir(), ".claude");
}

export function getClaudeSettingsPath() {
  return path.join(getClaudeDir(), "settings.json");
}

export function getToolConfigPath() {
  return path.join(getClaudeDir(), "glm-status-line.json");
}

function redactSecret(value) {
  if (!value) {
    return value;
  }

  if (value.length <= 8) {
    return "<stored>";
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function normalizeToolConfig(config) {
  const base = config && typeof config === "object" ? config : {};
  const normalized = {
    schemaVersion: TOOL_CONFIG_SCHEMA_VERSION,
    managedBy: TOOL_CONFIG_MANAGED_BY,
    install: base.install && typeof base.install === "object" ? base.install : {}
  };

  if (isValidStatusStyle(base.style)) {
    normalized.style = base.style;
  }

  if (isValidDisplayMode(base.displayMode)) {
    normalized.displayMode = base.displayMode;
  }

  if (isValidTheme(base.theme)) {
    normalized.theme = base.theme;
  }

  if (isValidWorkDays(base.workDays)) {
    normalized.workDays = base.workDays;
  }

  if (typeof base.minimalist === "boolean") {
    normalized.minimalist = base.minimalist;
  }

  if (typeof base.rawValues === "boolean") {
    normalized.rawValues = base.rawValues;
  }

  if (isValidResetFormat(base.resetFormat)) {
    normalized.resetFormat = base.resetFormat;
  }

  const authToken = normalizeOptionalString(base.authToken);
  if (authToken) {
    normalized.authToken = authToken;
  }

  const baseUrl = normalizeOptionalString(base.baseUrl);
  if (baseUrl) {
    normalized.baseUrl = baseUrl;
  }

  // Real GLM upstream recorded by the rate-proxy installer. Used by loadConfig
  // to classify the host (isGLM/quotaUrl) when ANTHROPIC_BASE_URL points at the
  // local proxy (127.0.0.1).
  const upstreamBaseUrl = normalizeOptionalString(base.upstreamBaseUrl);
  if (upstreamBaseUrl) {
    normalized.upstreamBaseUrl = upstreamBaseUrl;
  }

  // Preserve rate-proxy settings (port, upstream override, service metadata).
  if (base.proxy && typeof base.proxy === "object") {
    const proxy = {};
    const port = Number(base.proxy.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      proxy.port = port;
    }
    const proxyUpstream = normalizeOptionalString(base.proxy.upstreamBaseUrl);
    if (proxyUpstream) {
      proxy.upstreamBaseUrl = proxyUpstream;
    }
    if (base.proxy.service && typeof base.proxy.service === "object") {
      proxy.service = base.proxy.service;
    }
    if (Object.keys(proxy).length > 0) {
      normalized.proxy = proxy;
    }
  }

  // Preserve lines (component-level config) as-is
  if (base.lines && Array.isArray(base.lines)) {
    normalized.lines = base.lines;
  }

  // Preserve modelMap (custom model context window sizes)
  if (base.modelMap && typeof base.modelMap === "object") {
    const validMap = {};
    for (const [modelId, size] of Object.entries(base.modelMap)) {
      if (typeof modelId === "string" && modelId && typeof size === "number" && size > 0 && Number.isFinite(size)) {
        validMap[modelId] = size;
      }
    }
    if (Object.keys(validMap).length > 0) {
      normalized.modelMap = validMap;
    }
  }

  // Preserve multiplier overrides (consumption rate for premium models).
  const multiplier = normalizeMultiplierConfig(base.multiplier);
  if (multiplier) {
    normalized.multiplier = multiplier;
  }

  return normalized;
}

// Set a value at a nested config path (e.g. ["multiplier", "peak"]). Used by
// `config set multiplier-*`. The whole config is re-normalized on write, so
// invalid multiplier fields are rejected here.
export async function setToolConfigPath(segments, value, configPath = getToolConfigPath()) {
  const current = await readToolConfig(configPath);
  const path = Array.isArray(segments) ? segments : [segments];
  if (path.length === 0) {
    return current;
  }

  let node = current;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    node[key] = node[key] && typeof node[key] === "object" ? node[key] : {};
    node = node[key];
  }
  node[path[path.length - 1]] = value;

  await writeToolConfig(current, configPath);
  return current;
}

export async function unsetToolConfigPath(segments, configPath = getToolConfigPath()) {
  const current = await readToolConfig(configPath);
  const path = Array.isArray(segments) ? segments : [segments];
  if (path.length === 0) {
    return current;
  }

  let node = current;
  for (let index = 0; index < path.length - 1; index += 1) {
    node = node?.[path[index]];
    if (!node || typeof node !== "object") {
      return current;
    }
  }
  delete node[path[path.length - 1]];

  await writeToolConfig(current, configPath);
  return current;
}

export async function readToolConfig(configPath = getToolConfigPath()) {
  const parsed = await readJsonFile(configPath, {});
  const normalized = normalizeToolConfig(parsed);

  // Migrate legacy ctxEnabled to lines-based format
  if (needsMigration(parsed)) {
    const migrated = migrateOldConfig({
      ctxEnabled: parsed.ctxEnabled,
      theme: parsed.theme,
      displayMode: parsed.displayMode,
      style: parsed.style
    });
    normalized.lines = migrated.lines;
    await writeJsonFile(configPath, normalizeToolConfig({ ...parsed, lines: migrated.lines }));
  }

  return normalized;
}

export async function writeToolConfig(config, configPath = getToolConfigPath()) {
  await writeJsonFile(configPath, normalizeToolConfig(config));
}

export function getDisplayToolConfig(config) {
  const displayConfig = structuredClone(normalizeToolConfig(config));
  if (displayConfig.authToken) {
    displayConfig.authToken = redactSecret(displayConfig.authToken);
  }

  return displayConfig;
}

export async function setToolConfigValue(key, value, configPath = getToolConfigPath()) {
  const current = await readToolConfig(configPath);
  current[key] = value;
  await writeToolConfig(current, configPath);
  return current;
}

export async function unsetToolConfigValue(key, configPath = getToolConfigPath()) {
  const current = await readToolConfig(configPath);
  delete current[key];
  await writeToolConfig(current, configPath);
  return current;
}

// Reset user config to defaults. Preserves install metadata (does not uninstall
// the status line), schemaVersion, and managedBy. With modelsOnly, only the
// user modelMap overlay is cleared (bundled seed still applies at runtime).
export async function resetToolConfig({ modelsOnly = false } = {}, configPath = getToolConfigPath()) {
  const current = await readToolConfig(configPath);
  const install =
    current.install && typeof current.install === "object" ? current.install : {};

  let reset;
  if (modelsOnly) {
    reset = { ...current };
    delete reset.modelMap;
  } else {
    reset = {
      schemaVersion: TOOL_CONFIG_SCHEMA_VERSION,
      managedBy: TOOL_CONFIG_MANAGED_BY,
      install
    };
  }

  await writeToolConfig(reset, configPath);
  return reset;
}
