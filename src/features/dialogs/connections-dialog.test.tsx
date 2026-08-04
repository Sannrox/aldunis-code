import assert from "node:assert/strict";
import test from "node:test";
import { formatConnectionDate, remoteSessionState, type RemoteSessionSummary } from "./connections-dialog";

const session: RemoteSessionSummary = {
  id: "session-1",
  label: "iPad",
  createdAt: "2026-08-04T12:00:00.000Z",
  expiresAt: "2026-08-04T13:00:00.000Z",
  revokedAt: null,
};

test("remote session state distinguishes active, expired, and revoked sessions", () => {
  assert.equal(remoteSessionState(session, Date.parse("2026-08-04T12:30:00.000Z")), "active");
  assert.equal(remoteSessionState(session, Date.parse("2026-08-04T14:00:00.000Z")), "expired");
  assert.equal(remoteSessionState({ ...session, revokedAt: "2026-08-04T12:45:00.000Z" }), "revoked");
});

test("connection date formatting has a bounded invalid-value fallback", () => {
  assert.equal(formatConnectionDate("not-a-date"), "Unknown time");
  assert.notEqual(formatConnectionDate(session.expiresAt), "Unknown time");
});
