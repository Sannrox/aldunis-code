import React, { type ReactNode } from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";

export type WorkbenchTooltipProps = {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
};

export function WorkbenchTooltip({
  content,
  children,
  side = "top",
  className = "ui-tooltip",
}: WorkbenchTooltipProps) {
  return (
    <BaseTooltip.Provider>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger className="ui-tooltip__trigger">
          {children}
        </BaseTooltip.Trigger>
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner side={side} sideOffset={6}>
            <BaseTooltip.Popup className={className}>{content}</BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}

export const Tooltip = BaseTooltip;
