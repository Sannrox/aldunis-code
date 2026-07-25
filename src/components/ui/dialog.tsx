import React, { type ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { CloseButton } from "./button";

export type WorkbenchDialogProps = {
  open: boolean;
  onClose: () => void;
  /** When false, Escape and outside press do not close (e.g. busy mutations). */
  dismissible?: boolean;
  title?: ReactNode;
  titleId?: string;
  /** Accessible name when title is not rendered as text. */
  ariaLabel?: string;
  className?: string;
  /** Extra class on the backdrop. */
  backdropClassName?: string;
  children: ReactNode;
  /** Optional header actions (refresh, etc.) rendered before the close control. */
  headerActions?: ReactNode;
  showClose?: boolean;
  closeLabel?: string;
  initialFocus?: boolean;
};

/**
 * Overlay dialog built on @base-ui/react.
 * Replaces the hand-rolled useDialogFocus focus trap + Escape handling.
 */
export function WorkbenchDialog({
  open,
  onClose,
  dismissible = true,
  title,
  titleId = "dialog-title",
  ariaLabel,
  className = "ui-dialog",
  backdropClassName = "ui-dialog-backdrop",
  children,
  headerActions,
  showClose = true,
  closeLabel = "Close",
}: WorkbenchDialogProps) {
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissible) onClose();
      }}
      disablePointerDismissal={!dismissible}
      modal
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdropClassName} />
        <BaseDialog.Popup
          className={className}
          aria-labelledby={title ? titleId : undefined}
          aria-label={ariaLabel}
        >
          {(title != null || showClose || headerActions) && (
            <header className="ui-dialog__header">
              <div className="ui-dialog__heading">
                {title != null && (
                  <BaseDialog.Title id={titleId} className="ui-dialog__title">
                    {title}
                  </BaseDialog.Title>
                )}
              </div>
              <div className="ui-dialog__actions">
                {headerActions}
                {showClose && (
                  <CloseButton
                    label={closeLabel}
                    disabled={!dismissible}
                    onClick={onClose}
                  />
                )}
              </div>
            </header>
          )}
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export const Dialog = BaseDialog;

/**
 * Focus-trapped modal surface for full-screen panels that already have layout CSS.
 * Replaces hand-rolled useDialogFocus.
 */
export function ModalSurface({
  open,
  onClose,
  dismissible = true,
  className,
  children,
  ariaLabel,
  ariaLabelledBy,
  withBackdrop = true,
  backdropClassName = "dialog-backdrop",
}: {
  open: boolean;
  onClose: () => void;
  dismissible?: boolean;
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  withBackdrop?: boolean;
  backdropClassName?: string;
}) {
  // Base UI keeps Backdrop and Popup as Portal siblings. Popup CSS must
  // position itself (fixed + centered); nesting Popup inside Backdrop breaks focus.
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissible) onClose();
      }}
      disablePointerDismissal={!dismissible}
      modal
    >
      <BaseDialog.Portal>
        {withBackdrop && <BaseDialog.Backdrop className={backdropClassName} />}
        <BaseDialog.Popup
          className={className}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
        >
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/**
 * Nested dialog surface (e.g. revision preview inside the review panel).
 * Stops Escape propagation so the parent dialog stays open — regression for fea9931.
 */
export function NestedDialogSurface({
  open,
  onClose,
  className,
  ariaLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  className?: string;
  ariaLabel: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <section
      className={className}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      ref={(node) => {
        node?.focus();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          onClose();
        }
      }}
    >
      {children}
    </section>
  );
}

/**
 * Escape handler for nested composers: dismiss local draft only.
 * Regression for fea9931 (comment Escape must not close the review panel).
 */
export function handleNestedEscape(
  event: { key: string; stopPropagation: () => void; preventDefault: () => void },
  onDismiss: () => void,
): boolean {
  if (event.key !== "Escape") return false;
  event.stopPropagation();
  event.preventDefault();
  onDismiss();
  return true;
}
