import React, { type Components } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Render provider assistant (and similar) markdown safely.
 * No raw HTML: react-markdown strips it by default.
 * GFM enables tables, strikethrough, task lists, and autolinks.
 */
const components: Components = {
  a: ({ href, children, ...props }) => (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  ),
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
