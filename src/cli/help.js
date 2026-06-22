// Help text. The global printHelp() is hand-written and kept byte-stable for
// human users (a golden test locks it). The per-subcommand printHelpFor()
// derives focused help from the registry so adding a command only needs one
// edit in registry.js.

import { COMMAND_REGISTRY, COMMAND_GROUPS, resolvePositionals } from "./registry.js";

export function printHelp(output = process.stdout) {
  output.write(`glm-status-line

Usage:
  glm-status-line [--display left|used] [--json]
  glm-status-line [--style text|compact|bar] [--theme dark|light|mono]
  glm-status-line --version
  glm-status-line install [--force]
  glm-status-line uninstall
  glm-status-line version
  glm-status-line check-update
  glm-status-line commands [--json]
  glm-status-line config set style <text|compact|bar>
  glm-status-line config set display <left|used>
  glm-status-line config set theme <dark|light|mono>
  glm-status-line config set auth-token <token>
  glm-status-line config set base-url <url>
  glm-status-line config set work-days <1-7>
  glm-status-line config set minimalist <true|false>
  glm-status-line config set raw-values <true|false>
  glm-status-line config set reset-format <time|countdown>
  glm-status-line config set multiplier-premium-models <glm-5,glm-5.2>
  glm-status-line config set multiplier-peak-start <HH:MM>
  glm-status-line config set multiplier-peak-end <HH:MM>
  glm-status-line config set multiplier-peak <3.0>
  glm-status-line config set multiplier-off-peak <2.0>
  glm-status-line config set multiplier-promo-off-peak <1.0>
  glm-status-line config set multiplier-promo-expires <YYYY-MM-DD>
  glm-status-line config unset <style|display|theme|...|multiplier-*>
  glm-status-line config reset [--models] [--yes]
  glm-status-line config show
  glm-status-line model list
  glm-status-line model get <model-id>
  glm-status-line model set <model-id> <size>
  glm-status-line model remove <model-id>
  glm-status-line configure

When run without arguments, displays comprehensive quota usage (5h, week, MCP)
with full reset dates. Use --display to choose left or used metric.
Use --json to output structured JSON for scripting and automation.

When used as a Claude Code status line, shows a one-line status bar with the
5h quota, weekly quota, consumption multiplier (倍率, premium models only),
context window usage, and MCP usage.

Commands:
  install                 Install glm-status-line into Claude Code statusLine.command and SessionStart hooks.
  install --force         Replace an existing unmanaged status line and back it up.
  uninstall               Remove the managed status line and SessionStart hooks, and restore a backup if one exists.
  version                 Print the installed glm-status-line version.
  check-update            Check npm for a newer version and print the upgrade command.
  commands                List all commands; use --json for a machine-readable schema.
  config show             Print the current persisted config. Stored tokens are redacted.
  config set ...          Persist a display option or manual credential override.
  config unset ...        Remove one persisted config key.
  config reset            Reset user config to defaults. --models limits to model mappings.
                          Preserves install state. Prompts unless --yes.
  configure               Launch interactive TUI for component and global configuration.

Model commands:
  model list              List all models and their context window sizes.
  model get <id>          Show the context window size for a model.
  model set <id> <size>   Set a model's context window size (e.g. 300K or 300000).
  model remove <id>       Remove a custom model mapping (built-in models revert to default).

Pass a command before --help for focused help (e.g. model --help, config set --help).

Options:
  --style                 Output layout: text, compact, or bar (status line mode only).
  --display               Quota metric: left or used.
  --theme                 Theme preset: dark, light, or mono (status line mode only).
  --json                  Output quota as JSON (terminal mode only).
  --force                 Allow install to replace an unmanaged Claude status line.
  -v, --version           Show the installed version.
  -h, --help              Show this help text.

Examples:
  glm-status-line
  glm-status-line --display used
  glm-status-line --version
  glm-status-line check-update
  glm-status-line commands --json
  glm-status-line config set display used
  glm-status-line config set theme light
  glm-status-line config set auth-token <your-real-token>
  glm-status-line configure
  glm-status-line install
  glm-status-line model list
  glm-status-line model set glm-5.2 300K

Environment:
  ANTHROPIC_AUTH_TOKEN          Auth token for Zhipu GLM API (required).
  ANTHROPIC_BASE_URL            Base URL for quota API endpoint.
  GLM_STATUS_DEBUG=1             Enable debug logging for context window data (writes to stderr).
`);
}

// Render the args portion of a usage line, e.g. "<model-id> <size>".
function formatArgs(args = []) {
  return args
    .map((a) => {
      const name = a.required ? `<${a.name}>` : `[${a.name}]`;
      return name;
    })
    .join(" ");
}

