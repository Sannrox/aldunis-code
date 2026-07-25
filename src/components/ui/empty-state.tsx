import React, { type HTMLAttributes, type ReactNode } from "react";
import { variants } from "./variants";

export type EmptyStateVariant = "default" | "panel";

const emptyClass = variants(
  "ui-empty",
  {
    variant: {
      default: "ui-empty--default",
      panel: "ui-empty--panel",
    },
  },
  { variant: "default" },
);

export type EmptyStateProps = HTMLAttributes<HTMLDivElement> & {
  variant?: EmptyStateVariant;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
};

export function EmptyState({
  variant = "default",
  eyebrow,
  title,
  description,
  action,
  className,
  children,
  ...props
}: EmptyStateProps) {
  return (
    <div className={emptyClass({ variant, className })} {...props}>
      {eyebrow != null && <span className="ui-empty__eyebrow">{eyebrow}</span>}
      <h2 className="ui-empty__title">{title}</h2>
      {description != null && <p className="ui-empty__description">{description}</p>}
      {action}
      {children}
    </div>
  );
}
