import React, { type HTMLAttributes, type ReactNode } from "react";
import { variants } from "./variants";

export type BannerVariant = "default" | "warning" | "danger" | "info";

const bannerClass = variants(
  "ui-banner",
  {
    variant: {
      default: "ui-banner--default",
      warning: "ui-banner--warning",
      danger: "ui-banner--danger",
      info: "ui-banner--info",
    },
  },
  { variant: "default" },
);

export type BannerProps = HTMLAttributes<HTMLDivElement> & {
  variant?: BannerVariant;
  children?: ReactNode;
};

export function Banner({ variant = "default", className, children, ...props }: BannerProps) {
  return (
    <div className={bannerClass({ variant, className })} role="status" {...props}>
      {children}
    </div>
  );
}
