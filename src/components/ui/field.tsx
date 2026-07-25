import React, { type HTMLAttributes, type LabelHTMLAttributes, type ReactNode } from "react";
import { variants } from "./variants";

const fieldClass = variants(
  "ui-field",
  {
    variant: {
      default: "ui-field--default",
      inline: "ui-field--inline",
    },
  },
  { variant: "default" },
);

export type FieldProps = HTMLAttributes<HTMLDivElement> & {
  variant?: "default" | "inline";
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children?: ReactNode;
  htmlFor?: string;
  labelProps?: LabelHTMLAttributes<HTMLLabelElement>;
};

export function Field({
  variant = "default",
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
  labelProps,
  ...props
}: FieldProps) {
  return (
    <div className={fieldClass({ variant, className })} {...props}>
      {label != null && (
        <label className="ui-field__label" htmlFor={htmlFor} {...labelProps}>
          {label}
        </label>
      )}
      {children}
      {hint != null && !error && <span className="ui-field__hint">{hint}</span>}
      {error != null && <span className="ui-field__error" role="alert">{error}</span>}
    </div>
  );
}
