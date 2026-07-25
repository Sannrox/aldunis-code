import React, { FormEvent, useEffect, useRef, useState } from "react";
import { WorkbenchDialog } from "../../components/ui";

export function OverlayDialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <WorkbenchDialog open onClose={onClose} title={title} titleId="quick-dialog-title" className="quick-dialog" backdropClassName="dialog-backdrop" closeLabel={`Close ${title}`}>
      {children}
    </WorkbenchDialog>
  );
}


