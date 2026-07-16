import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

type TokenCounts = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

type MinuteBucket = TokenCounts & {
  minute: string;
  events: number;
};

type RateLimitSnapshot = {
  used_percent?: number | null;
  window_minutes?: number | null;
  resets_at?: number | null;
  plan_type?: string | null;
  credits?: {
    has_credits: boolean;
    unlimited: boolean;
    balance?: string | null;
  } | null;
};

type LatestUsage = {
  timestamp: string;
  minute: string;
  last: TokenCounts;
  total: TokenCounts;
  model_context_window?: number | null;
  rate_limit?: RateLimitSnapshot | null;
};

type SessionSummary = TokenCounts & {
  id: string;
  first_seen?: string | null;
  last_seen?: string | null;
  events: number;
  last_cumulative_total: number;
};

type UsageDashboard = {
  scanned_at_ms: number;
  lookback_days: number;
  codex_sessions_path: string;
  cache_path: string;
  totals: TokenCounts & { events: number };
  latest?: LatestUsage | null;
  buckets: MinuteBucket[];
  sessions: SessionSummary[];
  errors: string[];
};

type SeriesBucket = MinuteBucket & {
  ms: number;
  fresh_input_tokens: number;
  visible_output_tokens: number;
};

type CumulativePoint = {
  ms: number;
  minute: string;
  total_tokens: number;
};

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("App root not found");
}

const app: HTMLDivElement = root;
const currentWindow = getCurrentWindow();
const currentWindowLabel = currentWindow.label;
const isPanelWindow = currentWindowLabel === "panel";
const opacityStorageKey = "codex-quota-monitor.opacity";

const state: {
  dashboard: UsageDashboard | null;
  expanded: boolean;
  compactMode: "tokens" | "curve";
  chartMode: "cumulative" | "realtime";
  rangeMinutes: number;
  opacity: number;
  contextMenu: { x: number; y: number } | null;
  loading: boolean;
  error: string | null;
} = {
  dashboard: null,
  expanded: isPanelWindow,
  compactMode: "tokens",
  chartMode: "cumulative",
  rangeMinutes: 360,
  opacity: readOpacity(),
  contextMenu: null,
  loading: true,
  error: null,
};

const ranges = [
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
  { label: "7d", minutes: 10080 },
];

async function refreshUsage() {
  state.loading = true;
  render();

  try {
    state.dashboard = await invoke<UsageDashboard>("scan_codex_usage");
    state.error = null;
  } catch (error) {
    state.error = String(error);
  } finally {
    state.loading = false;
    render();
  }
}

async function setExpanded(expanded: boolean) {
  try {
    if (expanded) {
      await invoke("open_panel");
    } else {
      await invoke("hide_panel");
    }
  } catch (error) {
    state.error = String(error);
    render();
  }
}

function render() {
  const dashboard = state.dashboard;
  app.className = state.expanded ? "app expanded" : "app compact";
  applyOpacity();

  app.innerHTML = state.expanded
    ? renderExpanded(dashboard)
    : renderCompact(dashboard);

  bindEvents();
}

function renderCompact(dashboard: UsageDashboard | null) {
  const remainingPercent = quotaRemainingPercent(dashboard);
  const fiveMinuteTotal = sumLastMinutes(dashboard, 5);
  const fiveMinuteAverage = Math.round(fiveMinuteTotal / 5);
  const today = sumToday(dashboard);
  const todaySeries = dashboard ? todayCumulativeSeries(dashboard) : [];
  const switchLabel = state.compactMode === "tokens" ? "曲线" : "5分";

  return `
    <section class="shell shell-compact" aria-label="Codex token monitor" data-open-panel>
      <header class="compact-header drag-region" data-tauri-drag-region data-drag-window>
        <div class="brand" data-tauri-drag-region>
          <span class="status-dot ${state.loading ? "is-loading" : ""}"></span>
          <span data-tauri-drag-region>Codex</span>
        </div>
        <div class="window-actions">
          <button class="icon-button" type="button" data-action="refresh" aria-label="刷新">R</button>
        </div>
      </header>
      <main class="compact-body">
        <div class="compact-monitor">
          <div class="today-metric">
            <div class="metric-label">today total</div>
            <div class="compact-value">${formatTokens(today)}</div>
            <div class="metric-sub">remaining ${formatPercent(remainingPercent)}</div>
          </div>
          <div class="side-widget">
            ${
              state.compactMode === "tokens"
                ? `
                  <div class="side-label">5 min</div>
                  <div class="side-value">${formatTokens(fiveMinuteTotal)}</div>
                  <div class="side-sub">${formatTokens(fiveMinuteAverage)} / min</div>
                `
                : `
                  <div class="side-label">today curve</div>
                  ${renderCompactCumulativeSparkline(todaySeries)}
                  <div class="side-sub">${formatScannedAt(dashboard)}</div>
                `
            }
          </div>
        </div>
        <div class="compact-footline">
          <span>${formatScannedAt(dashboard)}</span>
          <span>double click panel</span>
        </div>
        <button class="corner-switch" type="button" data-mode-toggle data-no-drag aria-label="切换浮窗右侧显示">${switchLabel}</button>
      </main>
      ${renderContextMenu()}
    </section>
  `;
}

