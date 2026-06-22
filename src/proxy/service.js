// System-service management for the rate proxy: generate, install, and remove a
// launchd agent (macOS) or systemd user unit (Linux) so the proxy stays alive
// across reboots without a terminal.
//
// Platform-specific shell commands (launchctl / systemctl) are isolated behind
// an injectable `runner` so the logic is fully testable without touching the
// real service manager. `platform` is injectable for the same reason.
//
// The service runs `<node> <entry> proxy start` with no arguments — the proxy
// resolves its upstream + port from the tool config written by `proxy install`,
// so the service definition never holds credentials.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { getCacheRoot } from "../shared/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LAUNCHD_LABEL = "com.glm-status-line.proxy";
export const SYSTEMD_UNIT = "glm-status-line-proxy";

export function getProxyEntryPath() {
  // src/proxy/service.js → src/cli/index.js
  return path.resolve(__dirname, "..", "cli", "index.js");
}

export function getProxyLogPath() {
  return path.join(getCacheRoot(), "glm-status-line", "proxy.log");
}

export function getLaunchdPlistPath(home = "") {
  return path.join(home || process.env.HOME || "", "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function getSystemdUnitPath(home = "") {
  return path.join(home || process.env.HOME || "", ".config", "systemd", "user", `${SYSTEMD_UNIT}.service`);
}

// Build the proxy start command the service will run. Returns both an arg array
// (for plist ProgramArguments / systemd ExecStart argv) and a shell-quoted string.
export function buildProxyServiceCommand(nodePath = process.execPath, entryPath = getProxyEntryPath()) {
  const argv = [nodePath, entryPath, "proxy", "start"];
  const quoted = argv.map((a) => `"${a}"`).join(" ");
  return { argv, quoted };
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderLaunchdPlist(options = {}) {
  const { argv } = buildProxyServiceCommand(options.nodePath, options.entryPath);
  const logPath = options.logPath || getProxyLogPath();
  const programArguments = argv.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(options = {}) {
  const { quoted } = buildProxyServiceCommand(options.nodePath, options.entryPath);
  const logPath = options.logPath || getProxyLogPath();
  return `[Unit]
Description=glm-status-line streaming-rate proxy
After=network.target

[Service]
Type=simple
ExecStart=${quoted}
Restart=on-failure
RestartSec=3
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

// Write + load the service file for the current (or injected) platform. `runner`
// executes the platform's load command and must return { success, stderr }.
export async function installService(options = {}) {
  const platform = options.platform || process.platform;
  const fs = options.fs || (await import("node:fs/promises")).default;
  const runner = options.runner || defaultRunner;
  const nodePath = options.nodePath || process.execPath;

  if (platform === "darwin") {
    return installLaunchd({ fs, runner, nodePath, home: options.home, entryPath: options.entryPath });
  }

  if (platform === "linux") {
    return installSystemd({ fs, runner, nodePath, home: options.home, entryPath: options.entryPath });
  }

  return {
    installed: false,
    reason: "unsupported_platform",
    platform
  };
}

async function installLaunchd({ fs, runner, nodePath, home, entryPath }) {
  const plistPath = getLaunchdPlistPath(home);
  const content = renderLaunchdPlist({ nodePath, entryPath });
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.writeFile(plistPath, content, "utf8");

  // Unload any stale registration first (ignore errors), then load fresh.
  await runner(["launchctl", "unload", plistPath]);
  const result = await runner(["launchctl", "load", plistPath]);

  return {
    installed: result.success !== false,
    type: "launchd",
    path: plistPath,
    loadResult: result
  };
}

async function installSystemd({ fs, runner, nodePath, home, entryPath }) {
  const unitPath = getSystemdUnitPath(home);
  const content = renderSystemdUnit({ nodePath, entryPath });
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(unitPath, content, "utf8");

  const reload = await runner(["systemctl", "--user", "daemon-reload"]);
  const enable = await runner(["systemctl", "--user", "enable", "--now", `${SYSTEMD_UNIT}.service`]);

  return {
    installed: enable.success !== false && reload.success !== false,
    type: "systemd",
    path: unitPath,
    loadResult: enable
  };
}

// Stop + remove the service file.
export async function uninstallService(options = {}) {
  const platform = options.platform || process.platform;
  const fs = options.fs || (await import("node:fs/promises")).default;
  const runner = options.runner || defaultRunner;
  const home = options.home;

  if (platform === "darwin") {
    const plistPath = getLaunchdPlistPath(home);
    await runner(["launchctl", "unload", plistPath]);
    await safeRemove(fs, plistPath);
    return { removed: true, type: "launchd", path: plistPath };
  }

  if (platform === "linux") {
    await runner(["systemctl", "--user", "disable", "--now", `${SYSTEMD_UNIT}.service`]);
    const unitPath = getSystemdUnitPath(home);
    await safeRemove(fs, unitPath);
    await runner(["systemctl", "--user", "daemon-reload"]);
    return { removed: true, type: "systemd", path: unitPath };
  }

  return { removed: false, reason: "unsupported_platform", platform };
}

async function safeRemove(fs, filePath) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // already gone — fine
  }
}

async function defaultRunner(argv) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", () => resolve({ success: false, stderr }));
    child.on("close", (code) => resolve({ success: code === 0, stderr }));
  });
}
