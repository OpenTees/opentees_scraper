// Regression tests for the Intelligent Golf future-date extraction fix:
// the legacy scraper used to extract whatever date the booking page
// defaulted to (today), which production's 2-hour minimum-notice
// ingestion rule then rejected wholesale, every run, forever.
// resolveIgSlotDate is the fail-closed decision that replaces it --
// these tests exist specifically to catch a regression back to "accept
// whatever the page shows" for a legacy/shadow course.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  tomorrowIsoDate,
  extractSlotDateFromBody,
  extractDateFromUrl,
  extractRowsFromAnchors,
  resolveIgSlotDate,
} = require("./scrape-from-courses-v2-ig-import");

test("tomorrowIsoDate is genuinely one calendar day after today", () => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = tomorrowIsoDate();
  assert.notEqual(tomorrow, today);
  const diffDays = (new Date(`${tomorrow}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000;
  assert.equal(diffDays, 1);
});

test("resolveIgSlotDate: legacy/shadow course accepts the observed date only when the click happened AND it matches the expected future date", () => {
  assert.equal(
    resolveIgSlotDate({
      isStableState: false,
      nextDayClicked: true,
      observedSlotDate: "2026-10-16",
      expectedSlotDate: "2026-10-16",
    }),
    "2026-10-16",
  );
});

test("resolveIgSlotDate: fails closed (null) when the next-day click did not happen -- never silently extracts today's page", () => {
  assert.equal(
    resolveIgSlotDate({
      isStableState: false,
      nextDayClicked: false,
      observedSlotDate: "2026-10-15", // the page is still showing today
      expectedSlotDate: "2026-10-16",
    }),
    null,
  );
});

test("resolveIgSlotDate: fails closed (null) when the click happened but the page still shows today -- this is the exact same-day-only regression this guards against", () => {
  assert.equal(
    resolveIgSlotDate({
      isStableState: false,
      nextDayClicked: true,
      observedSlotDate: "2026-10-15", // click reported success but the date never actually advanced
      expectedSlotDate: "2026-10-16",
    }),
    null,
  );
});

test("resolveIgSlotDate: fails closed (null) when no date could be detected on the page at all", () => {
  assert.equal(
    resolveIgSlotDate({
      isStableState: false,
      nextDayClicked: true,
      observedSlotDate: null,
      expectedSlotDate: "2026-10-16",
    }),
    null,
  );
});

test("resolveIgSlotDate: a stable-state course is untouched -- accepts whatever the page shows (today), exactly as before this fix", () => {
  assert.equal(
    resolveIgSlotDate({
      isStableState: true,
      nextDayClicked: false,
      observedSlotDate: "2026-10-15",
      expectedSlotDate: "2026-10-16",
    }),
    "2026-10-15",
  );
});

test("resolveIgSlotDate: a stable-state course with no detectable date still returns null", () => {
  assert.equal(
    resolveIgSlotDate({
      isStableState: true,
      nextDayClicked: false,
      observedSlotDate: null,
      expectedSlotDate: "2026-10-16",
    }),
    null,
  );
});

test("extractRowsFromAnchors: produces rows stamped with the exact slot date it was given, never a different one", () => {
  const rows = extractRowsFromAnchors(
    [{ text: "08:00 £36.00", href: "/book/123" }],
    { providerCourseId: "ig-addington", courseName: "Addington Court", googleRating: 4.2, googleReviews: 100, provider: "intelligent_golf", targetUrl: "https://example.com/visitorbooking/" },
    "https://example.com/visitorbooking/",
    "Addington Court",
    "2026-10-16",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slot_date, "2026-10-16");
  assert.equal(rows[0].slot_time, "08:00");
  assert.equal(rows[0].price, 36);
});

test("extractSlotDateFromBody / extractDateFromUrl still correctly detect whatever date the page actually displays (used to verify the click worked)", () => {
  assert.equal(extractSlotDateFromBody("OPENS Fri, 16th October Go to Today"), `${new Date().getUTCFullYear()}-10-16`);
  assert.equal(extractDateFromUrl("https://example.com/visitorbooking/?date=2026-10-16"), "2026-10-16");
  assert.equal(extractDateFromUrl("https://example.com/visitorbooking/"), null);
});
