import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui";

const COPY_FEEDBACK_DURATION_MS = 2_000;

type CopyStatus = "idle" | "copied" | "failed";

export function MessageCopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFeedbackTimeout = useCallback(() => {
    if (timeoutRef.current === null) return;
    clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  useEffect(() => clearFeedbackTimeout, [clearFeedbackTimeout]);

  const copyMessage = useCallback(async () => {
    if (!text.trim() || status === "copied") return;

    clearFeedbackTimeout();
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable.");
      }
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    timeoutRef.current = setTimeout(() => {
      setStatus("idle");
      timeoutRef.current = null;
    }, COPY_FEEDBACK_DURATION_MS);
  }, [clearFeedbackTimeout, status, text]);

  const copied = status === "copied";
  const statusMessage = copied
    ? `${label} copied`
    : status === "failed"
      ? `${label} could not be copied`
      : "";

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={`message-copy-button ${copied ? "is-copied" : ""}`.trim()}
        aria-label={copied ? `${label} copied` : label}
        title={copied ? `${label} copied` : `${label} to clipboard`}
        disabled={copied}
        onClick={() => void copyMessage()}
      >
        {copied ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 12 4 4L19 6" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
          </svg>
        )}
      </Button>
      <span className="sr-only" aria-live="polite">{statusMessage}</span>
    </>
  );
}
