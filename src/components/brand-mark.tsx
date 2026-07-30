import React from "react";

export function AldunisBrandMark({ className = "" }: { className?: string }) {
  return (
    <span className={`aldunis-brand-mark ${className}`.trim()} aria-hidden="true">
      <img className="aldunis-brand-mark__light" src="/aldunis-mark-light.png" alt="" />
      <img className="aldunis-brand-mark__dark" src="/aldunis-mark-dark.png" alt="" />
    </span>
  );
}
