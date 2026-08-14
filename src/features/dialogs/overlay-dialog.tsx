import React from "react";
import { WorkbenchDialog } from "../../components/ui";

export function OverlayDialog({
  title,
  children,
  onClose,
  dismissible = true,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  dismissible?: boolean;
}) {
  return (
    <WorkbenchDialog
      open
      onClose={onClose}
      dismissible={dismissible}
      title={title}
      titleId="quick-dialog-title"
      className="quick-dialog"
      backdropClassName="dialog-backdrop"
      closeLabel={`Close ${title}`}
    >
      {children}
    </WorkbenchDialog>
  );
}
