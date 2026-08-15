import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BranchSuggestionInput } from "./branch-suggestion-input";

test("branch suggestions stay bounded while omitted local branches remain typable", () => {
  const options = ["main", "release"];
  const html = renderToStaticMarkup(
    <BranchSuggestionInput
      id="base"
      value="omitted-but-valid"
      options={options}
      defaultBranch="main"
      branchCount={80_001}
      truncated
      onChange={() => undefined}
    />,
  );

  assert.match(html, /<input[^>]+list="base-suggestions"[^>]+value="omitted-but-valid"/);
  assert.equal((html.match(/<option /g) ?? []).length, options.length);
  assert.match(html, /Showing 2 of 80,001 local branch suggestions/);
  assert.match(html, /Type another local branch name to use it/);
  assert.doesNotMatch(html, /<select/);
});
