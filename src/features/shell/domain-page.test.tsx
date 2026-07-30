import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DomainPage } from "./domain-page";

test("Chisei page exposes a read-only project-bound Action projection", () => {
  const html = renderToStaticMarkup(
    <DomainPage
      product="chisei"
      selectedProjectId="project-1"
      projects={[{
        id: "project-1",
        name: "aldunis-code",
        root: "/repo",
        openedAt: new Date(0).toISOString(),
        chiseiNamespace: "team/project",
      }]}
    />,
  );
  assert.match(html, /Governed Actions/);
  assert.match(html, /Project namespace/);
  assert.match(html, /stored by this local host/);
  assert.match(html, /cannot admit, claim, retry, or mutate Actions/);
  assert.match(html, /team\/project/);
  assert.match(html, /aria-labelledby="chisei-actions-title"/);
});

test("Chisei page retains the active worktree binding when projects are collapsed", () => {
  const html = renderToStaticMarkup(
    <DomainPage
      product="chisei"
      selectedProjectId="worktree-2"
      projects={[{
        id: "main-project",
        name: "Aldunis",
        root: "/tmp/aldunis",
        openedAt: "2026-01-01T00:00:00.000Z",
        memberIds: ["main-project", "worktree-2"],
        chiseiNamespace: "team/main",
        chiseiBindings: {
          "main-project": "team/main",
          "worktree-2": "team/worktree",
        },
      }]}
    />,
  );
  assert.match(html, /value="team\/worktree"/);
  assert.doesNotMatch(html, /value="team\/main"/);
});

test("Chisei page preserves an explicitly unbound active worktree", () => {
  const html = renderToStaticMarkup(
    <DomainPage
      product="chisei"
      selectedProjectId="worktree-2"
      projects={[{
        id: "main-project",
        name: "Aldunis",
        root: "/tmp/aldunis",
        openedAt: "2026-01-01T00:00:00.000Z",
        memberIds: ["main-project", "worktree-2"],
        chiseiNamespace: "team/main",
        chiseiBindings: {
          "main-project": "team/main",
          "worktree-2": null,
        },
      }]}
    />,
  );
  assert.match(html, /id="chisei-project-namespace"[^>]*value=""/);
  assert.doesNotMatch(html, /value="team\/main"/);
});

test("Chisei binding administration is disabled for remote clients", () => {
  const html = renderToStaticMarkup(
    <DomainPage
      product="chisei"
      chiseiBindingAdministrationAvailable={false}
      selectedProjectId="project-1"
      projects={[{
        id: "project-1",
        name: "Aldunis",
        root: "/tmp/aldunis",
        openedAt: "2026-01-01T00:00:00.000Z",
        chiseiNamespace: "team/project",
      }]}
    />,
  );
  assert.match(html, /Binding administration is available only on loopback/);
  assert.match(html, /id="chisei-project-namespace"[^>]*disabled/);
  assert.match(html, /type="submit"[^>]*disabled/);
});

test("Chisei page does not retarget an unresolved selected project", () => {
  const html = renderToStaticMarkup(
    <DomainPage
      product="chisei"
      selectedProjectId="missing-project"
      projects={[{
        id: "other-project",
        name: "Other",
        root: "/tmp/other",
        openedAt: "2026-01-01T00:00:00.000Z",
        chiseiNamespace: "team/other",
      }]}
    />,
  );
  assert.match(html, /Open a local project/);
  assert.doesNotMatch(html, /team\/other/);
});
