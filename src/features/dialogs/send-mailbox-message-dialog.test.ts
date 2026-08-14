import assert from "node:assert/strict";
import test from "node:test";
import { MAILBOX_DIALOG_COPY, mailboxReviewLines } from "./send-mailbox-message-dialog";

test("mailbox dialog copy keeps review-before-send and empty-destination guidance", () => {
  assert.equal(MAILBOX_DIALOG_COPY.title, "Send to another conversation");
  assert.match(MAILBOX_DIALOG_COPY.reviewHelp, /Canceling creates no destination turn/);
  assert.match(MAILBOX_DIALOG_COPY.emptyDestinations, /No other conversations are available/);
  assert.deepEqual(
    mailboxReviewLines({
      sourceTitle: "Plan",
      destinationTitle: "Review",
      mode: "ask",
      text: "Please review the plan.",
    }),
    ["From Plan", "To Review", "Mode ask", "Please review the plan."],
  );
});
