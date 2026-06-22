// `proxy install` / `proxy uninstall` orchestration. Install wires three things
// together so the proxy runs as a system service and Claude Code talks to it:
//
//   1. Record the real GLM upstream (current ANTHROPIC_BASE_URL) into the tool
//      config so loadConfig can still classify the host (isGLM/quotaUrl) once
//      the base URL becomes the local proxy.
//   2. Rewrite Claude Code's settings.json env so ANTHROPIC_BASE_URL points at
//      the proxy (http://127.0.0.1:<port>). ANTHROPIC_AUTH_TOKEN is untouched
//      — Claude Code still attaches it; the proxy forwards it.
//   3. Install + load the launchd/systemd service that runs `proxy start`.
//
// Uninstall reverses all three, restoring the previous base URL from a backup.
//
// The previous base URL is backed up in the tool config (proxy.service.previousBaseUrl)
// so uninstall can restore the exact value even if the user edits things in
// between.

import { DEFAULT_PROXY_PORT } from "../shared/constants.js";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile.js";
import {
  getToolConfigPath,
  readToolConfig,
  writeToolConfig
} from "../claude/settings.js";
import { getClaudeSettingsPath } from "../claude/settings.js";
import { installService, uninstallService } from "./service.js";

function isLocalProxyUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const host = new URL(url).host.toLowerCase();
    return host.startsWith("127.0.0.1") || host.startsWith("localhost") || host.startsWith("[::1]");
  } catch {
    return false;
  }
}

function proxyUrlForPort(port) {
  return `http://127.0.0.1:${port}`;
}

export async function installProxy(options = {}) {
  const fs = options.fs || (await import("node:fs/promises")).default;
  const settingsPath = options.settingsPath || getClaudeSettingsPath();
  const configPath = options.configPath || getToolConfigPath();
  const platform = options.platform || process.platform;
  const nodePath = options.nodePath || process.execPath;

  const settings = await readJsonFile(settingsPath, {});
  const settingsEnv = settings.env && typeof settings.env === "object" ? settings.env : {};
  const currentBaseUrl = typeof settingsEnv.ANTHROPIC_BASE_URL === "string" ? settingsEnv.ANTHROPIC_BASE_URL : "";

  const toolConfig = await readToolConfig(configPath);
  const port = Number(toolConfig.proxy?.port) || DEFAULT_PROXY_PORT;

  // Resolve the REAL GLM upstream. If the settings already point at the local
  // proxy (re-install), use the previously stored upstream instead.
  let upstream = "";
  let previousBaseUrl = null;
  if (isLocalProxyUrl(currentBaseUrl)) {
    upstream = toolConfig.upstreamBaseUrl || toolConfig.proxy?.upstreamBaseUrl || "";
    previousBaseUrl = toolConfig.proxy?.service?.previousBaseUrl || upstream || null;
  } else {
    upstream = currentBaseUrl;
    previousBaseUrl = currentBaseUrl || null;
  }

  if (!upstream) {
    return {
      installed: false,
      reason: "no_upstream",
      hint:
        "Set ANTHROPIC_BASE_URL to your GLM endpoint in ~/.claude/settings.json first, then re-run `glm-status-line proxy install`."
    };
  }

  const proxyUrl = proxyUrlForPort(port);

  // 1. Persist upstream + port + backup in tool config.
  const nextToolConfig = {
    ...toolConfig,
    upstreamBaseUrl: upstream,
    proxy: {
      ...(toolConfig.proxy || {}),
      port,
      upstreamBaseUrl: upstream,
      service: {
        ...(toolConfig.proxy?.service || {}),
        previousBaseUrl,
        port
      }
    }
  };
  await writeToolConfig(nextToolConfig, configPath);

  // 2. Rewrite Claude Code settings.json env to point at the proxy.
  settingsEnv.ANTHROPIC_BASE_URL = proxyUrl;
  settings.env = settingsEnv;
  await writeJsonFile(settingsPath, settings);

  // 3. Install + load the system service.
  const serviceResult = await installService({
    fs,
    runner: options.runner,
    platform,
    nodePath,
    home: options.home,
    entryPath: options.entryPath
  });

  return {
    installed: serviceResult.installed !== false,
    upstream,
    proxyUrl,
    port,
    previousBaseUrl,
    settingsPath,
    configPath,
    service: serviceResult
  };
}

export async function uninstallProxy(options = {}) {
  const fs = options.fs || (await import("node:fs/promises")).default;
  const settingsPath = options.settingsPath || getClaudeSettingsPath();
  const configPath = options.configPath || getToolConfigPath();
  const platform = options.platform || process.platform;

  const settings = await readJsonFile(settingsPath, {});
  const settingsEnv = settings.env && typeof settings.env === "object" ? settings.env : {};
  const toolConfig = await readToolConfig(configPath);

  // Restore the previous base URL (fallback to the stored upstream).
  const restoreTo =
    toolConfig.proxy?.service?.previousBaseUrl ||
    toolConfig.upstreamBaseUrl ||
    toolConfig.proxy?.upstreamBaseUrl ||
    "";

  const currentlyProxied = isLocalProxyUrl(settingsEnv.ANTHROPIC_BASE_URL);

  if (currentlyProxied && restoreTo) {
    settingsEnv.ANTHROPIC_BASE_URL = restoreTo;
    settings.env = settingsEnv;
    await writeJsonFile(settingsPath, settings);
  }

  // Drop proxy config + upstream from the tool config (keep everything else).
  const nextToolConfig = { ...toolConfig };
  delete nextToolConfig.upstreamBaseUrl;
  if (nextToolConfig.proxy) {
    delete nextToolConfig.proxy;
  }
  await writeToolConfig(nextToolConfig, configPath);

  const serviceResult = await uninstallService({
    fs,
    runner: options.runner,
    platform,
    home: options.home
  });

  return {
    removed: true,
    restoredBaseUrl: currentlyProxied ? restoreTo : null,
    settingsTouched: currentlyProxied,
    settingsPath,
    configPath,
    service: serviceResult
  };
}