function renderExpanded(dashboard: UsageDashboard | null) {
  const usedPercent = quotaUsedPercent(dashboard);
  const remainingPercent = quotaRemainingPercent(dashboard);
  const latest = dashboard?.latest ?? null;
  const today = sumToday(dashboard);
  const oneHour = sumLastMinutes(dashboard, 60);
  const selectedTotal = sumLastMinutes(dashboard, state.rangeMinutes);
  const stackedSeries = dashboard ? bucketedSeries(dashboard, state.rangeMinutes, 5) : [];
  const cumulativeSeries = dashboard ? todayCumulativeSeries(dashboard) : [];
  const cumulativeTotal = cumulativeSeries.at(-1)?.total_tokens ?? 0;
  const activeChartTitle = state.chartMode === "cumulative" ? "当天累计曲线" : "实时曲线";
  const activeChartMeta =
    state.chartMode === "cumulative"
      ? `${formatTokens(cumulativeTotal)} total today`
      : `${formatTokens(maxTotal(stackedSeries))} peak / 5 min`;
  const activeChart =
    state.chartMode === "cumulative"
      ? renderCumulativeChart(cumulativeSeries)
      : renderLineChart(stackedSeries);

  return `
    <section class="shell shell-expanded" aria-label="Codex quota monitor">
      <header class="panel-header drag-region" data-tauri-drag-region data-drag-window>
        <div class="title-block" data-tauri-drag-region>
          <div class="eyebrow" data-tauri-drag-region>Local Codex Monitor</div>
          <h1 data-tauri-drag-region>额度剩余与 Token 消耗</h1>
        </div>
        <div class="window-actions">
          <button class="ghost-button" type="button" data-action="refresh">${state.loading ? "扫描中" : "刷新"}</button>
          <button class="icon-button" type="button" data-action="collapse" aria-label="收起">-</button>
        </div>
      </header>

      <main class="panel-content">
        ${renderError(dashboard)}
        <section class="quota-strip">
          <div class="quota-visual">
            ${renderQuotaRing(remainingPercent, 112)}
            <div>
              <div class="quota-value">${formatPercent(remainingPercent)}</div>
              <div class="metric-label">primary quota remaining</div>
            </div>
          </div>
          <div class="quota-meta">
            <div>
              <span class="metric-label">plan</span>
              <strong>${escapeHtml(latest?.rate_limit?.plan_type ?? "unknown")}</strong>
            </div>
            <div>
              <span class="metric-label">reset</span>
              <strong>${formatReset(latest?.rate_limit?.resets_at ?? null)}</strong>
            </div>
            <div>
              <span class="metric-label">context</span>
              <strong>${formatTokens(latest?.model_context_window ?? 0)}</strong>
            </div>
          </div>
        </section>

        <section class="stats-grid">
          ${metricCard("剩余额度", formatPercent(remainingPercent), `used ${formatPercent(usedPercent)}`)}
          ${metricCard("今天", formatTokens(today), "local day")}
          ${metricCard("最近 1h", formatTokens(oneHour), `${countEvents(dashboard, 60)} turns`)}
          ${metricCard("当前范围", formatTokens(selectedTotal), rangeLabel())}
        </section>

        <section class="chart-toolbar">
          <div class="segmented" role="group" aria-label="时间范围">
            ${ranges
              .map(
                (range) => `
                  <button class="${state.rangeMinutes === range.minutes ? "active" : ""}" type="button" data-range="${range.minutes}">
                    ${range.label}
                  </button>
                `,
              )
              .join("")}
          </div>
          <div class="segmented" role="group" aria-label="曲线类型">
            <button class="${state.chartMode === "cumulative" ? "active" : ""}" type="button" data-chart-mode="cumulative">
              累计
            </button>
            <button class="${state.chartMode === "realtime" ? "active" : ""}" type="button" data-chart-mode="realtime">
              实时
            </button>
          </div>
          <div class="range-total">${formatTokens(selectedTotal)} in ${rangeLabel()}</div>
        </section>

        <section class="chart-section">
          <div class="section-heading">
            <h2>${activeChartTitle}</h2>
            <span>${activeChartMeta}</span>
          </div>
          ${activeChart}
        </section>

        <section class="chart-section">
          <div class="section-heading">
            <h2>5 分钟分段堆叠</h2>
            <span>fresh input / cached / output / reasoning</span>
          </div>
          ${renderStackedChart(stackedSeries)}
          <div class="legend">
            ${legendItem("fresh", "Fresh input")}
            ${legendItem("cached", "Cached")}
            ${legendItem("output", "Output")}
            ${legendItem("reasoning", "Reasoning")}
          </div>
        </section>

        <section class="sessions-section">
          <div class="section-heading">
            <h2>最近 Session</h2>
            <span>${dashboard?.sessions.length ?? 0} shown</span>
          </div>
          ${renderSessions(dashboard)}
        </section>

        <footer class="data-footer">
          <span>${escapeHtml(dashboard?.codex_sessions_path ?? "")}</span>
          <span>${escapeHtml(dashboard?.cache_path ?? "")}</span>
        </footer>
      </main>
    </section>
  `;
}

