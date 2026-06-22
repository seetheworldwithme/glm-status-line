import {
  isValidStatusStyle,
  normalizeDisplayMode,
  normalizeTheme,
  STATUS_BAR_CHARACTERS,
  COMPONENT_TYPES,
  normalizeConfig
} from "../../shared/constants.js";
import { buildBar } from "../../shared/bar.js";
import { formatTokens } from "../../shared/utils.js";
import { applyTheme } from "./theme.js";
import { buildStatusViewModel } from "./viewModel.js";
import { createRenderData } from "../context/index.js";

export { buildBar };

class ComponentRenderer {
  constructor(model, globalConfig, style) {
    this.model = model;
    this.global = globalConfig;
    this.style = style;
  }

  shouldShowLabel() {
    return !this.global.minimalist && !this.global.rawValues;
  }

  barMetric(quota) {
    const mode = normalizeDisplayMode(this.global.displayMode);
    if (mode === "used") {
      return { percent: quota.usedPercent, text: quota.usedText };
    }
    return { percent: quota.leftPercent, text: quota.leftText };
  }
}

class ModelRenderer extends ComponentRenderer {
  render(config) {
    if (this.global.minimalist || this.global.rawValues) {
      return null;
    }

    return [
      { text: this.model.levelLabel, tone: "label" }
    ];
  }
}

class PrimaryQuotaRenderer extends ComponentRenderer {
  render(config, ctxModel, enabledTypes) {
    const quota = this.model.primaryQuota;
    if (!quota || !Number.isFinite(quota.leftPercent)) {
      return null;
    }

    const tone = this.model.severity;
    const style = this.style || "bar";
    const showLabel = this.shouldShowLabel();

    if (style === "bar") {
      const metric = this.barMetric(quota);
      const bar = buildBar(metric.percent);

      const showModelLabel = showLabel && this.model.levelLabel && !enabledTypes?.has(COMPONENT_TYPES.MODEL);

      const segments = [];
      if (showModelLabel) {
        segments.push({ text: this.model.levelLabel, tone: "label" });
        segments.push({ text: " ", tone: "plain" });
      }

      segments.push(
        { text: bar.filledText, tone },
        { text: bar.emptyText, tone: "barEmpty" },
        { text: " ", tone: "plain" },
        { text: metric.text, tone }
      );

      return segments;
    }

    if (style === "compact") {
      const segments = [];
      const showModelLabel = showLabel && this.model.compactLabel && !enabledTypes?.has(COMPONENT_TYPES.MODEL);

      if (showModelLabel) {
        segments.push({ text: this.model.compactLabel, tone: "label" });
        segments.push({ text: " ", tone: "plain" });
      }

      segments.push(
        { text: `${quota.label} `, tone: "muted" },
        { text: quota.leftText, tone }
      );
      return segments;
    }

    return this.renderText(quota, tone, showLabel);
  }

  renderText(quota, tone, showLabel) {
    const mode = normalizeDisplayMode(this.global.displayMode);

    if (mode === "used") {
      return [
        { text: `${quota.label} used `, tone: "muted" },
        { text: quota.usedText, tone }
      ];
    }

    return [
      { text: `${quota.label} `, tone: "muted" },
      { text: quota.leftText, tone }
    ];
  }
}

class WeeklyQuotaRenderer extends ComponentRenderer {
  render(config) {
    if (!this.model.secondaryQuota) {
      return null;
    }

    const quota = this.model.secondaryQuota;
    const tone = this.model.secondarySeverity;
    const style = this.style || "bar";
    const showLabel = this.shouldShowLabel();
    const resetText = this.model.weeklyResetText;

    if (style === "bar") {
      const metric = this.barMetric(quota);

      if (Number.isFinite(this.model.secondaryTheoreticalBudget)) {
        const barData = buildWeeklyBar(quota.usedPercent, this.model.secondaryTheoreticalBudget);
        const segments = [
          { text: `${quota.compactLabel} `, tone: "muted" },
          { text: barData.filledText, tone },
          { text: barData.shadeText, tone: `shade_${tone}` },
          { text: barData.emptyText, tone: "barEmpty" },
          { text: " ", tone: "plain" },
          { text: metric.text, tone }
        ];
        if (resetText) {
          segments.push({ text: ` ${resetText}`, tone: "reset" });
        }
        return segments;
      }

      const segments = [
        { text: `${quota.compactLabel} `, tone: "muted" },
        { text: quota.leftText, tone }
      ];
      if (resetText) {
        segments.push({ text: ` ${resetText}`, tone: "reset" });
      }
      return segments;
    }

    if (style === "compact") {
      const segments = [
        { text: `${quota.compactLabel} `, tone: "muted" },
        { text: quota.leftText, tone }
      ];
      if (resetText) {
        segments.push({ text: ` ${resetText}`, tone: "reset" });
      }
      return segments;
    }

    const segments = [
      { text: `${quota.label} `, tone: "muted" },
      { text: quota.leftText, tone }
    ];
    if (resetText) {
      segments.push({ text: ` ${resetText}`, tone: "reset" });
    }
    return segments;
  }
}

