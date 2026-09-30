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
  deriveBrsClubSlug,
  discoverBrsCourseId,
  fetchBrsTeesheetJson,
} = require("./lifecycle-shadow");

// discoverBrsCourseId / fetchBrsTeesheetJson call the module-global
// `fetch`, exactly like every other network call in this file — mocked
// here per-test and always restored, never left patched across tests.
function withMockedFetch(responses, fn) {
  const originalFetch = global.fetch;
  let call = 0;
  global.fetch = async (url, opts) => {
    const step = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (typeof step === "function") return step(url, opts);
    if (step instanceof Error) throw step;
    return step;
  };
  return fn().finally(() => {
    global.fetch = originalFetch;
  });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

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

// ---------------------------------------------------------------------------
// BRS course-id discovery — fixes the production defect where every BRS
// club's shadow snapshot came back incomplete because the teesheet
// request never identified which club it was for (missing X-Club-Id),
// not because of the course_id value. Confirmed against 9 real production
// BRS clubs via read-only requests: every club has an id:1 course; single-
// course clubs have only it, and multi-course (shotgun-start) clubs name
// it "1st Tee" alongside a "10th"/"9th Tee" alternate.
// ---------------------------------------------------------------------------

test("deriveBrsClubSlug extracts the club slug from the target_url path", () => {
  assert.equal(deriveBrsClubSlug("https://visitors.brsgolf.com/broomepark"), "broomepark");
  assert.equal(deriveBrsClubSlug("https://visitors.brsgolf.com/lindfield/"), "lindfield");
  assert.equal(deriveBrsClubSlug("not a url"), null);
  assert.equal(deriveBrsClubSlug("https://visitors.brsgolf.com/"), null);
});

test("discoverBrsCourseId: a single-course club (course id 1, the common case) resolves unambiguously", async () => {
  await withMockedFetch(
    [jsonResponse(200, [{ id: 1, name: "Lindfield Golf Club" }])],
    async () => {
      const id = await discoverBrsCourseId({ targetUrl: "https://visitors.brsgolf.com/lindfield" });
      assert.equal(id, 1);
    },
  );
});

test("discoverBrsCourseId: a multi-course club (Broome Park's real shape) resolves to id 1, the '1st Tee' default", async () => {
  await withMockedFetch(
    [jsonResponse(200, [
      { id: 1, name: "1st Tee" },
      { id: 2, name: "10th Tee" },
    ])],
    async () => {
      const id = await discoverBrsCourseId({ targetUrl: "https://visitors.brsgolf.com/broomepark" });
      assert.equal(id, 1);
    },
  );
});

test("discoverBrsCourseId fails closed (null) when multiple courses exist and none is id 1 -- genuinely ambiguous, never guessed", async () => {
  await withMockedFetch(
    [jsonResponse(200, [
      { id: 3, name: "East Course" },
      { id: 4, name: "West Course" },
    ])],
    async () => {
      const id = await discoverBrsCourseId({ targetUrl: "https://visitors.brsgolf.com/ambiguousclub" });
      assert.equal(id, null);
    },
  );
});

test("discoverBrsCourseId fails closed on discovery failure: empty response body / no courses listed", async () => {
  await withMockedFetch([jsonResponse(200, [])], async () => {
    const id = await discoverBrsCourseId({ targetUrl: "https://visitors.brsgolf.com/emptyclub" });
    assert.equal(id, null);
  });
});

test("discoverBrsCourseId fails closed on an HTTP/API failure (matches the real pre-fix 500 for every club without the header)", async () => {
  await withMockedFetch([{ ok: false, status: 500, text: async () => "" }], async () => {
    const id = await discoverBrsCourseId({ targetUrl: "https://visitors.brsgolf.com/anyclub" });
    assert.equal(id, null);
  });
});

test("discoverBrsCourseId fails closed on a network error", async () => {
  await withMockedFetch([new Error("network unreachable")], async () => {
    const id = await discoverBrsCourseId({ targetUrl: "https://visitors.brsgolf.com/anyclub" });
    assert.equal(id, null);
  });
});

test("discoverBrsCourseId fails closed on malformed JSON", async () => {
  await withMockedFetch([{ ok: true, status: 200, text: async () => "not json" }], async () => {
    const id = await discoverBrsCourseId({ targetUrl: "https://visitors.brsgolf.com/anyclub" });
    assert.equal(id, null);
  });
});

test("discoverBrsCourseId fails closed when the target_url has no club slug in its path", async () => {
  const id = await discoverBrsCourseId({ targetUrl: "https://visitors.brsgolf.com/" });
  assert.equal(id, null);
});

test("fetchBrsTeesheetJson sends the X-Club-Id header (the actual root-cause fix) and the discovered course_id", async () => {
  let teesheetRequestUrl = null;
  let teesheetHeaders = null;
  await withMockedFetch(
    [
      jsonResponse(200, [{ id: 1, name: "1st Tee" }, { id: 2, name: "10th Tee" }]), // courses/all
      (url, opts) => {
        teesheetRequestUrl = url;
        teesheetHeaders = opts.headers;
        return jsonResponse(200, { data: { tee_date: "2026-10-01", tee_times: [] } });
      },
    ],
    async () => {
      const result = await fetchBrsTeesheetJson({ targetUrl: "https://visitors.brsgolf.com/broomepark" }, "2026-10-01");
      assert.deepEqual(result, { data: { tee_date: "2026-10-01", tee_times: [] } });
    },
  );
  assert.match(teesheetRequestUrl, /course_id=1/);
  assert.equal(teesheetHeaders["X-Club-Id"], "broomepark");
});

test("fetchBrsTeesheetJson returns null (fail closed) when course-id discovery is ambiguous, never falling back to a guessed id", async () => {
  await withMockedFetch(
    [jsonResponse(200, [{ id: 3, name: "East" }, { id: 4, name: "West" }])],
    async () => {
      const result = await fetchBrsTeesheetJson({ targetUrl: "https://visitors.brsgolf.com/ambiguousclub" }, "2026-10-01");
      assert.equal(result, null);
    },
  );
});

test("fetchBrsTeesheetJson returns null (fail closed) on an HTTP failure from the teesheet endpoint itself", async () => {
  await withMockedFetch(
    [
      jsonResponse(200, [{ id: 1, name: "Lindfield Golf Club" }]), // courses/all succeeds
      { ok: false, status: 500, text: async () => "" }, // teesheet call fails
    ],
    async () => {
      const result = await fetchBrsTeesheetJson({ targetUrl: "https://visitors.brsgolf.com/lindfield" }, "2026-10-01");
      assert.equal(result, null);
    },
  );
});

test("a genuine empty snapshot (well-formed response, zero tee times, matching tee_date) is still treated as complete once a valid course_id resolves", async () => {
  await withMockedFetch(
    [
      jsonResponse(200, [{ id: 1, name: "Lindfield Golf Club" }]),
      jsonResponse(200, { data: { tee_date: "2026-10-01", tee_times: [] } }),
    ],
    async () => {
      const teesheet = await fetchBrsTeesheetJson({ targetUrl: "https://visitors.brsgolf.com/lindfield" }, "2026-10-01");
      assert.equal(isBrsSnapshotComplete(teesheet, "2026-10-01"), true);
    },
  );
});