function bindEvents() {
  const shell = app.querySelector<HTMLElement>(".shell");
  shell?.addEventListener("dblclick", (event) => {
    if (!state.expanded && !isInteractiveTarget(event.target)) {
      void setExpanded(true);
    }
  });
  shell?.addEventListener("contextmenu", (event) => {
    if (isPanelWindow) {
      return;
    }
    event.preventDefault();
    state.contextMenu = menuPosition(event.clientX, event.clientY);
    render();
  });
  shell?.addEventListener("click", (event) => {
    if (state.contextMenu && !(event.target instanceof Element && event.target.closest(".context-menu"))) {
      state.contextMenu = null;
      render();
    }
  });

  app.querySelectorAll<HTMLElement>("[data-drag-window]").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || isInteractiveTarget(event.target)) {
        return;
      }
      void currentWindow.startDragging().catch(() => {
        // The data-tauri-drag-region attribute remains as a native fallback.
      });
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "expand") void setExpanded(true);
      if (action === "collapse") void setExpanded(false);
      if (action === "refresh") void refreshUsage();
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-mode-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      state.compactMode = state.compactMode === "tokens" ? "curve" : "tokens";
      render();
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-chart-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.chartMode;
      if (mode === "cumulative" || mode === "realtime") {
        state.chartMode = mode;
        render();
      }
    });
  });

  app.querySelectorAll<HTMLInputElement>("[data-opacity]").forEach((input) => {
    input.addEventListener("input", () => {
      const value = clamp(Number(input.value) / 100, 0.35, 1);
      setOpacity(value);
      const label = app.querySelector<HTMLElement>("[data-opacity-value]");
      if (label) {
        label.textContent = formatPercent(value * 100);
      }
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      const minutes = Number(button.dataset.range);
      if (Number.isFinite(minutes)) {
        state.rangeMinutes = minutes;
        render();
      }
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-opacity-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = Number(button.dataset.opacityChoice);
      if (Number.isFinite(value)) {
        setOpacity(value);
        state.contextMenu = null;
        render();
      }
    });
  });
}

