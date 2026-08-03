import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagedAccountPanel } from "./managed-account-panel";

test("managed account panel exposes the verified enterprise identity projection", () => {
  const html = renderToStaticMarkup(
    <ManagedAccountPanel
      account={{
        displayName: "Ada Lovelace",
        tenantId: "acme",
        roles: ["developer", "reviewer"],
        scopes: ["code:workbench"],
        assertionExpiresAt: "2026-08-02T12:05:00.000Z",
        sessionExpiresAt: "2026-08-02T18:00:00.000Z",
        logoutUrl: "https://identity.example.test/logout",
      }}
    />,
  );

  assert.match(html, /Enterprise account: Ada Lovelace/);
  assert.match(html, /Tenant/);
  assert.match(html, /acme/);
  assert.match(html, /developer · reviewer/);
  assert.match(html, /Account session expires/);
  assert.match(html, /href="https:\/\/identity\.example\.test\/logout"/);
  assert.match(html, />Sign out<\/a>/);
});

test("managed account panel keeps logout guidance visible when the gateway URL is not configured", () => {
  const html = renderToStaticMarkup(
    <ManagedAccountPanel
      account={{
        displayName: "service:gateway",
        tenantId: "tenant-test",
        roles: [],
        scopes: ["code:workbench"],
        assertionExpiresAt: "2026-08-02T12:05:00.000Z",
        sessionExpiresAt: null,
        logoutUrl: null,
      }}
    />,
  );

  assert.match(html, /Access assertion expires/);
  assert.match(html, /Sign out through the enterprise gateway/);
  assert.doesNotMatch(html, />Sign out<\/a>/);
});
