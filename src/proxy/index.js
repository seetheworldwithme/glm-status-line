// Proxy orchestration helpers shared by the CLI (`proxy start`, `proxy status`)
// and, later, the system-service installer.
//
// Resolution order for where the proxy forwards to (upstream) and which port it
// listens on:
//   1. explicit CLI args (--upstream / --port)
//   2. tool config `~/.claude/glm-status-line.json` → proxy.upstreamBaseUrl / proxy.port
//   3. the tool config's top-level upstreamBaseUrl (set by `proxy install`)
//   4. the ANTHROPIC_BASE_URL currently in effect (env / Claude settings)
//
// The auth token is deliberately NOT resolved here: Claude Code already sends
// it as a header on every request, and the proxy just forwards that header.

import { DEFAULT_PROXY_PORT } from "../shared/constants.js";
import { loadConfig } from "../shared/config.js";
import { readToolConfig } from "../claude/settings.js";
import { normalizeOptionalString } from "../shared/utils.js";

function normalizePort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    return null;
  }
  return n;
}

export async function resolveProxyOptions(args = {}, dependencies = {}) {
  const userConfig = await readToolConfig(dependencies.configPath);
  const config = await loadConfig(process.env, userConfig, { claudeSettingsPath: dependencies.claudeSettingsPath });

  const upstream =
    normalizeOptionalString(args.upstream) ||
    normalizeOptionalString(userConfig.proxy?.upstreamBaseUrl) ||
    normalizeOptionalString(userConfig.upstreamBaseUrl) ||
    config.upstreamBaseUrl ||
    config.baseUrl;

  const port =
    normalizePort(args.port) ||
    normalizePort(userConfig.proxy?.port) ||
    DEFAULT_PROXY_PORT;

  return { upstream, port, config };
}
