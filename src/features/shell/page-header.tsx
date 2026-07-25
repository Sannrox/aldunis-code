import React, { useEffect, useRef, useState } from "react";
import type { Product, IconName } from "../../types";
import { Icon } from "../../components/icon";
import { Button } from "../../components/ui";

const nav: Array<{ id: Product; label: string; icon: IconName; detail: string }> = [
  { id: "code", label: "Code", icon: "code", detail: "Local workbench" },
  { id: "sekai", label: "Sekai", icon: "spark", detail: "Knowledge & evidence" },
  { id: "chisei", label: "Chisei", icon: "shield", detail: "Policy & routing" },
  { id: "tenkai", label: "Tenkai", icon: "rocket", detail: "Delivery & recovery" },
];

/**
 * Product switching on the brand mark (+ shortcuts). No extra chrome.
 */
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      const map: Record<string, Product> = {
        Digit1: "code",
        Digit2: "sekai",
        Digit3: "chisei",
        Digit4: "tenkai",
        "1": "code",
        "2": "sekai",
        "3": "chisei",
        "4": "tenkai",
      };
      const next = map[event.code] ?? map[event.key];
      if (!next) return;
      event.preventDefault();
      onChange(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onChange]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onEscape);
    };
  }, [menuOpen]);

  return (
    <header className="page-header">
      <div className="brand-switch" ref={menuRef}>
        <button
          type="button"
          className="aldunis-mark brand-switch__trigger"
          aria-label={`Product: ${current.label}. Open product switcher`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          {current.label.charAt(0)}
        </button>
        {menuOpen && (
          <div className="brand-switch__menu" role="menu" aria-label="Products">
            {nav.map((item) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={item.id === product}
                key={item.id}
                className={item.id === product ? "active" : ""}
                onClick={() => {
                  onChange(item.id);
                  setMenuOpen(false);
                }}
              >
                <Icon name={item.icon} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
              </button>
            ))}
            <p className="brand-switch__hint">⌘⇧1–4 · Code · Sekai · Chisei · Tenkai</p>
          </div>
        )}
      </div>
      <div className="page-selector page-selector--static" aria-label="Current product">
        <span>Page</span>
        <span className="page-selector-current">
          <Icon name={current.icon} />
          <span className="page-selector-label">{current.label} — {current.detail}</span>
        </span>
      </div>
      <Button
        variant="default"
        size="sm"
        className="page-settings"
        aria-label="Settings"
        onClick={onSettings}
      >
        <Icon name="settings" />
        <span>Settings</span>
      </Button>
    </header>
  );
}
