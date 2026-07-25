import React from "react";
import type { Product, IconName } from "../../types";
import { Icon } from "../../components/icon";

const productPages = {
  sekai: {
    eyebrow: "Knowledge plane",
    title: "Trace what the system knows.",
    summary: "Evidence, provenance, artifacts, and lineage — projected once a Sekai contract is attached.",
    items: ["Knowledge", "Evidence", "Provenance", "Artifacts", "Explorer"],
    icon: "spark" as IconName,
    integration: "projected" as const,
    boundary:
      "These are routes that would be projected once a contract is attached. Do not treat local exploration as knowledge-plane authority.",
  },
  chisei: {
    eyebrow: "Governance plane",
    title: "Make every decision inspectable.",
    summary: "Policies, budgets, model routing, usage, and audit remain governed by Sekai Chisei contracts.",
    items: ["Operations", "Policies", "Budgets", "Models", "Routing", "Usage", "Audit"],
    icon: "shield" as IconName,
    integration: "projected" as const,
    boundary:
      "Approvals granted locally in Code are not policy decisions. Chisei is a remote contract — not a local database shared with this workbench.",
  },
  tenkai: {
    eyebrow: "Delivery plane",
    title: "Ship with a way back.",
    summary: "Releases, environments, deployments, rollback, and recovery remain authoritative in Tenkai.",
    items: ["Releases", "Channels", "Environments", "Plans", "Approvals", "Runs", "Recovery"],
    icon: "rocket" as IconName,
    integration: "embedded" as const,
    boundary:
      "A merged worktree is not a release. Local Tenkai-facing UI may embed, but delivery authority stays in Tenkai.",
  },
};

export function DomainPage({ product }: { product: Exclude<Product, "code"> }) {
  const page = productPages[product];
  return (
    <main className={`domain-page ${product}`}>
      <div className="domain-orbit"><Icon name={page.icon} /></div>
      <p className="eyebrow">
        {page.eyebrow} · {page.integration === "embedded" ? "local integration" : "projected contract"}
      </p>
      <h1>{page.title}</h1>
      <p className="domain-summary">{page.summary}</p>
      <div className="domain-grid">
        {page.items.map((item, index) => (
          <button type="button" key={item}>
            <span>0{index + 1}</span>
            <strong>{item}</strong>
            <Icon name="chevron" />
          </button>
        ))}
      </div>
      <aside className="boundary-note">
        <span>BOUNDARY</span>
        {page.boundary}
      </aside>
    </main>
  );
}
