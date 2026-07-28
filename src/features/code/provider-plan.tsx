import { useState } from "react";
import type { ProviderPlanArtifact } from "../../types";
import { MarkdownBody } from "../../components/markdown-body";
import { planMarkdown } from "../../lib/provider-plan";

function downloadPlan(plan: ProviderPlanArtifact): void {
  const stem = (plan.title?.trim() || "provider-plan")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "provider-plan";
  const url = URL.createObjectURL(new Blob([planMarkdown(plan)], { type: "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${stem}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ProviderPlanContent({ plan }: { plan: ProviderPlanArtifact }) {
  return (
    <div className="provider-plan-content">
      {plan.body?.trim() && <MarkdownBody text={plan.body} className="turn-md" />}
      {plan.steps?.length ? (
        <ol className="provider-plan-steps" aria-label="Plan steps">
          {plan.steps.map((step, index) => (
            <li className={`provider-plan-step is-${step.status}`} key={`${index}-${step.content}`}>
              <span className="provider-plan-status" aria-label={step.status}>
                {step.status === "completed" ? "✓" : step.status === "active" ? "●" : "○"}
              </span>
              <span>{step.content}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function ProviderPlanActions({ plan }: { plan: ProviderPlanArtifact }) {
  const [copyStatus, setCopyStatus] = useState("");
  return (
    <div className="provider-plan-actions">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => {
          void navigator.clipboard.writeText(planMarkdown(plan))
            .then(() => setCopyStatus("Plan copied"))
            .catch(() => setCopyStatus("Copy failed"));
        }}
      >
        Copy Markdown
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => downloadPlan(plan)}>
        Download .md
      </button>
      <span className="sr-only" aria-live="polite">{copyStatus}</span>
    </div>
  );
}

export function ProviderPlanCard({
  plan,
  providerLabel,
  onOpen,
}: {
  plan: ProviderPlanArtifact;
  providerLabel: string;
  onOpen: () => void;
}) {
  return (
    <details className="provider-plan-card">
      <summary>
        <span>
          <strong>{plan.title?.trim() || "Plan"}</strong>
          <small>{providerLabel}</small>
        </span>
        <span aria-hidden="true">Expand</span>
      </summary>
      <ProviderPlanContent plan={plan} />
      <div className="provider-plan-card-footer">
        <ProviderPlanActions plan={plan} />
        <button type="button" className="btn btn-default btn-sm" onClick={onOpen}>
          Open plan
        </button>
      </div>
    </details>
  );
}
