const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildStableExternalIdBrs,
  buildStableExternalIdIg,
  isBrsSnapshotComplete,
  isIgSnapshotComplete,
  computeBrsShadowProposal,
  computeIgShadowProposal,
  buildBrsStableRows,
  buildIgStableRows,
} = require("./lifecycle-shadow");

test("buildStableExternalIdBrs is price-independent and namespaced", () => {
  const id1 = buildStableExternalIdBrs("brs-001", "2026-10-01", 601);
  const id2 = buildStableExternalIdBrs("brs-001", "2026-10-01", 601);
  assert.equal(id1, id2);
  assert.match(id1, /^stable:brs-001:2026-10-01:601$/);
});

test("buildStableExternalIdIg uses slot time as identity (no provider slot id available)", () => {
  const id = buildStableExternalIdIg("ig-001", "2026-10-01", "14:30");
  assert.equal(id, "stable:ig-001:2026-10-01:14:30");
});

test("isBrsSnapshotComplete requires the response to echo the requested date back", () => {
  assert.equal(
    isBrsSnapshotComplete({ data: { tee_date: "2026-10-01", tee_times: [] } }, "2026-10-01"),
    true,
  );
  assert.equal(
    isBrsSnapshotComplete({ data: { tee_date: "2026-10-02", tee_times: [] } }, "2026-10-01"),
    false,
  );
  assert.equal(isBrsSnapshotComplete(null, "2026-10-01"), false);
  assert.equal(isBrsSnapshotComplete({ message: "error", data: { tee_date: "2026-10-01", tee_times: [] } }, "2026-10-01"), false);
});

test("isIgSnapshotComplete fails closed on a login-wall page, requires a detected slot date", () => {
  assert.equal(isIgSnapshotComplete("normal teesheet body", "Course X", "2026-10-01"), true);
  assert.equal(isIgSnapshotComplete("Login Required", "Some Club", "2026-10-01"), false);
  assert.equal(isIgSnapshotComplete("normal body", "Course X", null), false);
});

test("computeBrsShadowProposal rejects (fails closed) on an incomplete snapshot, proposes nothing", () => {
  const proposal = computeBrsShadowProposal({
    providerCourseId: "brs-001",
    slotDate: "2026-10-01",
    teesheetResponse: { message: "error" },
    currentActiveLegacyExternalIds: ["legacy-1"],
  });
  assert.equal(proposal.snapshotComplete, false);
  assert.equal(proposal.rejected, true);
  assert.deepEqual(proposal.proposedStableExternalIds, []);
});

test("computeBrsShadowProposal proposes stable ids for a complete snapshot without touching legacy ids directly", () => {
  const proposal = computeBrsShadowProposal({
    providerCourseId: "brs-001",
    slotDate: "2026-10-01",
    teesheetResponse: { data: { tee_date: "2026-10-01", tee_times: [{ id: 601, time: "14:00" }] } },
    currentActiveLegacyExternalIds: ["legacy-1", "legacy-2"],
  });
  assert.equal(proposal.rejected, false);
  assert.deepEqual(proposal.proposedStableExternalIds, ["stable:brs-001:2026-10-01:601"]);
  assert.deepEqual(proposal.wouldDeactivateLegacyExternalIds, ["legacy-1", "legacy-2"]);
});

test("computeIgShadowProposal fails closed on an identity collision within the same batch", () => {
  const proposal = computeIgShadowProposal({
    providerCourseId: "ig-001",
    slotDate: "2026-10-01",
    snapshotComplete: true,
    extractedRows: [{ slotTime: "14:00" }, { slotTime: "14:00" }],
    currentActiveLegacyExternalIds: [],
  });
  assert.equal(proposal.rejected, true);
  assert.equal(proposal.rejectReason, "ig_identity_collision");
  assert.deepEqual(proposal.proposedStableExternalIds, []);
});

test("buildBrsStableRows returns null (fail closed) for an incomplete snapshot", () => {
  const rows = buildBrsStableRows(
    { providerCourseId: "brs-001", courseName: "C", targetUrl: "https://x" },
    "2026-10-01",
    { message: "error" },
  );
  assert.equal(rows, null);
});

test("buildBrsStableRows produces price-independent stable rows from a complete snapshot", () => {
  const rows = buildBrsStableRows(
    { providerCourseId: "brs-001", courseName: "C", targetUrl: "https://x" },
    "2026-10-01",
    { data: { tee_date: "2026-10-01", tee_times: [{ id: 601, time: "14:00", green_fees: [{ green_fee1_ball: "31.00" }] }] } },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_id, "stable:brs-001:2026-10-01:601");
  assert.equal(rows[0].price, 31);
});

test("buildIgStableRows fails closed (rows: null, collision: true) on a duplicate identity within the batch", () => {
  const { rows, collision } = buildIgStableRows(
    { providerCourseId: "ig-001", courseName: "C", targetUrl: "https://x" },
    "2026-10-01",
    true,
    [{ slotTime: "14:00", price: 20 }, { slotTime: "14:00", price: 25 }],
  );
  assert.equal(rows, null);
  assert.equal(collision, true);
});

test("buildIgStableRows returns rows: null (not a collision) for an untrusted/incomplete snapshot", () => {
  const { rows, collision } = buildIgStableRows(
    { providerCourseId: "ig-001", courseName: "C", targetUrl: "https://x" },
    "2026-10-01",
    false,
    [],
  );
  assert.equal(rows, null);
  assert.equal(collision, false);
});
