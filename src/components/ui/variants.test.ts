import assert from "node:assert/strict";
import { test } from "node:test";
import { variants } from "./variants";

const button = variants(
  "ui-button",
  {
    variant: {
      default: "ui-button--default",
      primary: "ui-button--primary",
      ghost: "ui-button--ghost",
    },
    size: {
      sm: "ui-button--sm",
      md: "ui-button--md",
    },
  },
  { variant: "default", size: "md" },
);

test("variants applies defaults when props are omitted", () => {
  assert.equal(button(), "ui-button ui-button--default ui-button--md");
});

test("variants overrides defaults with explicit props", () => {
  assert.equal(
    button({ variant: "primary", size: "sm", className: "extra" }),
    "ui-button ui-button--primary ui-button--sm extra",
  );
});

test("variants ignores unknown keys and unknown option values", () => {
  const result = button({
    ...({ tone: "loud" } as object),
    ...({ variant: "not-a-real-variant" } as object),
    size: "md",
  } as Parameters<typeof button>[0]);
  assert.equal(result, "ui-button ui-button--md");
  assert.ok(!result.includes("tone"));
  assert.ok(!result.includes("not-a-real"));
});
