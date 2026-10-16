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
  londonTodayIsoDate,
  tomorrowIsoDate,
  extractSlotDateFromBody,
  extractDateFromUrl,
  extractRowsFromAnchors,
  resolveIgSlotDate,
  buildExternalId,
} = require("./scrape-from-courses-v2-ig-import");

test("tomorrowIsoDate is genuinely one calendar day after today", () => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = tomorrowIsoDate();
  assert.notEqual(tomorrow, today);
  const diffDays = (new Date(`${tomorrow}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000;
  assert.equal(diffDays, 1);
});

// --- Deterministic Europe/London boundary tests -------------------------
// Same bug class as the BRS script's: a naive UTC `tomorrowIsoDate`
// would be wrong for roughly 23:00-23:59 UTC on every British Summer
// Time day, since London local time (UTC+1) has already crossed into
// the next calendar day by then.

test("londonTodayIsoDate: during BST, after London local midnight but before UTC midnight, resolves to the NEW London day", () => {
  const now = new Date("2026-07-14T23:30:00Z"); // = 2026-07-15 00:30 BST
  assert.equal(londonTodayIsoDate(now), "2026-07-15");
});

test("londonTodayIsoDate: during BST, shortly before London local midnight, still resolves to the OLD day", () => {
  const now = new Date("2026-07-14T22:30:00Z"); // = 2026-07-14 23:30 BST
  assert.equal(londonTodayIsoDate(now), "2026-07-14");
});

test("tomorrowIsoDate: BST boundary -- the exact window where a naive UTC calculation would be wrong by a day", () => {
  const now = new Date("2026-07-14T23:30:00Z");
  assert.equal(tomorrowIsoDate(now), "2026-07-16");
});

test("tomorrowIsoDate: GMT (winter), no UTC/London offset -- correct either way", () => {
  const now = new Date("2026-01-14T23:30:00Z");
  assert.equal(tomorrowIsoDate(now), "2026-01-15");
});

test("tomorrowIsoDate: the DST spring-forward night itself still resolves to a clean calendar day", () => {
  const now = new Date("2026-03-29T01:30:00Z"); // already 02:30 BST
  assert.equal(londonTodayIsoDate(now), "2026-03-29");
  assert.equal(tomorrowIsoDate(now), "2026-03-30");
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

// --- Hole-count support (the page's own maxholes form field) -----------
// Confirmed live against Addington Court: POSTing the teesheet form
// with maxholes=18 vs maxholes=9 returns genuinely different, distinctly
// priced content for the same date -- not a client-side filter over one
// shared dataset.

test("extractRowsFromAnchors: tags rows with the given holes count, defaulting to null (never guessed/defaulted to 18) when omitted", () => {
  const courseConfig = { providerCourseId: "ig-addington", courseName: "Addington Court", googleRating: 4.2, googleReviews: 100, provider: "intelligent_golf", targetUrl: "https://example.com/visitorbooking/" };

  const rowsNoHoles = extractRowsFromAnchors(
    [{ text: "08:00 £36.00", href: "/book/123" }],
    courseConfig, "https://example.com/visitorbooking/", "Addington Court", "2026-10-16",
  );
  assert.equal(rowsNoHoles[0].holes, null, "must stay null when the caller doesn't supply a holes count -- never invented");

  const rows18 = extractRowsFromAnchors(
    [{ text: "08:00 £36.00", href: "/book/123" }],
    courseConfig, "https://example.com/visitorbooking/", "Addington Court", "2026-10-16", 18,
  );
  assert.equal(rows18[0].holes, 18);
});

test("extractRowsFromAnchors + buildExternalId: a 9-hole and 18-hole offer for the SAME time/price never collide/overwrite each other", () => {
  const courseConfig = { providerCourseId: "ig-addington", courseName: "Addington Court", googleRating: 4.2, googleReviews: 100, provider: "intelligent_golf", targetUrl: "https://example.com/visitorbooking/" };

  const rows9 = extractRowsFromAnchors(
    [{ text: "08:00 £20.00", href: "/book/9" }],
    courseConfig, "https://example.com/visitorbooking/", "Addington Court", "2026-10-16", 9,
  );
  const rows18 = extractRowsFromAnchors(
    [{ text: "08:00 £20.00", href: "/book/18" }],
    courseConfig, "https://example.com/visitorbooking/", "Addington Court", "2026-10-16", 18,
  );

  assert.notEqual(rows9[0].external_id, rows18[0].external_id, "identical time AND price, but distinct hole counts, must still produce distinct ids");
});

test("buildExternalId: distinguishes 9-hole and 18-hole offers even when price is identical", () => {
  const id9 = buildExternalId("ig-addington", "2026-10-16", "08:00", 20, 9);
  const id18 = buildExternalId("ig-addington", "2026-10-16", "08:00", 20, 18);
  assert.notEqual(id9, id18);
});

test("extractSlotDateFromBody / extractDateFromUrl still correctly detect whatever date the page actually displays (used to verify the click worked)", () => {
  assert.equal(extractSlotDateFromBody("OPENS Fri, 16th October Go to Today"), `${new Date().getUTCFullYear()}-10-16`);
  assert.equal(extractDateFromUrl("https://example.com/visitorbooking/?date=2026-10-16"), "2026-10-16");
  assert.equal(extractDateFromUrl("https://example.com/visitorbooking/"), null);
});
