import React, { type InputHTMLAttributes } from "react";
import { variants } from "./variants";

export type InputSize = "sm" | "md";

const inputClass = variants(
  "ui-input",
  {
    size: {
      sm: "ui-input--sm",
      md: "ui-input--md",
    },
  },
  { size: "md" },
);

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: InputSize;
};

export function Input({ size = "md", className, ...props }: InputProps) {
  return <input className={inputClass({ size, className })} {...props} />;
}
