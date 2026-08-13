import React, { Component, Suspense, useLayoutEffect, type ErrorInfo, type ReactNode } from "react";
import { Button, WorkbenchDialog } from "./ui";

interface OptionalControlBoundaryProps {
  label: string;
  onDismiss: () => void;
  onReload?: () => void;
  pendingDialog?: boolean;
  /** Destination-shaped chrome while the optional chunk is pending. Dialogs keep `null`. */
  fallback?: ReactNode;
  /** True while Suspense is showing `fallback`; false once content paints or recovery opens. */
  onPendingChange?: (pending: boolean) => void;
  children?: ReactNode;
}

interface OptionalControlBoundaryState {
  failed: boolean;
}

function OptionalControlPendingReporter({
  pending,
  onPendingChange,
}: {
  pending: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  useLayoutEffect(() => {
    onPendingChange?.(pending);
    return () => {
      if (pending) onPendingChange?.(false);
    };
  }, [onPendingChange, pending]);
  return null;
}

/** Keep an optional chunk failure from taking down the eager workbench. */
export class OptionalControlBoundary extends Component<
  OptionalControlBoundaryProps,
  OptionalControlBoundaryState
> {
  state: OptionalControlBoundaryState = { failed: false };

  static getDerivedStateFromError(): OptionalControlBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _details: ErrorInfo): void {
    // Lazy-load failures are intentionally projected without local paths or URLs.
  }

  componentDidMount(): void {
    if (this.state.failed) this.props.onPendingChange?.(false);
  }

  componentDidUpdate(
    _previous: OptionalControlBoundaryProps,
    previousState: OptionalControlBoundaryState,
  ): void {
    if (this.state.failed && !previousState.failed) this.props.onPendingChange?.(false);
  }

  render(): ReactNode {
    if (!this.state.failed) {
      const fallback = this.props.pendingDialog ? (
        <WorkbenchDialog
          open
          ariaLabel={`${this.props.label} loading`}
          className="ui-dialog optional-control-error"
          onClose={this.props.onDismiss}
          showClose={false}
        >
          <p role="status">Loading {this.props.label.toLowerCase()}…</p>
        </WorkbenchDialog>
      ) : (
        (this.props.fallback ?? null)
      );
      return (
        <Suspense
          fallback={
            <>
              <OptionalControlPendingReporter
                pending
                onPendingChange={this.props.onPendingChange}
              />
              {fallback}
            </>
          }
        >
          <OptionalControlPendingReporter
            pending={false}
            onPendingChange={this.props.onPendingChange}
          />
          {this.props.children}
        </Suspense>
      );
    }
    return (
      <WorkbenchDialog
        open
        ariaLabel={`${this.props.label} could not be loaded`}
        className="ui-dialog optional-control-error"
        onClose={this.props.onDismiss}
        showClose={false}
      >
        <h2 className="ui-dialog__title">{this.props.label} could not be loaded</h2>
        <p role="alert">
          The optional interface chunk is unavailable. Reload Aldunis Code and try again.
        </p>
        <footer className="ui-dialog__actions">
          <Button variant="secondary" onClick={this.props.onDismiss}>
            Close
          </Button>
          <Button onClick={() => (this.props.onReload ?? (() => window.location.reload()))()}>
            Reload
          </Button>
        </footer>
      </WorkbenchDialog>
    );
  }
}
