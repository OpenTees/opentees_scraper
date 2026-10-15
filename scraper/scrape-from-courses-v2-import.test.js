// Regression tests for the BRS future-date extraction fix: the legacy
// scraper used to hardcode slot_date to TODAY (extractRowsFromBrsBody,
// removed), which production's 2-hour minimum-notice ingestion rule
// then rejected wholesale, every run, forever. extractRowsFromBrsTeesheet
// replaces it with the SAME proven BRS teesheet API fetch already used
// for stable-identity ingestion, fetched for a genuine future date.

const assert = require("node:assert/strict");
const test = require("node:test");

const { tomorrowIsoDate, extractRowsFromBrsTeesheet, buildExternalId } = require("./scrape-from-courses-v2-import");

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
