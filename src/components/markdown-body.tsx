import React, { type Components } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Only http(s) and mailto should become real anchors. Repo-relative paths
 * like `docs/settings.md` must not resolve against the workbench origin
 * (that produces dead links such as http://127.0.0.1:4174/docs/…).
 */
export function isNavigableMarkdownHref(href: string | undefined): boolean {
  if (!href) return false;
  const trimmed = href.trim();
  if (!trimmed) return false;
  // Protocol-relative or absolute http(s)/mailto only.
  return /^(https?:\/\/|mailto:)/i.test(trimmed);
}

/**
 * Render provider assistant (and similar) markdown safely.
 * No raw HTML: react-markdown strips it by default.
 * GFM enables tables, strikethrough, task lists, and autolinks.
 */
const components: Components = {
  a: ({ href, children }) => {
    if (isNavigableMarkdownHref(href)) {
      return (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      );
    }
    // Path / fragment / unknown scheme: show as path text, not a dead link.
    const label = typeof children === "string" && children.trim()
      ? children
      : (href ?? "");
    return (
      <code className="md-code-inline md-path" title={href}>
        {label}
      </code>
    );
  },
  // Avoid nesting <p> inside our turn layout; block content owns spacing.
  p: ({ children }) => <p className="md-p">{children}</p>,
  pre: ({ children }) => <pre className="md-pre">{children}</pre>,
  code: ({ className, children, ...props }) => {
    const isBlock = typeof className === "string" && className.includes("language-");
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="md-code-inline" {...props}>
        {children}
      </code>
    );
  },
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

export function MarkdownBody({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  if (!text) return null;
  return (
    <div className={`md-body ${className}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
