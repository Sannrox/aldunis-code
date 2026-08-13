import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { WorkspacePanelPendingFallback } from "./workspace-panel-pending";
import type { ProviderBrowserObservation } from "../../types";

const observation: ProviderBrowserObservation = {
  provider: "codex-cli",
  observationId: "frame-1",
  imageData: "data:image/jpeg;base64,AA==",
  mediaType: "image/jpeg",
  title: "Agent frame",
};

test("files pending fallback uses destination chrome and named busy copy", () => {
  const html = renderToStaticMarkup(
    createElement(WorkspacePanelPendingFallback, {
      destination: "files",
      pane: "primary",
      onClose: () => undefined,
    }),
  );
  assert.match(html, /data-workspace-panel-pending="files"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Browse active worktree/);
  assert.match(html, /Opening Files…/);
  assert.doesNotMatch(html, /Inspecting/);
});

test("changes pending fallback fills review-dock chrome without inspecting copy", () => {
  const html = renderToStaticMarkup(
    createElement(WorkspacePanelPendingFallback, {
      destination: "changes",
      pane: "secondary",
      onClose: () => undefined,
    }),
  );
  assert.match(html, /data-workspace-panel-pending="changes"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /class="rv-t"/);
  assert.match(html, /Opening Changes…/);
  assert.doesNotMatch(html, /Inspecting worktree/);
});

test("preview pending fallback stays docked until observation requires the floating slot", () => {
  const docked = renderToStaticMarkup(
    createElement(WorkspacePanelPendingFallback, {
      destination: "preview",
      pane: "primary",
      onClose: () => undefined,
    }),
  );
  assert.match(docked, /preview-panel/);
  assert.doesNotMatch(docked, /preview-panel--floating/);
  assert.match(docked, /Opening Preview…/);

  const floating = renderToStaticMarkup(
    createElement(WorkspacePanelPendingFallback, {
      destination: "preview",
      pane: "primary",
      floating: true,
      observation,
      onClose: () => undefined,
    }),
  );
  assert.match(floating, /preview-panel preview-panel--floating/);
  assert.match(floating, /Agent browser view/);
  assert.match(floating, /PROVIDER OBSERVATION/);
  assert.match(floating, /src="data:image\/jpeg;base64,AA=="/);
  assert.match(floating, /Provider browser: Agent frame/);
  assert.doesNotMatch(floating, /Opening Preview…/);
});
