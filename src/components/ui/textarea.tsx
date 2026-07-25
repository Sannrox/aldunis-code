import React, { type TextareaHTMLAttributes } from "react";
import { variants } from "./variants";

export type TextareaSize = "sm" | "md";

const textareaClass = variants(
  "ui-textarea",
  {
    size: {
      sm: "ui-textarea--sm",
      md: "ui-textarea--md",
    },
  },
  { size: "md" },
);

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  size?: TextareaSize;
};

export function Textarea({ size = "md", className, ...props }: TextareaProps) {
  return <textarea className={textareaClass({ size, className })} {...props} />;
}
