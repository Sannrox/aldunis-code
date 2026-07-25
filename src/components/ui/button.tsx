import React, { type ButtonHTMLAttributes, type ReactNode } from "react";
import { variants } from "./variants";

/**
 * Button matrix (from styles.css audit, not the mock):
 *
 * | variant   | Sources |
 * |-----------|---------|
 * | default   | dialog cancel, header-actions, approval footer secondary, changes header, annotation, checkpoint, preview-panel, directory footer |
 * | primary   | .primary, .allow-once, conversation-empty CTA, preview-setup, file-preview attach |
 * | secondary | sidebar footer Connect, pane-switcher, solid muted fills |
 * | ghost     | .ghost, section-label, chip remove, open-beside, conversation-actions |
 * | danger    | .danger, .worktree-remove |
 *
 * | size | Sources |
 * |------|---------|
 * | xs   | annotation / revision / small mono actions (~.55rem) |
 * | sm   | dialog/approval footers, sidebar footer (~.6–.65rem, ~30px) |
 * | md   | header-actions, default controls (32px, .65–.7rem) |
 * | lg   | conversation-empty, missing-conversation (34–36px) |
 * | icon | square 32px close / header ghost |
 * | icon-sm | square 28–31px sidebar/header icon |
 */
export type ButtonVariant = "default" | "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon" | "icon-sm";

const buttonClass = variants(
  "ui-button",
  {
    variant: {
      default: "ui-button--default",
      primary: "ui-button--primary",
      secondary: "ui-button--secondary",
      ghost: "ui-button--ghost",
      danger: "ui-button--danger",
    },
    size: {
      xs: "ui-button--xs",
      sm: "ui-button--sm",
      md: "ui-button--md",
      lg: "ui-button--lg",
      icon: "ui-button--icon",
      "icon-sm": "ui-button--icon-sm",
    },
  },
  { variant: "default", size: "md" },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
};

export function Button({
  variant = "default",
  size = "md",
  className,
  type = "button",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, className })}
      {...props}
    >
      {children}
    </button>
  );
}

/** Dismiss control used across dialogs and full-screen panels. */
export function CloseButton({
  label,
  className,
  size = "icon",
  variant = "secondary",
  ...props
}: { label: string } & Omit<ButtonProps, "children" | "aria-label">) {
  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      aria-label={label}
      {...props}
    >
      ×
    </Button>
  );
}
