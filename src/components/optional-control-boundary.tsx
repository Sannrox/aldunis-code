import React, { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
import { Button, WorkbenchDialog } from "./ui";

interface OptionalControlBoundaryProps {
  label: string;
  onDismiss: () => void;
  onReload?: () => void;
  children?: ReactNode;
}

interface OptionalControlBoundaryState {
  failed: boolean;
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

  render(): ReactNode {
    if (!this.state.failed) return <Suspense fallback={null}>{this.props.children}</Suspense>;
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
