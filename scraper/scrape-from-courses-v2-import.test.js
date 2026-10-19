// Regression tests for the BRS future-date extraction fix: the legacy
// scraper used to hardcode slot_date to TODAY (extractRowsFromBrsBody,
// removed), which production's 2-hour minimum-notice ingestion rule
// then rejected wholesale, every run, forever. extractRowsFromBrsTeesheet
// replaces it with the SAME proven BRS teesheet API fetch already used
// for stable-identity ingestion, fetched for a genuine future date.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  londonTodayIsoDate,
  tomorrowIsoDate,
  resolveBrsSlotDate,
  extractRowsFromBrsTeesheet,
  buildExternalId,
} = require("./scrape-from-courses-v2-import");

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

const COURSE_CONFIG = {
  providerCourseId: "brs-broomepark",
  courseName: "Broome Park Golf Club",
  targetUrl: "https://visitors.brsgolf.com/broomepark",
  provider: "brs",
  googleRating: 4.1,
  googleReviews: 200,
};

test("tomorrowIsoDate is genuinely one calendar day after today, never the same date", () => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = tomorrowIsoDate();
  assert.notEqual(tomorrow, today);
  const diffDays = (new Date(`${tomorrow}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000;
  assert.equal(diffDays, 1);
});

// --- Deterministic Europe/London boundary tests -------------------------
// The bug a naive UTC `tomorrowIsoDate` has: during roughly 23:00-23:59
// UTC on a British Summer Time day, London local time (UTC+1) has
// already crossed into the next calendar day. UTC-only arithmetic would
// then compute what is genuinely TODAY in London as "tomorrow" --
// reintroducing the exact same-day rejection this whole fix exists to
// prevent, for about one hour of every BST day.

test("londonTodayIsoDate: during BST, after London local midnight but before UTC midnight, resolves to the NEW London day (not UTC's old one)", () => {
  // 2026-07-14 23:30 UTC = 2026-07-15 00:30 BST (BST = UTC+1, and 14
  // July is within British Summer Time).
  const now = new Date("2026-07-14T23:30:00Z");
  assert.equal(londonTodayIsoDate(now), "2026-07-15");
});

test("londonTodayIsoDate: during BST, shortly before London local midnight, still resolves to the OLD day", () => {
  // 2026-07-14 22:30 UTC = 2026-07-14 23:30 BST -- still 14 July locally.
  const now = new Date("2026-07-14T22:30:00Z");
  assert.equal(londonTodayIsoDate(now), "2026-07-14");
});

test("tomorrowIsoDate: BST boundary -- the exact window where a naive UTC calculation would be wrong by a day", () => {
  // At 23:30 UTC on 14 July (BST), London is already into 15 July.
  // Genuine tomorrow is 16 July. A UTC-naive `new Date(); +1 day` would
  // instead compute 15 July -- which is actually TODAY in London, not
  // tomorrow, and would fail the 2-hour minimum-notice rule exactly
  // like the original same-day bug.
  const now = new Date("2026-07-14T23:30:00Z");
  assert.equal(tomorrowIsoDate(now), "2026-07-16");
});

test("tomorrowIsoDate: GMT (winter), no UTC/London offset -- a plain UTC day boundary is correct either way", () => {
  // 2026-01-14 23:30 UTC = 2026-01-14 23:30 GMT (no DST offset in January).
  const now = new Date("2026-01-14T23:30:00Z");
  assert.equal(tomorrowIsoDate(now), "2026-01-15");
});

test("tomorrowIsoDate: the DST spring-forward night itself (clocks jump 01:00->02:00 BST) still resolves to a clean calendar day", () => {
  // 2026-03-29 is the UK's spring-forward date. 01:30 UTC that day is
  // still GMT (the jump to BST happens at 01:00 UTC on the 29th, i.e.
  // clocks go from 01:00 GMT straight to 02:00 BST) -- London local
  // time at 01:30 UTC is already 02:30 BST.
  const now = new Date("2026-03-29T01:30:00Z");
  assert.equal(londonTodayIsoDate(now), "2026-03-29");
  assert.equal(tomorrowIsoDate(now), "2026-03-30");
});

test("resolveBrsSlotDate: a stable-state course never requests a date here at all -- that fetch would be wasted and is handled separately", () => {
  assert.equal(resolveBrsSlotDate(true, new Date("2026-07-14T23:30:00Z")), null);
});

test("resolveBrsSlotDate: a legacy/shadow course gets the genuine London-correct tomorrow, even across the BST boundary", () => {
  assert.equal(resolveBrsSlotDate(false, new Date("2026-07-14T23:30:00Z")), "2026-07-16");
});

test("extractRowsFromBrsTeesheet builds genuine future-dated rows from a complete snapshot for the requested date, never today's", async () => {
  const slotDate = tomorrowIsoDate();
  await withMockedFetch(
    [
      jsonResponse(200, [{ id: 1, name: "1st Tee" }]), // courses/all
      jsonResponse(200, {
        data: {
          tee_date: slotDate,
          tee_times: [
            { id: 852690, time: "07:00", green_fees: [{ green_fee1_ball: "40.00" }] },
            { id: 852695, time: "07:40", green_fees: [{ green_fee1_ball: "40.00" }] },
          ],
        },
      }),
    ],
    async () => {
      const { extractedRows, snapshotComplete } = await extractRowsFromBrsTeesheet(COURSE_CONFIG, slotDate);
      assert.equal(snapshotComplete, true);
      assert.equal(extractedRows.length, 2);
      for (const row of extractedRows) {
        assert.equal(row.slot_date, slotDate);
        assert.notEqual(row.slot_date, new Date().toISOString().slice(0, 10), "must never be today's date");
      }
      assert.equal(extractedRows[0].slot_time, "07:00");
      assert.equal(extractedRows[0].price, 40);
      assert.equal(extractedRows[0].external_id, buildExternalId("brs-broomepark", slotDate, "07:00", 40));
    },
  );
});

test("extractRowsFromBrsTeesheet fails closed (empty rows) when the response doesn't echo the requested date back -- never relabels another day's data as the requested one", async () => {
  const slotDate = tomorrowIsoDate();
  await withMockedFetch(
    [
      jsonResponse(200, [{ id: 1, name: "1st Tee" }]),
      jsonResponse(200, {
        data: {
          tee_date: new Date().toISOString().slice(0, 10), // echoes TODAY, not the requested future date
          tee_times: [{ id: 1, time: "07:00", green_fees: [{ green_fee1_ball: "40.00" }] }],
        },
      }),
    ],
    async () => {
      const { extractedRows, snapshotComplete } = await extractRowsFromBrsTeesheet(COURSE_CONFIG, slotDate);
      assert.equal(snapshotComplete, false);
      assert.deepEqual(extractedRows, []);
    },
  );
});

test("extractRowsFromBrsTeesheet fails closed on an HTTP failure from the teesheet endpoint", async () => {
  const slotDate = tomorrowIsoDate();
  await withMockedFetch(
    [
      jsonResponse(200, [{ id: 1, name: "1st Tee" }]),
      { ok: false, status: 500, text: async () => "" },
    ],
    async () => {
      const { extractedRows, snapshotComplete } = await extractRowsFromBrsTeesheet(COURSE_CONFIG, slotDate);
      assert.equal(snapshotComplete, false);
      assert.deepEqual(extractedRows, []);
    },
  );
});

// --- Hole-count support (same tee time, genuinely different products) --
// Confirmed live against Peacehaven Golf & Fitness: a single BRS slot
// (one time, one slot.id) can carry TWO independent green_fees entries
// -- an 18-hole round and a 9-hole round, each with its own price and
// its own green_fees.id. Taking only green_fees[0] silently drops one
// of them; these tests guard against that regressing.

test("extractRowsFromBrsTeesheet emits ONE ROW PER green_fees entry, preserving both hole counts and their distinct prices for the same tee time", async () => {
  const slotDate = tomorrowIsoDate();
  await withMockedFetch(
    [
      jsonResponse(200, [{ id: 1, name: "1st Tee" }]),
      jsonResponse(200, {
        data: {
          tee_date: slotDate,
          tee_times: [
            {
              id: 158422,
              time: "08:10",
              green_fees: [
                { id: 27, green_fee1_ball: "18.00", num_holes: "18" },
                { id: 28, green_fee1_ball: "11.00", num_holes: "9" },
              ],
            },
          ],
        },
      }),
    ],
    async () => {
      const { extractedRows } = await extractRowsFromBrsTeesheet(COURSE_CONFIG, slotDate);
      assert.equal(extractedRows.length, 2, "both the 18-hole and 9-hole offers must survive, not just the first");

      const eighteen = extractedRows.find((r) => r.holes === 18);
      const nine = extractedRows.find((r) => r.holes === 9);
      assert.ok(eighteen, "18-hole offer present");
      assert.ok(nine, "9-hole offer present");

      assert.equal(eighteen.price, 18);
      assert.equal(nine.price, 11);
      assert.equal(eighteen.slot_time, "08:10");
      assert.equal(nine.slot_time, "08:10", "same tee time for both offers");

      assert.notEqual(eighteen.external_id, nine.external_id, "must never collide/overwrite each other");
    },
  );
});

test("extractRowsFromBrsTeesheet leaves holes null (never invents 18) when BRS doesn't report a recognised num_holes value", async () => {
  const slotDate = tomorrowIsoDate();
  await withMockedFetch(
    [
      jsonResponse(200, [{ id: 1, name: "1st Tee" }]),
      jsonResponse(200, {
        data: {
          tee_date: slotDate,
          tee_times: [
            { id: 1, time: "07:00", green_fees: [{ green_fee1_ball: "40.00", num_holes: "" }] },
          ],
        },
      }),
    ],
    async () => {
      const { extractedRows } = await extractRowsFromBrsTeesheet(COURSE_CONFIG, slotDate);
      assert.equal(extractedRows.length, 1);
      assert.equal(extractedRows[0].holes, null, "must stay null, never default/guess 18");
    },
  );
});

test("buildExternalId: distinguishes 9-hole and 18-hole offers even if their prices happened to be identical", () => {
  const id18 = buildExternalId("brs-peacehaven9", "2026-10-16", "08:10", 20, 18);
  const id9 = buildExternalId("brs-peacehaven9", "2026-10-16", "08:10", 20, 9);
  assert.notEqual(id18, id9);
});

test("extractRowsFromBrsTeesheet drops a slot with no parseable price rather than importing a null-price row", async () => {
  const slotDate = tomorrowIsoDate();
  await withMockedFetch(
    [
      jsonResponse(200, [{ id: 1, name: "1st Tee" }]),
      jsonResponse(200, {
        data: {
          tee_date: slotDate,
          tee_times: [
            { id: 1, time: "07:00", green_fees: [] },
            { id: 2, time: "07:40", green_fees: [{ green_fee1_ball: "40.00" }] },
          ],
        },
      }),
    ],
    async () => {
      const { extractedRows } = await extractRowsFromBrsTeesheet(COURSE_CONFIG, slotDate);
      assert.equal(extractedRows.length, 1);
      assert.equal(extractedRows[0].slot_time, "07:40");
    },
  );
});
