import React, { type HTMLAttributes } from "react";
import { variants } from "./variants";

export type SpinnerSize = "sm" | "md";

const spinnerClass = variants(
  "ui-spinner",
  {
    size: {
      sm: "ui-spinner--sm",
      md: "ui-spinner--md",
    },
  },
  { size: "md" },
);

export type SpinnerProps = HTMLAttributes<HTMLSpanElement> & {
  size?: SpinnerSize;
  label?: string;
};

export function Spinner({ size = "md", label = "Working", className, ...props }: SpinnerProps) {
  return (
    <span
      className={spinnerClass({ size, className })}
      role="status"
      aria-label={label}
      {...props}
    />
  );
}
