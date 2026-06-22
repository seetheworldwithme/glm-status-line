// `glm-status-line proxy` — manage the local streaming-rate proxy.
//
// Phase 1 surface:
//   proxy            — show usage
//   proxy start      — run the proxy in the foreground (Ctrl+C to stop)
//   proxy status     — print the latest live-rate snapshot from the status file
//
// Phase 2 adds `proxy install` / `proxy uninstall` (system service + rewriting
// ANTHROPIC_BASE_URL). `start` is the foreground fallback regardless.

import { startProxyServer } from "../proxy/server.js";
import { resolveProxyOptions } from "../proxy/index.js";
import { readLiveRate, getLiveRateFilePath } from "../proxy/status.js";
import { installProxy, uninstallProxy } from "../proxy/installer.js";
import { printHelpFor } from "./help.js";

export async function handleProxyCommand(subcommand, args, output = process.stdout, dependencies = {}) {
  if (subcommand === "start") {
    return startProxy(args, output, dependencies);
  }

  if (subcommand === "status") {
    return proxyStatus(output);
  }

  if (subcommand === "install") {
    return proxyInstall(output, dependencies);
  }

  if (subcommand === "uninstall") {
    return proxyUninstall(output, dependencies);
  }

  printHelpFor(["proxy"], output);
  return true;
}

async function startProxy(args, output, dependencies) {
  const { port, upstream } = await resolveProxyOptions(args, dependencies);

  if (!upstream) {
    output.write(
      "No upstream base URL configured.\n" +
        "Set it explicitly, or point ANTHROPIC_BASE_URL at GLM:\n\n" +
        "  glm-status-line proxy start --upstream https://open.bigmodel.cn/api/anthropic\n\n" +
        "(Phase 2's `proxy install` will wire this up and rewrite ANTHROPIC_BASE_URL for you.)\n"
    );
    process.exitCode = 1;
    return true;
  }

  const { tracker } = await startProxyServer({
    port,
    upstream,
    debug: process.env.GLM_STATUS_DEBUG === "1"
  });

  output.write(`glm-status-line proxy listening on http://127.0.0.1:${port} → ${upstream}\n`);
  output.write(`Live tok/s → ${getLiveRateFilePath()}\n`);
  output.write("Forwarding requests to GLM and measuring streaming output tok/s. Press Ctrl+C to stop.\n");

  const shutdown = () => {
    tracker.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The listening server keeps the event loop alive; this call does not return.
  return true;
}

async function proxyStatus(output) {
  const live = await readLiveRate();
  if (!live) {
    output.write("Proxy is not running (no live-rate data found).\n");
    return true;
  }

  output.write(`state:        ${live.state}\n`);
  output.write(`rate:         ${live.rate == null ? "-" : `${live.rate} tok/s`}\n`);
  output.write(`output tokens: ${live.outputTokens ?? 0} (this turn)\n`);
  if (Number.isFinite(live.updatedAt)) {
    output.write(`updated:      ${new Date(live.updatedAt).toISOString()}\n`);
  }
  return true;
}

async function proxyInstall(output, dependencies = {}) {
  const result = await installProxy({
    settingsPath: dependencies.settingsPath,
    configPath: dependencies.configPath,
    runner: dependencies.runner,
    platform: dependencies.platform,
    home: dependencies.home,
    nodePath: dependencies.nodePath,
    entryPath: dependencies.entryPath
  });

  if (!result.installed) {
    if (result.reason === "no_upstream") {
      output.write(`Could not install: no GLM upstream found.\n${result.hint || ""}\n`);
    } else {
      output.write(
        `Install incomplete: the service could not be loaded on this platform (${result.service?.reason || "unknown"}).\n`
      );
      output.write(
        `Claude Code's base URL was set to ${result.proxyUrl}. Run 'glm-status-line proxy uninstall' to revert, or start the proxy manually with 'glm-status-line proxy start'.\n`
      );
    }
    process.exitCode = 1;
    return true;
  }

  output.write("Installed the streaming-rate proxy.\n");
  output.write(`  Claude Code → ${result.proxyUrl} → ${result.upstream}\n`);
  output.write(`  service:    ${result.service.type} (${result.service.path})\n`);
  output.write(`  previous ANTHROPIC_BASE_URL backed up: ${result.previousBaseUrl || "(none)"}\n`);
  output.write(
    "\nThe proxy is now running and will auto-start on login. Restart Claude Code so it picks up the new base URL.\n"
  );
  output.write("Live tok/s will appear in the status bar during generation. To undo: glm-status-line proxy uninstall\n");
  return true;
}

async function proxyUninstall(output, dependencies = {}) {
  const result = await uninstallProxy({
    settingsPath: dependencies.settingsPath,
    configPath: dependencies.configPath,
    runner: dependencies.runner,
    platform: dependencies.platform,
    home: dependencies.home
  });

  output.write("Uninstalled the streaming-rate proxy.\n");
  if (result.settingsTouched && result.restoredBaseUrl) {
    output.write(`  ANTHROPIC_BASE_URL restored to: ${result.restoredBaseUrl}\n`);
  } else {
    output.write("  ANTHROPIC_BASE_URL was not pointing at the proxy; left untouched.\n");
  }
  output.write(`  service removed: ${result.service?.type || "(n/a)"}\n`);
  output.write("Restart Claude Code so it talks to GLM directly again.\n");
  return true;
}
