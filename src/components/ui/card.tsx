import React, { type HTMLAttributes, type ReactNode } from "react";
import { variants } from "./variants";

export type CardVariant = "default" | "elevated" | "muted" | "warning" | "danger";

const cardClass = variants(
  "ui-card",
  {
    variant: {
      default: "ui-card--default",
      elevated: "ui-card--elevated",
      muted: "ui-card--muted",
      warning: "ui-card--warning",
      danger: "ui-card--danger",
    },
  },
  { variant: "default" },
);

export type CardProps = HTMLAttributes<HTMLElement> & {
  variant?: CardVariant;
  as?: "div" | "section" | "article";
  children?: ReactNode;
};

export function Card({
  variant = "default",
  as: Tag = "div",
  className,
  children,
  ...props
}: CardProps) {
  return (
    <Tag className={cardClass({ variant, className })} {...props}>
      {children}
    </Tag>
  );
}
