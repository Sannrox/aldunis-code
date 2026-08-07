import React, { useId, useState } from "react";
import {
  formatContextWindowPercentage,
  formatContextWindowTokens,
  type ContextWindowSnapshot,
} from "../../lib/context-window";

/**
 * Compact T3-inspired context ring. Muted at rest; warning hue only when
 * usage exceeds 90%. Renders nothing when the parent has no snapshot.
 */
export function ContextWindowMeter({ usage }: { usage: ContextWindowSnapshot }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const usedPercentage = formatContextWindowPercentage(usage.usedPercentage);
  const normalized = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalized / 100);
  const overloaded = usage.usedPercentage !== null && usage.usedPercentage > 90;
  const stroke = overloaded
    ? "var(--destructive-foreground, var(--destructive))"
    : "color-mix(in srgb, var(--muted-foreground) 72%, transparent)";
  const track = "color-mix(in srgb, var(--muted-foreground) 24%, transparent)";
  const label =
    usage.maxTokens !== null && usedPercentage
      ? `Context window ${usedPercentage} used`
      : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`;

  return (
    <div className="context-window-meter">
      <button
        type="button"
        className={`context-window-meter__trigger ${overloaded ? "is-hot" : ""}`}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={label}
        onClick={() => setOpen((value) => !value)}
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node)) {
            setOpen(false);
          }
        }}
      >
        <span className="context-window-meter__ring" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="context-window-meter__svg">
            <circle cx="12" cy="12" r={radius} fill="none" stroke={track} strokeWidth="3" />
            <circle
              cx="12"
              cy="12"
              r={radius}
              fill="none"
              stroke={stroke}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
            />
          </svg>
        </span>
      </button>
      {open && (
        <div
          id={panelId}
          className="context-window-meter__panel"
          role="region"
          aria-label="Context window details"
        >
          <div className="context-window-meter__row">
            <span>Context window</span>
            {usage.maxTokens !== null && usedPercentage ? (
              <span className="context-window-meter__nums">
                {usedPercentage}
                <span aria-hidden="true"> · </span>
                {formatContextWindowTokens(usage.usedTokens)}/
                {formatContextWindowTokens(usage.maxTokens)}
              </span>
            ) : (
              <span className="context-window-meter__nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </span>
            )}
          </div>
          {usage.maxTokens !== null && (
            <div
              className="context-window-meter__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalized)}
              aria-label="Context window usage"
            >
              <i style={{ width: `${normalized}%`, background: stroke }} />
            </div>
          )}
          <dl className="context-window-meter__meta">
            {usage.remainingTokens !== null && (
              <>
                <dt>Remaining</dt>
                <dd>{formatContextWindowTokens(usage.remainingTokens)}</dd>
              </>
            )}
            {usage.inputTokens !== null && (
              <>
                <dt>Input</dt>
                <dd>{formatContextWindowTokens(usage.inputTokens)}</dd>
              </>
            )}
            {usage.outputTokens !== null && (
              <>
                <dt>Output</dt>
                <dd>{formatContextWindowTokens(usage.outputTokens)}</dd>
              </>
            )}
            {usage.totalProcessedTokens !== null &&
              usage.totalProcessedTokens > 0 &&
              usage.totalProcessedTokens !== usage.usedTokens && (
                <>
                  <dt>Session total</dt>
                  <dd>{formatContextWindowTokens(usage.totalProcessedTokens)}</dd>
                </>
              )}
          </dl>
          <p className="context-window-meter__note">
            Live from the provider. Not stored in conversation history.
          </p>
        </div>
      )}
    </div>
  );
}
