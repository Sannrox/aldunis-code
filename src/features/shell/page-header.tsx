import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { Product, IconName } from "../../types";
import { Icon } from "../../components/icon";
import { Button } from "../../components/ui";

const nav: Array<{ id: Product; label: string; icon: IconName; detail: string }> = [
  { id: "code", label: "Code", icon: "code", detail: "Local workbench" },
  { id: "sekai", label: "Sekai", icon: "spark", detail: "Knowledge & evidence" },
  { id: "chisei", label: "Chisei", icon: "shield", detail: "Policy & routing" },
  { id: "tenkai", label: "Tenkai", icon: "rocket", detail: "Delivery & recovery" },
];

export function PageHeader({
  product,
  onChange,
  onSettings,
}: {
  product: Product;
  onChange: (product: Product) => void;
  onSettings: () => void;
}) {
  const current = nav.find((item) => item.id === product)!;
  return (
    <header className="page-header">
      <span className="aldunis-mark" aria-hidden="true">A</span>
      <label className="page-selector">
        <span>Page</span>
        <span className="page-selector-current">
          <Icon name={current.icon} />
          <select
            value={product}
            onChange={(event) => onChange(event.target.value as Product)}
            aria-label="Current page"
          >
            {nav.map((item) => (
              <option value={item.id} key={item.id}>{item.label} — {item.detail}</option>
            ))}
          </select>
          <Icon name="chevron" />
        </span>
      </label>
      <Button variant="default" size="sm" className="page-settings" aria-label="Appearance and keyboard settings" onClick={onSettings}>
        <Icon name="settings" />
        <span>Preferences</span>
      </Button>
    </header>
  );
}