function formatFlagsBlock(flags = []) {
  if (!flags.length) {
    return "";
  }
  return `\nFlags:\n${flags
    .map((f) => `  ${f.name.padEnd(22)} ${f.description}`)
    .join("\n")}\n`;
}

function formatCommandEntry(key) {
  const entry = COMMAND_REGISTRY[key];
  if (!entry) {
    return null;
  }
  const argPart = formatArgs(entry.args);
  const usage = argPart ? `glm-status-line ${entry.name} ${argPart}` : `glm-status-line ${entry.name}`;
  return { entry, usage };
}

// Focused help for a single command (e.g. "config set").
function renderCommandHelp(entry, output) {
  const argPart = formatArgs(entry.args);
  const usage = argPart ? `glm-status-line ${entry.name} ${argPart}` : `glm-status-line ${entry.name}`;
  const lines = [
    `glm-status-line ${entry.name}`,
    "",
    `${entry.summary}`,
    "",
    "Usage:",
    `  ${usage}`,
    ""
  ];

  if (entry.args && entry.args.length) {
    lines.push("Arguments:");
    for (const a of entry.args) {
      const tag = a.required ? "required" : "optional";
      const choices = a.choices ? `  (one of: ${a.choices.join(", ")})` : "";
      const fmt = a.format ? `  (format: ${a.format})` : "";
      lines.push(`  ${a.name.padEnd(14)} ${tag}${choices}${fmt}`);
    }
    lines.push("");
  }

  const flagsBlock = formatFlagsBlock(entry.flags);
  if (flagsBlock) {
    lines.push(flagsBlock.trimEnd());
    lines.push("");
  }

  lines.push(`Side effect: ${entry.sideEffect}`);

  if (entry.examples && entry.examples.length) {
    lines.push("", "Examples:");
    for (const ex of entry.examples) {
      lines.push(`  ${ex}`);
    }
  }

  lines.push("", "Run 'glm-status-line commands --json' for the full machine-readable schema.");
  output.write(`${lines.join("\n")}\n`);
}

// Focused help for a command group (e.g. "model", "config").
function renderGroupHelp(prefix, keys, output) {
  const entries = keys.map(formatCommandEntry).filter(Boolean);

  const lines = [
    `glm-status-line ${prefix}`,
    "",
    "Subcommands:",
    ""
  ];

  for (const { entry } of entries) {
    const sub = entry.name.replace(`${prefix} `, "");
    const argPart = formatArgs(entry.args);
    lines.push(`  ${sub}${argPart ? " " + argPart : ""}`);
    lines.push(`      ${entry.summary}  [${entry.sideEffect}]`);
    lines.push("");
  }

  lines.push("Usage:");
  for (const { usage } of entries) {
    lines.push(`  ${usage}`);
  }

  lines.push("", "Examples:");
  for (const { entry } of entries) {
    if (entry.examples && entry.examples[0]) {
      lines.push(`  ${entry.examples[0]}`);
    }
  }

  lines.push("", "Run 'glm-status-line commands --json' for the full machine-readable schema.");
  output.write(`${lines.join("\n")}\n`);
}

// Decide which help to print based on positionals. Empty -> global help;
// known command/group -> focused; unknown -> fall back to global help.
export function printHelpFor(positionals = [], output = process.stdout) {
  if (!positionals || positionals.length === 0) {
    printHelp(output);
    return;
  }

  const resolved = resolvePositionals(positionals);
  if (!resolved) {
    // Unknown positional with --help: fall back to global help rather than
    // erroring. The user is asking for help, not running a command.
    printHelp(output);
    return;
  }

  if (resolved.kind === "command") {
    renderCommandHelp(resolved.entry, output);
    return;
  }

  renderGroupHelp(resolved.prefix, resolved.keys, output);
}

// Used by the `commands` subcommand for the human-readable table.
export function renderCommandsTable(output = process.stdout) {
  const order = [
    "(default)",
    "version",
    "check-update",
    "commands",
    "config show",
    "config set",
    "config unset",
    "config reset",
    "model list",
    "model get",
    "model set",
    "model remove",
    "install",
    "uninstall",
    "configure"
  ];

  const rows = order
    .map((key) => COMMAND_REGISTRY[key])
    .filter(Boolean)
    .map((entry) => ({ name: entry.name, effect: entry.sideEffect, summary: entry.summary }));

  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const effectWidth = Math.max(...rows.map((r) => r.effect.length));

  const lines = ["glm-status-line commands", ""];
  lines.push(`  ${"name".padEnd(nameWidth)}  ${"effect".padEnd(effectWidth)}  summary`);
  for (const r of rows) {
    lines.push(`  ${r.name.padEnd(nameWidth)}  ${r.effect.padEnd(effectWidth)}  ${r.summary}`);
  }
  lines.push("");
  lines.push("Run 'glm-status-line commands --json' for the full machine-readable schema.");
  output.write(`${lines.join("\n")}\n`);
}