class ResetTimeRenderer extends ComponentRenderer {
  render(config) {
    if (!this.model.resetText) {
      return null;
    }

    const style = this.style;
    const showLabel = this.shouldShowLabel() && style !== "bar" && style !== "compact";
    const resetTone = "reset";

    if (showLabel) {
      return [
        { text: " | reset ", tone: "muted" },
        { text: this.model.resetText, tone: resetTone }
      ];
    }

    return [
      { text: " | ", tone: "muted" },
      { text: this.model.resetText, tone: resetTone }
    ];
  }
}

// Consumption rate (倍率) for premium models. The view model only populates
// `multiplier` when the model is premium AND the current rate exceeds 1.0, so
// this renderer simply hides itself otherwise — enforcing "仅 premium 模型且
// > 1x 时显示" at the display layer.
class MultiplierRenderer extends ComponentRenderer {
  render(config) {
    const multiplier = this.model.multiplier;
    if (!multiplier || !multiplier.text) {
      return null;
    }

    const showLabel = this.shouldShowLabel();
    const lead = showLabel ? " | 倍率 " : " | ";
    return [
      { text: lead, tone: "muted" },
      { text: multiplier.text, tone: "multiplier" }
    ];
  }
}

class ContextRenderer extends ComponentRenderer {
  render(config, ctxModel) {
    if (!ctxModel || this.style === "compact") {
      return null;
    }

    const style = this.style || "bar";
    const renderData = createRenderData(ctxModel, style);
    if (!renderData) {
      return null;
    }

    const { percentText, suffix, bar } = renderData;
    const severity = ctxModel.severity || "neutral";

    if (style === "bar" && bar) {
      return [
        { text: " | ctx ", tone: "muted" },
        { text: bar.filledText, tone: severity },
        { text: bar.emptyText, tone: "barEmpty" },
        { text: " ", tone: "plain" },
        { text: percentText, tone: severity },
        { text: suffix, tone: "muted" }
      ];
    }

    return [
      { text: " | ctx ", tone: "muted" },
      { text: percentText, tone: severity },
      { text: suffix, tone: "muted" }
    ];
  }
}

// MCP tool usage, rendered as a consumption meter (used / total). The filled
// portion represents the used share, colored by how close usage is to the cap.
class McpRenderer extends ComponentRenderer {
  render(config) {
    const mcp = this.model.mcp;
    if (!mcp) {
      return null;
    }

    const style = this.style || "bar";
    const tone = mcp.severity || "neutral";
    const percent = Number.isFinite(mcp.usedPercent) ? mcp.usedPercent : 0;
    const showLabel = this.shouldShowLabel();
    const lead = showLabel ? " | MCP " : " | ";

    if (style === "bar") {
      const bar = buildBar(percent);
      return [
        { text: lead, tone: "muted" },
        { text: bar.filledText, tone },
        { text: bar.emptyText, tone: "barEmpty" },
        { text: " ", tone: "plain" },
        { text: `${percent}%`, tone }
      ];
    }

    return [
      { text: lead, tone: "muted" },
      { text: `${percent}%`, tone }
    ];
  }
}

// Today's token throughput aggregated from Claude Code transcripts (Zhipu has no
// daily-usage API). Shows input / output / cache-read / cache-write in "k".
// Hidden when there is no usage yet today, or in minimalist/raw modes.
class TodayRenderer extends ComponentRenderer {
  render(config, ctxModel, enabledTypes, todayUsage) {
    if (this.global.minimalist || this.global.rawValues) {
      return null;
    }
    if (!todayUsage) {
      return null;
    }
    const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = todayUsage;
    if (!input && !output && !cacheRead && !cacheWrite) {
      return null;
    }

    return [
      { text: " | 今日 in ", tone: "muted" },
      { text: formatTokens(input), tone: "neutral" },
      { text: " out ", tone: "muted" },
      { text: formatTokens(output), tone: "neutral" },
      { text: " cr ", tone: "muted" },
      { text: formatTokens(cacheRead), tone: "neutral" },
      { text: " cw ", tone: "muted" },
      { text: formatTokens(cacheWrite), tone: "neutral" }
    ];
  }
}

// Real-time generation speed (output tokens / second) for the current Claude
// Code session, derived from its transcript. Reflects the most recent completed
// turn(s); hidden until at least one measurable turn exists.
class RateRenderer extends ComponentRenderer {
  render(config, ctxModel, enabledTypes, todayUsage, sessionRate) {
    if (this.global.minimalist || this.global.rawValues) {
      return null;
    }
    if (!sessionRate || !sessionRate.rate) {
      return null;
    }
    return [
      { text: " | ", tone: "muted" },
      { text: `${sessionRate.rate} tok/s`, tone: "neutral" }
    ];
  }
}

