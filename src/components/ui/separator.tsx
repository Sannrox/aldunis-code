import React, { type HTMLAttributes } from "react";
import { variants } from "./variants";

export type SeparatorOrientation = "horizontal" | "vertical";

const separatorClass = variants(
  "ui-separator",
  {
    orientation: {
      horizontal: "ui-separator--horizontal",
      vertical: "ui-separator--vertical",
    },
  },
  { orientation: "horizontal" },
);

export type SeparatorProps = HTMLAttributes<HTMLDivElement> & {
  orientation?: SeparatorOrientation;
};

export function Separator({ orientation = "horizontal", className, ...props }: SeparatorProps) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={separatorClass({ orientation, className })}
      {...props}
    />
  );
}
