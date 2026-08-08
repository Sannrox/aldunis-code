import React, { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui";
import {
  USAGE_RANGE_DAYS,
  type UsageRangeDays,
  type UsageReport,
  type UsageDailyPoint,
  type UsageProviderSummary,
} from "../../lib/usage";
import type { ProviderId } from "../../types";

type UsageMetric = "tokens" | "cost";

function providerLabel(provider: ProviderId): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex-cli") return "Codex";
  if (provider === "shikigami") return "Shikigami";
  return provider.replace(/^adapter:/, "Adapter ").replace(/@[^@]+$/, "");
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatCost(value: number | null): string {
  if (value === null) return "Not reported";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function metricValue(point: UsageDailyPoint, metric: UsageMetric): number {
  return metric === "tokens" ? point.processedTokens : (point.reportedCostUsd ?? 0);
}

function UsageChart({ points, metric }: { points: UsageDailyPoint[]; metric: UsageMetric }) {
  const maxValue = Math.max(...points.map((point) => metricValue(point, metric)), 1);
  const hasValues = points.some((point) => metricValue(point, metric) > 0);
  return (
    <div className="usage-chart-wrap">
      <svg
        className="usage-chart"
        viewBox="0 0 760 220"
        role="img"
        aria-label={`Daily ${metric === "tokens" ? "processed token" : "reported cost"} chart`}
      >
        <title>Daily {metric === "tokens" ? "processed tokens" : "reported cost"}</title>
        {[0, 1, 2, 3].map((line) => {
          const y = 24 + line * 48;
          return <line key={line} className="usage-chart-grid" x1="0" x2="760" y1={y} y2={y} />;
        })}
        {points.map((point, index) => {
          const value = metricValue(point, metric);
          const width = Math.max(4, 680 / Math.max(points.length, 1) - 5);
          const x = 40 + index * (680 / Math.max(points.length, 1));
          const height = value > 0 ? Math.max(4, (value / maxValue) * 156) : 0;
          return (
            <g key={point.date}>
              <rect
                className="usage-chart-bar"
                x={x}
                y={180 - height}
                width={width}
                height={height}
                rx="3"
              >
                <title>
                  {point.label}:{" "}
                  {metric === "tokens" ? formatTokens(value) : formatCost(point.reportedCostUsd)}
                </title>
              </rect>
              {(index === 0 ||
                index === points.length - 1 ||
                index === Math.floor(points.length / 2)) && (
                <text className="usage-chart-label" x={x} y="207" textAnchor="middle">
                  {point.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {!hasValues && (
        <p className="usage-chart-empty">
          {metric === "cost"
            ? "No provider-reported costs in this range."
            : "No token usage in this range."}
        </p>
      )}
    </div>
  );
}

function ProviderRows({ providers }: { providers: UsageProviderSummary[] }) {
  const max = Math.max(...providers.map((provider) => provider.processedTokens), 1);
  if (providers.length === 0)
    return <p className="usage-empty-note">No provider usage recorded yet.</p>;
  return (
    <div className="usage-provider-list" role="list" aria-label="Usage by provider">
      {providers.map((provider) => (
        <div className="usage-provider-row" role="listitem" key={provider.provider}>
          <div className="usage-provider-heading">
            <strong>{providerLabel(provider.provider)}</strong>
            <span>
              {provider.turns} turn{provider.turns === 1 ? "" : "s"}
            </span>
          </div>
          <div className="usage-progress" aria-hidden="true">
            <span style={{ width: `${Math.max(2, (provider.processedTokens / max) * 100)}%` }} />
          </div>
          <div className="usage-provider-meta">
            <span>{formatTokens(provider.processedTokens)} processed</span>
            <span>{formatCost(provider.reportedCostUsd)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function UsagePage({ onBack }: { onBack: () => void }) {
  const [rangeDays, setRangeDays] = useState<UsageRangeDays>(30);
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetch("/api/usage/summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rangeDays }),
    })
      .then(async (response) => {
        const body = (await response.json()) as UsageReport & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Usage could not be loaded.");
        if (active) setReport(body);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Usage could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [rangeDays, refreshKey]);

  const providerCount = report?.providers.length ?? 0;
  const modelCount = report?.models.length ?? 0;
  const costLabel = report ? formatCost(report.totals.reportedCostUsd) : "Loading…";
  const titleRange = report ? `${report.startDate} to ${report.endDate}` : `Last ${rangeDays} days`;
  const empty = !loading && !error && report?.totals.observedTurns === 0;
  const cacheReported = Boolean(
    report && (report.totals.cachedInputTokens > 0 || report.totals.cacheWriteInputTokens > 0),
  );
  const topModels = useMemo(() => report?.models.slice(0, 8) ?? [], [report]);

  return (
    <section className="usage-page" aria-labelledby="usage-page-title">
      <header className="usage-page-header">
        <div className="usage-page-heading">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onBack}
            aria-label="Back to conversations"
          >
            <span aria-hidden="true">←</span> Conversations
          </Button>
          <p className="usage-eyebrow">Local provider telemetry</p>
          <h1 id="usage-page-title">Usage</h1>
          <p className="usage-range">{titleRange}</p>
        </div>
        <div className="usage-controls">
          <div className="usage-segment" role="group" aria-label="Usage time range">
            {USAGE_RANGE_DAYS.map((days) => (
              <button
                type="button"
                key={days}
                className={rangeDays === days ? "active" : ""}
                aria-pressed={rangeDays === days}
                onClick={() => setRangeDays(days)}
              >
                {days} days
              </button>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setRefreshKey((value) => value + 1)}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </header>

      <div className="usage-boundary-note" role="note">
        <strong>Code-owned view.</strong> Includes only provider turns started from Aldunis Code on
        this host. Reported costs are not billing truth; no provider history from other machines is
        imported.
      </div>

      {loading && (
        <p className="usage-state" role="status">
          Reading local usage receipts…
        </p>
      )}
      {error && (
        <p className="usage-state usage-state--error" role="alert">
          {error}
        </p>
      )}
      {empty && (
        <div className="usage-empty" role="status">
          <h2>No usage in this range</h2>
          <p>Complete a provider turn from Code to start building this local view.</p>
        </div>
      )}

      {!loading && !error && report && report.totals.observedTurns > 0 && (
        <div className="usage-content">
          <div className="usage-metrics" aria-label="Usage totals">
            <article className="usage-metric-card usage-metric-card--primary">
              <span>Reported API cost</span>
              <strong>{costLabel}</strong>
              <small>
                {report.totals.pricedTurns} of {report.totals.observedTurns} turns reported cost
              </small>
            </article>
            <article className="usage-metric-card">
              <span>Processed tokens</span>
              <strong>{formatTokens(report.totals.processedTokens)}</strong>
              <small>
                {formatTokens(report.totals.inputTokens)} input ·{" "}
                {formatTokens(report.totals.outputTokens)} output
              </small>
            </article>
            <article className="usage-metric-card">
              <span>Completed turns</span>
              <strong>{report.totals.completedTurns.toLocaleString()}</strong>
              <small>
                {providerCount} providers · {modelCount} models
              </small>
            </article>
            <article className="usage-metric-card">
              <span>Cache input</span>
              <strong>
                {cacheReported ? formatTokens(report.totals.cachedInputTokens) : "Not reported"}
              </strong>
              <small>
                {cacheReported
                  ? `${formatTokens(report.totals.cacheWriteInputTokens)} write tokens`
                  : "Provider did not expose cache fields"}
              </small>
            </article>
          </div>

          <section className="usage-panel usage-panel--chart" aria-labelledby="usage-chart-title">
            <header className="usage-panel-header">
              <div>
                <h2 id="usage-chart-title">Daily usage</h2>
                <p>Provider-reported observations grouped by completion time.</p>
              </div>
              <div className="usage-segment" role="group" aria-label="Chart metric">
                <button
                  type="button"
                  className={metric === "cost" ? "active" : ""}
                  aria-pressed={metric === "cost"}
                  onClick={() => setMetric("cost")}
                >
                  Cost
                </button>
                <button
                  type="button"
                  className={metric === "tokens" ? "active" : ""}
                  aria-pressed={metric === "tokens"}
                  onClick={() => setMetric("tokens")}
                >
                  Tokens
                </button>
              </div>
            </header>
            <UsageChart points={report.daily} metric={metric} />
          </section>

          <div className="usage-panels-grid">
            <section className="usage-panel" aria-labelledby="usage-provider-title">
              <header className="usage-panel-header">
                <div>
                  <h2 id="usage-provider-title">By provider</h2>
                  <p>Processed-token share across local adapters.</p>
                </div>
              </header>
              <ProviderRows providers={report.providers} />
            </section>
            <section className="usage-panel" aria-labelledby="usage-model-title">
              <header className="usage-panel-header">
                <div>
                  <h2 id="usage-model-title">Model breakdown</h2>
                  <p>Top models by processed tokens.</p>
                </div>
              </header>
              <div className="usage-model-list" role="list" aria-label="Usage by model">
                {topModels.map((model) => (
                  <div
                    className="usage-model-row"
                    role="listitem"
                    key={`${model.provider}-${model.model ?? "unknown"}`}
                  >
                    <div>
                      <strong>{model.model ?? "Model unavailable"}</strong>
                      <small>
                        {providerLabel(model.provider)} · {model.turns} turn
                        {model.turns === 1 ? "" : "s"}
                      </small>
                    </div>
                    <span>{formatTokens(model.processedTokens)}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