class StatusLineRenderer {
  constructor(model, globalConfig, style) {
    this.model = model;
    this.global = globalConfig;
    this.renderers = {
      [COMPONENT_TYPES.MODEL]: new ModelRenderer(model, globalConfig, style),
      [COMPONENT_TYPES.PRIMARY]: new PrimaryQuotaRenderer(model, globalConfig, style),
      [COMPONENT_TYPES.WEEKLY]: new WeeklyQuotaRenderer(model, globalConfig, style),
      [COMPONENT_TYPES.RESET]: new ResetTimeRenderer(model, globalConfig, style),
      [COMPONENT_TYPES.MULTIPLIER]: new MultiplierRenderer(model, globalConfig, style),
      [COMPONENT_TYPES.CONTEXT]: new ContextRenderer(model, globalConfig, style),
      [COMPONENT_TYPES.MCP]: new McpRenderer(model, globalConfig, style),
      [COMPONENT_TYPES.TODAY]: new TodayRenderer(model, globalConfig, style),
      [COMPONENT_TYPES.RATE]: new RateRenderer(model, globalConfig, style)
    };
  }

  renderLine(lineConfig, ctxModel, todayUsage, sessionRate) {
    const segments = [];
    let prevHadContent = false;
    const enabledTypes = new Set(
      lineConfig.components
        .filter(c => c.enabled !== false)
        .map(c => c.type)
    );

    for (const compConfig of lineConfig.components) {
      if (compConfig.enabled === false) continue;

      const renderer = this.renderers[compConfig.type];
      if (!renderer) continue;

      const compSegments = renderer.render(compConfig, ctxModel, enabledTypes, todayUsage, sessionRate);

      if (compSegments && compSegments.length > 0) {
        if (prevHadContent && !this.hasLeadingSeparator(compSegments)) {
          segments.push({ text: this.global.separator, tone: "muted" });
        }

        segments.push(...compSegments);
        prevHadContent = true;
      }
    }

    return segments;
  }

  hasLeadingSeparator(segments) {
    return segments[0].text.trim().startsWith("|");
  }
}

export function buildWeeklyBar(usedPercent, theoreticalBudget, width = 10) {
  const safeUsed = Math.min(100, Math.max(0, usedPercent));
  const safeBudget = Math.min(100, Math.max(0, theoreticalBudget));

  let filledUnits;
  if (safeUsed <= 0) {
    filledUnits = 0;
  } else if (safeUsed >= 100) {
    filledUnits = width;
  } else {
    filledUnits = Math.min(width - 1, Math.max(1, Math.floor((safeUsed / 100) * width)));
  }

  const budgetUnits = Math.floor((safeBudget / 100) * width);
  const shadeUnits = Math.max(0, Math.min(width - filledUnits, budgetUnits - filledUnits));
  const emptyUnits = width - filledUnits - shadeUnits;

  return {
    width,
    filledUnits,
    shadeUnits,
    emptyUnits,
    filledText: STATUS_BAR_CHARACTERS.filled.repeat(filledUnits),
    shadeText: STATUS_BAR_CHARACTERS.shade.repeat(shadeUnits),
    emptyText: STATUS_BAR_CHARACTERS.empty.repeat(emptyUnits)
  };
}

function createErrorSegments(model) {
  const tone = model.kind === "auth_error" ? "danger" : "warn";
  return [
    { text: "GLM", tone: "label" },
    { text: " | ", tone: "muted" },
    {
      text: model.kind === "auth_error" ? "auth expired" : "quota unavailable",
      tone
    }
  ];
}

export function formatStatus(result, options = {}) {
  const style = isValidStatusStyle(options.global?.style || options.style)
    ? (options.global?.style || options.style)
    : undefined;
  const theme = normalizeTheme(options.global?.theme || options.theme);

  const normalizedConfig = normalizeConfig(options);

  const model = buildStatusViewModel(result, {
    workDays: options.global?.workDays || options.workDays,
    now: options.now,
    resetFormat: normalizedConfig.global.resetFormat,
    modelId: options.modelId,
    multiplierConfig: options.multiplierConfig
  });

  if (model.kind === "unavailable") return "";
  if (model.kind !== "success") {
    return applyTheme(createErrorSegments(model), { theme });
  }

  const resolvedStyle = style || normalizedConfig.global._style || "bar";

  if (resolvedStyle === "bar" || resolvedStyle === "compact") {
    for (const line of normalizedConfig.lines) {
      const modelComp = line.components.find(c => c.type === COMPONENT_TYPES.MODEL);
      if (modelComp) modelComp.enabled = false;
    }
  }

  if (resolvedStyle === "compact") {
    normalizedConfig.global.separator = " ";
  }

  const renderer = new StatusLineRenderer(model, normalizedConfig.global, resolvedStyle);
  const lineConfig = normalizedConfig.lines[0];
  const segments = renderer.renderLine(lineConfig, options.ctxModel, options.todayUsage, options.sessionRate);

  return applyTheme(segments, { theme });
}
