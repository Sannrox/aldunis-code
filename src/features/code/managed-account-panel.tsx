import React from "react";
import type { ManagedAccount } from "../../types";

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts.at(-1)![0]}`.toUpperCase();
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function ManagedAccountPanel({ account }: { account: ManagedAccount }) {
  const expiry = account.sessionExpiresAt ?? account.assertionExpiresAt;
  const expiryLabel = account.sessionExpiresAt
    ? "Account session expires"
    : "Access assertion expires";

  return (
    <details className="managed-account">
      <summary
        className="managed-account__summary"
        aria-label={`Enterprise account: ${account.displayName}`}
      >
        <span className="managed-account__avatar" aria-hidden="true">{initials(account.displayName)}</span>
        <span className="managed-account__summary-copy">
          <strong title={account.displayName}>{account.displayName}</strong>
          <small title={account.tenantId}>Enterprise · {account.tenantId}</small>
        </span>
        <span className="managed-account__chevron" aria-hidden="true">⌃</span>
      </summary>
      <div className="managed-account__panel">
        <p className="managed-account__eyebrow">Enterprise account</p>
        <h2>{account.displayName}</h2>
        <dl className="managed-account__details">
          <div>
            <dt>Tenant</dt>
            <dd>{account.tenantId}</dd>
          </div>
          <div>
            <dt>Roles</dt>
            <dd>{account.roles.length > 0 ? account.roles.join(" · ") : "Not supplied"}</dd>
          </div>
          <div>
            <dt>Scopes</dt>
            <dd>{account.scopes.length > 0 ? account.scopes.join(" · ") : "Not supplied"}</dd>
          </div>
          <div>
            <dt>{expiryLabel}</dt>
            <dd><time dateTime={expiry}>{formatExpiry(expiry)}</time></dd>
          </div>
        </dl>
        <p className="managed-account__boundary">
          Identity and tenant access come from the enterprise gateway. Code cannot change them.
        </p>
        {account.logoutUrl ? (
          <a className="managed-account__logout" href={account.logoutUrl}>Sign out</a>
        ) : (
          <p className="managed-account__logout-hint">Sign out through the enterprise gateway.</p>
        )}
      </div>
    </details>
  );
}