function renderError(dashboard: UsageDashboard | null) {
  const messages = [
    state.error,
    ...(dashboard?.errors ?? []),
  ].filter(Boolean);

  if (!messages.length) {
    return "";
  }

  return `
    <div class="error-bar">
      ${messages.map((message) => `<span>${escapeHtml(String(message))}</span>`).join("")}
    </div>
  `;
}

function renderContextMenu() {
  if (isPanelWindow || !state.contextMenu) {
    return "";
  }

  const choices = [0.4, 0.55, 0.7, 0.82, 1];

  return `
    <div class="context-menu" style="left: ${state.contextMenu.x}px; top: ${state.contextMenu.y}px;" data-no-drag>
      <div class="context-menu-title">透明度</div>
      ${choices
        .map(
          (choice) => `
            <button class="${Math.abs(state.opacity - choice) < 0.01 ? "active" : ""}" type="button" data-opacity-choice="${choice}">
              ${formatPercent(choice * 100)}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function metricCard(label: string, value: string, sub: string) {
  return `
    <article class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(sub)}</span>
    </article>
  `;
}

function renderQuotaRing(percent: number, size = 76) {
  const stroke = size > 80 ? 10 : 7;
  const radius = (size - stroke) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = clamp(percent, 0, 100);
  const dash = (clamped / 100) * circumference;

  return `
    <svg class="quota-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Quota remaining ${formatPercent(percent)}">
      <circle class="ring-track" cx="${center}" cy="${center}" r="${radius}" fill="none" stroke-width="${stroke}"></circle>
      <circle class="ring-value" cx="${center}" cy="${center}" r="${radius}" fill="none" stroke-width="${stroke}"
        stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-linecap="round"
        transform="rotate(-90 ${center} ${center})"></circle>
    </svg>
  `;
}

function renderSparkline(series: SeriesBucket[]) {
  const data = compressSeries(series, 64);
  const width = 250;
  const height = 56;
  const max = Math.max(1, ...data.map((bucket) => bucket.total_tokens));
  const points = data.map((bucket, index) => {
    const x = data.length <= 1 ? 0 : (index / (data.length - 1)) * width;
    const y = height - (bucket.total_tokens / max) * (height - 6) - 3;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return `
    <svg class="sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="Last hour token trend">
      <polyline points="${points.join(" ")}" fill="none" stroke="currentColor" stroke-width="2"></polyline>
    </svg>
  `;
}

function renderCompactCumulativeSparkline(series: CumulativePoint[]) {
  const data = compressCumulativeSeries(series, 48);
  const width = 96;
  const height = 52;
  const max = Math.max(1, ...data.map((point) => point.total_tokens));
  const points = data.map((point, index) => {
    const x = data.length <= 1 ? 0 : (index / (data.length - 1)) * width;
    const y = height - (point.total_tokens / max) * (height - 8) - 4;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return `
    <svg class="compact-cumulative" viewBox="0 0 ${width} ${height}" role="img" aria-label="Today cumulative token trend">
      <polyline points="${points.join(" ")}" fill="none" stroke="currentColor" stroke-width="2"></polyline>
    </svg>
  `;
}

function renderMiniBars(series: SeriesBucket[]) {
  const data = series.slice(-5);
  const width = 86;
  const height = 46;
  const max = Math.max(1, ...data.map((bucket) => bucket.total_tokens));
  const gap = 4;
  const barWidth = (width - gap * Math.max(0, data.length - 1)) / Math.max(data.length, 1);

  return `
    <svg class="mini-bars" viewBox="0 0 ${width} ${height}" role="img" aria-label="Last 5 minute token usage bars">
      ${data
        .map((bucket, index) => {
          const barHeight = Math.max(2, (bucket.total_tokens / max) * (height - 4));
          const x = index * (barWidth + gap);
          const y = height - barHeight;
          return `
            <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="2">
              <title>${formatShortTime(bucket.ms)} ${formatTokens(bucket.total_tokens)}</title>
            </rect>
          `;
        })
        .join("")}
    </svg>
  `;
}

function renderLineChart(series: SeriesBucket[]) {
  const data = compressSeries(series, 220);
  const width = 760;
  const height = 236;
  const margin = { top: 16, right: 20, bottom: 34, left: 64 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const max = Math.max(1, ...data.map((bucket) => bucket.total_tokens));
  const points = data.map((bucket, index) => {
    const x = margin.left + (data.length <= 1 ? 0 : (index / (data.length - 1)) * innerWidth);
    const y = margin.top + innerHeight - (bucket.total_tokens / max) * innerHeight;
    return { x, y, bucket };
  });
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const ticks = yTicks(max, 4);
  const xTicks = xAxisTicks(data, 5);

  return `
    <svg class="chart line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Token usage line chart">
      <g class="grid">
        ${ticks
          .map((tick) => {
            const y = margin.top + innerHeight - (tick / max) * innerHeight;
            return `<line x1="${margin.left}" y1="${y.toFixed(2)}" x2="${width - margin.right}" y2="${y.toFixed(2)}"></line>
              <text x="${margin.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${formatAxisNumber(tick)}</text>`;
          })
          .join("")}
      </g>
      <path class="line-path" d="${path}"></path>
      ${points
        .filter((_, index) => index === points.length - 1 || data.length < 40)
        .map(
          (point) => `
            <circle class="line-dot" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3">
              <title>${formatShortTime(point.bucket.ms)} ${formatTokens(point.bucket.total_tokens)}</title>
            </circle>
          `,
        )
        .join("")}
      <g class="axis">
        <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"></line>
        ${xTicks
          .map(
            ({ x, label }) => `
              <text x="${x.toFixed(2)}" y="${height - 12}" text-anchor="middle">${escapeHtml(label)}</text>
            `,
          )
          .join("")}
      </g>
    </svg>
  `;
}

function renderCumulativeChart(series: CumulativePoint[]) {
  const data = compressCumulativeSeries(series, 220);
  const width = 760;
  const height = 236;
  const margin = { top: 16, right: 20, bottom: 34, left: 64 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const max = Math.max(1, ...data.map((point) => point.total_tokens));
  const points = data.map((point, index) => {
    const x = margin.left + (data.length <= 1 ? 0 : (index / (data.length - 1)) * innerWidth);
    const y = margin.top + innerHeight - (point.total_tokens / max) * innerHeight;
    return { x, y, point };
  });
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const ticks = yTicks(max, 4);
  const xTicks = xAxisTicks(data, 5, formatClockTime);

  return `
    <svg class="chart line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Today cumulative token usage line chart">
      <g class="grid">
        ${ticks
          .map((tick) => {
            const y = margin.top + innerHeight - (tick / max) * innerHeight;
            return `<line x1="${margin.left}" y1="${y.toFixed(2)}" x2="${width - margin.right}" y2="${y.toFixed(2)}"></line>
              <text x="${margin.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${formatAxisNumber(tick)}</text>`;
          })
          .join("")}
      </g>
      <path class="line-path" d="${path}"></path>
      ${points
        .filter((_, index) => index === points.length - 1 || data.length < 40)
        .map(
          (point) => `
            <circle class="line-dot" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3">
              <title>${formatClockTime(point.point.ms)} ${formatTokens(point.point.total_tokens)}</title>
            </circle>
          `,
        )
        .join("")}
      <g class="axis">
        <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"></line>
        ${xTicks
          .map(
            ({ x, label }) => `
              <text x="${x.toFixed(2)}" y="${height - 12}" text-anchor="middle">${escapeHtml(label)}</text>
            `,
          )
          .join("")}
      </g>
    </svg>
  `;
}

function renderStackedChart(series: SeriesBucket[]) {
  const data = compressSeries(series, 132);
  const width = 760;
  const height = 260;
  const margin = { top: 16, right: 20, bottom: 36, left: 64 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const max = Math.max(1, ...data.map((bucket) => bucket.total_tokens));
  const gap = 2;
  const barWidth = Math.max(2, innerWidth / Math.max(data.length, 1) - gap);
  const ticks = yTicks(max, 4);
  const xTicks = xAxisTicks(data, 5);

  return `
    <svg class="chart stacked-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Token usage stacked chart">
      <g class="grid">
        ${ticks
          .map((tick) => {
            const y = margin.top + innerHeight - (tick / max) * innerHeight;
            return `<line x1="${margin.left}" y1="${y.toFixed(2)}" x2="${width - margin.right}" y2="${y.toFixed(2)}"></line>
              <text x="${margin.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${formatAxisNumber(tick)}</text>`;
          })
          .join("")}
      </g>
      <g class="bars">
        ${data
          .map((bucket, index) => {
            const x = margin.left + index * (innerWidth / Math.max(data.length, 1));
            let y = margin.top + innerHeight;
            const segments = [
              ["fresh", bucket.fresh_input_tokens],
              ["cached", bucket.cached_input_tokens],
              ["output", bucket.visible_output_tokens],
              ["reasoning", bucket.reasoning_output_tokens],
            ] as const;

            return segments
              .map(([name, value]) => {
                const segmentHeight = (value / max) * innerHeight;
                y -= segmentHeight;
                if (segmentHeight <= 0) return "";
                return `
                  <rect class="segment-${name}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${segmentHeight.toFixed(2)}">
                    <title>${formatShortTime(bucket.ms)} ${name}: ${formatTokens(value)}</title>
                  </rect>
                `;
              })
              .join("");
          })
          .join("")}
      </g>
      <g class="axis">
        <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"></line>
        ${xTicks
          .map(
            ({ x, label }) => `
              <text x="${x.toFixed(2)}" y="${height - 12}" text-anchor="middle">${escapeHtml(label)}</text>
            `,
          )
          .join("")}
      </g>
    </svg>
  `;
}

function renderSessions(dashboard: UsageDashboard | null) {
  const sessions = dashboard?.sessions ?? [];
  if (!sessions.length) {
    return `<div class="empty-state">No Codex token events found.</div>`;
  }

  return `
    <div class="session-list">
      ${sessions
        .map(
          (session) => `
            <div class="session-row">
              <span class="session-id">${escapeHtml(shortSessionId(session.id))}</span>
              <span>${formatTokens(session.total_tokens)}</span>
              <span>${session.events} turns</span>
              <span>${formatRelativeTime(session.last_seen)}</span>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function legendItem(name: string, label: string) {
  return `<span class="legend-item"><i class="legend-swatch segment-${escapeHtml(name)}"></i>${escapeHtml(label)}</span>`;
}

function normalizedSeries(dashboard: UsageDashboard, rangeMinutes: number): SeriesBucket[] {
  const map = new Map<number, MinuteBucket>();
  for (const bucket of dashboard.buckets) {
    const ms = parseMinute(bucket.minute);
    if (Number.isFinite(ms)) {
      map.set(ms, bucket);
    }
  }

  const end = Math.floor((dashboard.scanned_at_ms || Date.now()) / 60000) * 60000;
  const start = end - (rangeMinutes - 1) * 60000;
  const series: SeriesBucket[] = [];

  for (let ms = start; ms <= end; ms += 60000) {
    const bucket = map.get(ms);
    const counts = bucket ?? {
      minute: new Date(ms).toISOString().slice(0, 16) + ":00Z",
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      events: 0,
    };
    series.push(enrichBucket(counts, ms));
  }

  return series;
}

function bucketedSeries(dashboard: UsageDashboard, rangeMinutes: number, bucketMinutes: number): SeriesBucket[] {
  const interval = bucketMinutes * 60000;
  const bucketsBySlot = new Map<number, MinuteBucket>();

  for (const bucket of dashboard.buckets) {
    const ms = parseMinute(bucket.minute);
    if (!Number.isFinite(ms)) continue;
    const slot = Math.floor(ms / interval) * interval;
    const aggregate = bucketsBySlot.get(slot) ?? {
      minute: new Date(slot).toISOString().slice(0, 16) + ":00Z",
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      events: 0,
    };

    aggregate.input_tokens += bucket.input_tokens;
    aggregate.cached_input_tokens += bucket.cached_input_tokens;
    aggregate.output_tokens += bucket.output_tokens;
    aggregate.reasoning_output_tokens += bucket.reasoning_output_tokens;
    aggregate.total_tokens += bucket.total_tokens;
    aggregate.events += bucket.events;
    bucketsBySlot.set(slot, aggregate);
  }

  const endMinute = Math.floor((dashboard.scanned_at_ms || Date.now()) / 60000) * 60000;
  const end = Math.floor(endMinute / interval) * interval;
  const pointCount = Math.max(1, Math.ceil(rangeMinutes / bucketMinutes));
  const start = end - (pointCount - 1) * interval;
  const series: SeriesBucket[] = [];

  for (let ms = start; ms <= end; ms += interval) {
    const bucket = bucketsBySlot.get(ms) ?? {
      minute: new Date(ms).toISOString().slice(0, 16) + ":00Z",
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      events: 0,
    };
    series.push(enrichBucket(bucket, ms));
  }

  return series;
}

function todayCumulativeSeries(dashboard: UsageDashboard): CumulativePoint[] {
  const interval = 5 * 60000;
  const scanMs = dashboard.scanned_at_ms || Date.now();
  const startDate = new Date(scanMs);
  startDate.setHours(0, 0, 0, 0);
  const startMs = startDate.getTime();
  const endMs = Math.floor(scanMs / interval) * interval;
  const increments = new Map<number, number>();

  for (const bucket of dashboard.buckets) {
    const ms = parseMinute(bucket.minute);
    if (!Number.isFinite(ms) || ms < startMs || ms > scanMs) continue;
    const slot = Math.floor(ms / interval) * interval;
    increments.set(slot, (increments.get(slot) ?? 0) + bucket.total_tokens);
  }

  const series: CumulativePoint[] = [];
  let total = 0;

  for (let ms = startMs; ms <= endMs; ms += interval) {
    total += increments.get(ms) ?? 0;
    series.push({
      ms,
      minute: new Date(ms).toISOString().slice(0, 16) + ":00Z",
      total_tokens: total,
    });
  }

  return series;
}

function compressSeries(series: SeriesBucket[], maxPoints: number): SeriesBucket[] {
  if (series.length <= maxPoints) {
    return series;
  }

  const groupSize = Math.ceil(series.length / maxPoints);
  const compressed: SeriesBucket[] = [];

  for (let index = 0; index < series.length; index += groupSize) {
    const group = series.slice(index, index + groupSize);
    const first = group[0];
    const aggregate: MinuteBucket = {
      minute: first.minute,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      events: 0,
    };

    for (const bucket of group) {
      aggregate.input_tokens += bucket.input_tokens;
      aggregate.cached_input_tokens += bucket.cached_input_tokens;
      aggregate.output_tokens += bucket.output_tokens;
      aggregate.reasoning_output_tokens += bucket.reasoning_output_tokens;
      aggregate.total_tokens += bucket.total_tokens;
      aggregate.events += bucket.events;
    }

    compressed.push(enrichBucket(aggregate, first.ms));
  }

  return compressed;
}

function compressCumulativeSeries(series: CumulativePoint[], maxPoints: number): CumulativePoint[] {
  if (series.length <= maxPoints) {
    return series;
  }

  const groupSize = Math.ceil(series.length / maxPoints);
  const compressed: CumulativePoint[] = [];

  for (let index = 0; index < series.length; index += groupSize) {
    const group = series.slice(index, index + groupSize);
    compressed.push(group[group.length - 1]);
  }

  return compressed;
}

function enrichBucket(bucket: MinuteBucket, ms: number): SeriesBucket {
  const cached = Math.min(bucket.cached_input_tokens, bucket.input_tokens);
  const reasoning = Math.min(bucket.reasoning_output_tokens, bucket.output_tokens);

  return {
    ...bucket,
    ms,
    fresh_input_tokens: Math.max(0, bucket.input_tokens - cached),
    visible_output_tokens: Math.max(0, bucket.output_tokens - reasoning),
  };
}

function quotaUsedPercent(dashboard: UsageDashboard | null) {
  return dashboard?.latest?.rate_limit?.used_percent ?? 0;
}

function quotaRemainingPercent(dashboard: UsageDashboard | null) {
  return clamp(100 - quotaUsedPercent(dashboard), 0, 100);
}

function sumToday(dashboard: UsageDashboard | null) {
  if (!dashboard) return 0;
  const now = new Date(dashboard.scanned_at_ms || Date.now());
  return dashboard.buckets.reduce((total, bucket) => {
    const date = new Date(parseMinute(bucket.minute));
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    return sameDay ? total + bucket.total_tokens : total;
  }, 0);
}

function sumLastMinutes(dashboard: UsageDashboard | null, minutes: number) {
  if (!dashboard) return 0;
  const cutoff = (dashboard.scanned_at_ms || Date.now()) - minutes * 60000;
  return dashboard.buckets.reduce((total, bucket) => {
    const ms = parseMinute(bucket.minute);
    return ms >= cutoff ? total + bucket.total_tokens : total;
  }, 0);
}

function countEvents(dashboard: UsageDashboard | null, minutes: number) {
  if (!dashboard) return 0;
  const cutoff = (dashboard.scanned_at_ms || Date.now()) - minutes * 60000;
  return dashboard.buckets.reduce((total, bucket) => {
    const ms = parseMinute(bucket.minute);
    return ms >= cutoff ? total + bucket.events : total;
  }, 0);
}

function maxTotal(series: SeriesBucket[]) {
  return Math.max(0, ...series.map((bucket) => bucket.total_tokens));
}

function parseMinute(minute: string) {
  return new Date(minute).getTime();
}

function yTicks(max: number, count: number) {
  const ticks: number[] = [];
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Math.round((max / count) * index));
  }
  return ticks;
}

function xAxisTicks(
  data: Array<SeriesBucket | CumulativePoint>,
  count: number,
  labelFormatter: (ms: number) => string = formatShortTime,
) {
  if (!data.length) return [];
  const ticks: { x: number; label: string }[] = [];
  const width = 760;
  const margin = { left: 64, right: 20 };
  const innerWidth = width - margin.left - margin.right;

  for (let index = 0; index < count; index += 1) {
    const dataIndex = Math.round((index / (count - 1)) * (data.length - 1));
    const x = margin.left + (data.length <= 1 ? 0 : (dataIndex / (data.length - 1)) * innerWidth);
    ticks.push({ x, label: labelFormatter(data[dataIndex].ms) });
  }

  return ticks;
}

function rangeLabel() {
  return ranges.find((range) => range.minutes === state.rangeMinutes)?.label ?? `${state.rangeMinutes}m`;
}

function formatTokens(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return Math.round(value).toLocaleString();
}

function formatAxisNumber(value: number) {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0%";
  return `${clamp(value, 0, 999).toFixed(value < 10 ? 1 : 0)}%`;
}

function formatReset(value: number | null) {
  if (!value) return "unknown";
  const diffMs = value * 1000 - Date.now();
  if (diffMs <= 0) return "now";
  const minutes = Math.ceil(diffMs / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${minutes % 60}m`;
}

function formatShortTime(ms: number) {
  const date = new Date(ms);
  if (state.rangeMinutes >= 1440) {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatClockTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRelativeTime(value?: string | null) {
  if (!value) return "unknown";
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60000) return "now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatScannedAt(dashboard: UsageDashboard | null) {
  if (!dashboard) return "no data";
  return new Date(dashboard.scanned_at_ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortSessionId(id: string) {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, [data-no-drag]"));
}

function menuPosition(x: number, y: number) {
  return {
    x: clamp(x, 8, Math.max(8, window.innerWidth - 144)),
    y: clamp(y, 8, Math.max(8, window.innerHeight - 132)),
  };
}

function setOpacity(value: number) {
  if (isPanelWindow) {
    applyOpacity();
    return;
  }
  state.opacity = clamp(value, 0.35, 1);
  localStorage.setItem(opacityStorageKey, String(state.opacity));
  applyOpacity();
}

function readOpacity() {
  const raw = localStorage.getItem(opacityStorageKey);
  const value = raw ? Number(raw) : 0.82;
  return clamp(Number.isFinite(value) ? value : 0.82, 0.35, 1);
}

function applyOpacity() {
  const alpha = isPanelWindow ? "1.00" : state.opacity.toFixed(2);
  app.style.setProperty("--panel-alpha", alpha);
  document.documentElement.style.setProperty("--panel-alpha", alpha);
}

async function listenForOpacityChanges() {
  await listen<number>("opacity-change", (event) => {
    const value = Number(event.payload);
    if (Number.isFinite(value) && !isPanelWindow) {
      setOpacity(value);
      render();
    }
  });
}

void listenForOpacityChanges();
void refreshUsage();
window.setInterval(() => void refreshUsage(), 30_000);
