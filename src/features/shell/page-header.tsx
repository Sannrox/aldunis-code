import React, { useEffect, useRef, useState } from "react";
import type { Product, IconName } from "../../types";
import { Icon } from "../../components/icon";
import { Button } from "../../components/ui";
import {
  DEFAULT_PRODUCT_AVAILABILITY,
  isProductAvailable,
  type ProductAvailability,
} from "../../lib/product-availability";
import { AldunisBrandMark } from "../../components/brand-mark";

const nav: Array<{ id: Product; label: string; icon: IconName; detail: string; mark: string }> = [
  { id: "code", label: "Code", icon: "code", detail: "Local workbench", mark: "A" },
  { id: "sekai", label: "Sekai", icon: "spark", detail: "Knowledge plane", mark: "S" },
  { id: "chisei", label: "Chisei", icon: "shield", detail: "Governance plane", mark: "C" },
  { id: "tenkai", label: "Tenkai", icon: "rocket", detail: "Delivery plane", mark: "T" },
];

/**
 * Slim top chrome. Product switching is the brand control (mock pattern).
 */
export function PageHeader({
  product,
  onChange,
  onSettings,
  productAvailability = DEFAULT_PRODUCT_AVAILABILITY,
}: {
  product: Product;
  onChange: (product: Product) => void;
  onSettings: () => void;
  productAvailability?: ProductAvailability;
}) {
  const current = nav.find((item) => item.id === product)!;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      const map: Record<string, Product> = {
        Digit1: "code", Digit2: "sekai", Digit3: "chisei", Digit4: "tenkai",
        "1": "code", "2": "sekai", "3": "chisei", "4": "tenkai",
      };
      const next = map[event.code] ?? map[event.key];
      if (!next || !isProductAvailable(next, productAvailability)) return;
      event.preventDefault();
      onChange(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onChange, productAvailability]);

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
    <header className="page-header mock-topbar">
      <div className="brand-switch" ref={menuRef}>
        <button
          type="button"
          className="mock-brandbtn"
          aria-label={`Product: ${current.label}. Open product switcher`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <span className="mock-logo sm" aria-hidden="true">
            {product === "code" ? <AldunisBrandMark /> : current.mark}
          </span>
          <span className="mock-brand-label">{current.label}</span>
          <Icon name="chevron" />
        </button>
        {menuOpen && (
          <div className="brand-switch__menu mock-pswitch" role="menu" aria-label="Products">
            {nav.map((item) => {
              const available = isProductAvailable(item.id, productAvailability);
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.id === product}
                  aria-disabled={!available}
                  disabled={!available}
                  key={item.id}
                  className={`${item.id === product ? "active" : ""} ${available ? "" : "dis"}`.trim()}
                  onClick={() => {
                    if (!available) return;
                    onChange(item.id);
                    setMenuOpen(false);
                  }}
                >
                  <span className={`mock-logo xs ${item.id === product ? "on" : ""}`} aria-hidden="true">
                    {item.id === "code" ? <AldunisBrandMark /> : item.mark}
                  </span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{available ? item.detail : "Not configured"}</small>
                  </span>
                  <kbd>⌘⇧{nav.indexOf(item) + 1}</kbd>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="page-settings mock-settings"
        aria-label="Settings"
        onClick={onSettings}
      >
        Settings
      </Button>
    </header>
  );
}
