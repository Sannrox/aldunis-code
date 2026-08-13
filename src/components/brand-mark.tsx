import React from "react";

export function AldunisBrandMark({ className = "" }: { className?: string }) {
  return <span className={`aldunis-brand-mark ${className}`.trim()} aria-hidden="true" />;
}
