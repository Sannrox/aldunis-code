import React, { type ReactNode } from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";

export type WorkbenchPopoverProps = {
  trigger: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
};

export function WorkbenchPopover({
  trigger,
  children,
  side = "bottom",
  className = "ui-popover",
}: WorkbenchPopoverProps) {
  return (
    <BasePopover.Root>
      <BasePopover.Trigger className="ui-popover__trigger">
        {trigger}
      </BasePopover.Trigger>
      <BasePopover.Portal>
        <BasePopover.Positioner side={side} sideOffset={6}>
          <BasePopover.Popup className={className}>{children}</BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}

export const Popover = BasePopover;
