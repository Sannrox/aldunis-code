import React, { type HTMLAttributes, type ReactNode } from "react";
import { variants } from "./variants";

export type BadgeVariant = "default" | "amber" | "indigo" | "destructive" | "muted";

const badgeClass = variants(
  "ui-badge",
  {
    variant: {
      default: "ui-badge--default",
      amber: "ui-badge--amber",
      indigo: "ui-badge--indigo",
      destructive: "ui-badge--destructive",
      muted: "ui-badge--muted",
    },
  },
  { variant: "default" },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
  children?: ReactNode;
};

export function Badge({ variant = "default", className, children, ...props }: BadgeProps) {
  return (
    <span className={badgeClass({ variant, className })} {...props}>
      {children}
    </span>
  );
}
