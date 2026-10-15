const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const lifecycleShadow = require("./lifecycle-shadow");

const OUTPUT_DIR = path.join(process.cwd(), "scraper-output-v2-ig-import");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MANUAL_IMPORT_SECRET = process.env.MANUAL_IMPORT_SECRET;

const PROVIDER = "intelligent_golf";
const RUN_CORRELATION_ID = crypto.randomUUID();

const COURSE_TIMEOUT_MS = Number(process.env.COURSE_TIMEOUT_MS || 45000);

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function monthNameToNumber(monthName) {
  const months = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
  };

  return months[String(monthName || "").toLowerCase()] || null;
}

function extractSlotDateFromBody(bodyText) {
  const match = String(bodyText || "").match(
    /\b(?:Mon|Tue|Tues|Wed|Thu|Thur|Fri|Sat|Sun),?\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\b/i
  );

  if (!match) return null;

  const day = String(match[1]).padStart(2, "0");
  const month = monthNameToNumber(match[2]);
  const year = new Date().getUTCFullYear();

  if (!month) return null;

  return `${year}-${month}-${day}`;
}

function extractDateFromUrl(targetUrl) {
  const match = String(targetUrl || "").match(/[?&]date=(\d{4}-\d{2}-\d{2})/i);
  return match ? match[1] : null;
}

// Used only by the stable-identity snapshot-token path below (out of
// scope for the future-date fix: that path is a separate, already-
// fenced lifecycle mechanism, deliberately untouched here). The
// expected slot date for a snapshot-token begin call is always today,
// determined before the Playwright fetch runs. The date later extracted
// from the actual page (result.slotDate) confirms what was really
// returned and is what gets sent to apply_lifecycle_snapshot itself.
function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// UTC-naive "tomorrow" is wrong for part of every BST day: during
// roughly 23:00-23:59 UTC in British Summer Time, London local time has
// already crossed into the next calendar day (BST is UTC+1), so a plain
// `new Date(); setUTCDate(+1)` would compute what is genuinely TODAY in
// London -- not tomorrow -- reintroducing exactly the same-day rejection
// this fix exists to prevent. The club sites and production's own
// MIN_NOTICE_HOURS cutoff (ingest-tee-times/index.ts's
// getLondonNowParts()) both operate in Europe/London local time, so
// "tomorrow" is derived from London's calendar date, not UTC's --
// mirroring that same function's technique. `now` is injectable for
// deterministic boundary testing; production always uses the default.
function londonTodayIsoDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function tomorrowIsoDate(now = new Date()) {
  // londonTodayIsoDate already resolved the DST-sensitive part (which
  // calendar day London is actually on). Adding one day to that
  // date-only string via UTC arithmetic is safe and unambiguous -- pure
  // calendar-day math has no DST transition to cross.
  const d = new Date(`${londonTodayIsoDate(now)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function normalisePrice(priceText) {
  if (!priceText) return null;

  const cleaned = String(priceText)
    .replace(/[^\d.]/g, "")
    .replace(/(\..*)\./g, "$1")
    .replace(/^\./, "");

  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;

  return Math.round(value);
}

function buildExternalId(providerCourseId, slotDate, slotTime, price) {
  return `${providerCourseId}-${slotDate}-${slotTime}-${price ?? "na"}`;
}

// Pure: the fail-closed decision for whether this run's extraction is
// trustworthy. Stable-state courses are untouched by the next-day click
// (that fenced path expects today, unchanged from before this fix).
// Legacy/shadow courses only accept rows when the click actually
// happened AND the page now genuinely displays the expected future
// date -- never "whatever the page shows" relabelled as tomorrow, which
// is exactly how the same-day-only problem could silently return.
function resolveIgSlotDate({ isStableState, nextDayClicked, observedSlotDate, expectedSlotDate }) {
  if (isStableState) return observedSlotDate || null;
  return nextDayClicked && observedSlotDate === expectedSlotDate ? observedSlotDate : null;
}

async function tryAcceptCookies(page) {
  await page.click("text=ACCEPT COOKIES", { timeout: 1500 }).catch(() => {});
  await page.click("text=Accept Cookies", { timeout: 1500 }).catch(() => {});
  await page.click("text=Accept cookies", { timeout: 1500 }).catch(() => {});
  await page.click("text=I Accept", { timeout: 1500 }).catch(() => {});
  await page.click("text=Accept All", { timeout: 1500 }).catch(() => {});
  await page.click("text=Reject All", { timeout: 1500 }).catch(() => {});
}

async function fetchCoursesFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const url =
  `${SUPABASE_URL}/rest/v1/courses` +
  `?select=id,course_name,target_url,provider_course_id,course_slug,google_rating,google_reviews,provider,enabled,scrape_enabled,lifecycle_pilot_state,lifecycle_generation` +
  `&provider=eq.${PROVIDER}` +
  `&scrape_enabled=eq.true` +
  `&target_url=not.is.null` +
  `&order=course_name.asc`;

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase fetch failed: ${response.status} ${text}`);
  }

  const rows = JSON.parse(text);

  return rows.map((course) => ({
    id: course.id,
    targetUrl: course.target_url,
    courseName: course.course_name,
    providerCourseId: course.provider_course_id,
    courseSlug: course.course_slug,
    googleRating: course.google_rating,
    googleReviews: course.google_reviews,
    provider: course.provider,
    enabled: course.enabled,
    lifecyclePilotState: course.lifecycle_pilot_state ?? "legacy",
    lifecycleGeneration: course.lifecycle_generation ?? 0,
  }));
}

const { isIgSnapshotComplete } = lifecycleShadow;

function extractRowsFromAnchors(anchorRows, courseConfig, finalUrl, title, slotDate) {
  const extractedRows = [];

  for (const row of anchorRows) {
    const match = String(row.text || "").match(
      /(\d{1,2}:\d{2})\s*£\s*([0-9]+(?:\.[0-9]{2})?)/i
    );

    if (!match) continue;

    const slotTime = match[1];
    const price = normalisePrice(match[2]);

    if (!price) continue;

    const bookingUrl = row.href ? new URL(row.href, finalUrl).toString() : finalUrl;

    extractedRows.push({
      external_id: buildExternalId(
        courseConfig.providerCourseId,
        slotDate,
        slotTime,
        price
      ),
      provider_course_id: courseConfig.providerCourseId,
      course_name: courseConfig.courseName,
      slot_date: slotDate,
      slot_time: slotTime,
      price,
      players: 4,
      booking_url: bookingUrl,
      google_rating: courseConfig.googleRating,
      google_reviews: courseConfig.googleReviews,
      raw_payload: {
        source: "courses_v2_import_intelligent_golf",
        provider: courseConfig.provider,
        club: courseConfig.courseName,
        target_url: courseConfig.targetUrl,
        final_url: finalUrl,
        title,
        link_text: row.text,
      },
    });
  }

  return Array.from(
    new Map(extractedRows.map((row) => [row.external_id, row])).values()
  );
}

async function scrapeCourseInner(browser, courseConfig) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });

  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(30000);

  try {
    console.log(`Opening: ${courseConfig.courseName} — ${courseConfig.targetUrl}`);

    await page.goto(courseConfig.targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await page.waitForTimeout(1500);
    await tryAcceptCookies(page);
    await page.waitForTimeout(2500);

    // Advance the shared IntelligentGolf teesheet widget to tomorrow
    // BEFORE extracting anything -- confirmed live against production
    // club pages (a distinct domain per club, but the same widget:
    // `a.date-nav-btn[data-direction="next"]`) that this genuinely
    // re-renders the page with the next day's own real availability and
    // prices, not a relabelled copy of today's. If the click fails (the
    // widget isn't present, e.g. a site redesign), nextDayClicked stays
    // false and extraction below is skipped entirely -- this never
    // falls back to silently extracting today's page under tomorrow's
    // label.
    //
    // Skipped entirely for stable_active/stable_reconciling: that path
    // (below, via lifecycleShadow.applyIgSnapshotIngestion) begins its
    // snapshot token for TODAY before this function is even called, so
    // the page it fetches must stay on today too -- out of scope for
    // this fix, and left exactly as it already worked.
    const isStableState =
      courseConfig.lifecyclePilotState === "stable_active" ||
      courseConfig.lifecyclePilotState === "stable_reconciling";

    const nextDayClicked = isStableState
      ? false
      : await page
          .click('a.date-nav-btn[data-direction="next"]', { timeout: 5000 })
          .then(() => true)
          .catch(() => false);

    if (nextDayClicked) {
      await page.waitForTimeout(2500);
    }

    const title = await page.title();
    const finalUrl = page.url();

    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 10000 })
      .catch(() => "");

    const bodyPreview = bodyText.replace(/\s+/g, " ").trim().slice(0, 2000);

    const observedSlotDate =
      extractSlotDateFromBody(bodyText) ||
      extractDateFromUrl(finalUrl) ||
      extractDateFromUrl(courseConfig.targetUrl);

    const expectedSlotDate = tomorrowIsoDate();
    const slotDate = resolveIgSlotDate({
      isStableState,
      nextDayClicked,
      observedSlotDate,
      expectedSlotDate,
    });

    const anchorRows = slotDate
      ? await page.evaluate(() => {
          return Array.from(document.querySelectorAll("a")).map((a) => ({
            text: (a.innerText || "").replace(/\s+/g, " ").trim(),
            href: a.getAttribute("href"),
          }));
        }).catch(() => [])
      : [];

    const extractedRows = slotDate
      ? extractRowsFromAnchors(anchorRows, courseConfig, finalUrl, title, slotDate)
      : [];

    const safeSlug =
      courseConfig.courseSlug ||
      courseConfig.courseName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const info = {
      courseName: courseConfig.courseName,
      provider: courseConfig.provider,
      targetUrl: courseConfig.targetUrl,
      finalUrl,
      title,
      isStableState,
      nextDayClicked,
      expectedSlotDate: isStableState ? null : expectedSlotDate,
      observedSlotDate: observedSlotDate || null,
      slotDate: slotDate || null,
      extractedCount: extractedRows.length,
      extractedPreview: extractedRows.slice(0, 10),
      bodyPreview,
      note: isStableState
        ? !observedSlotDate
          ? "Could not detect slot date from page body or URL"
          : null
        : !nextDayClicked
          ? "Could not click the next-day control -- no rows extracted"
          : observedSlotDate !== expectedSlotDate
            ? `Page date after click (${observedSlotDate || "none detected"}) did not match expected tomorrow (${expectedSlotDate}) -- no rows extracted`
            : null,
    };

    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${safeSlug}-page-info.json`),
      JSON.stringify(info, null, 2)
    );

    console.log(`[${courseConfig.courseName}] V2 IG IMPORT PAGE INFO:`);
    console.log(JSON.stringify(info, null, 2));

    return {
      ok: true,
      course: courseConfig.courseName,
      provider: courseConfig.provider,
      extractedRows,
      info,
      slotDate: slotDate || null,
      snapshotComplete: isIgSnapshotComplete(bodyText, title, slotDate),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeCourse(browser, courseConfig) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Course timeout after ${COURSE_TIMEOUT_MS}ms`));
    }, COURSE_TIMEOUT_MS);
  });

  return Promise.race([
    scrapeCourseInner(browser, courseConfig),
    timeoutPromise,
  ]);
}

async function importRows(rows) {
  if (!MANUAL_IMPORT_SECRET) {
    throw new Error("Missing MANUAL_IMPORT_SECRET");
  }

  if (!rows.length) {
    console.log("No rows to import.");
    return {
      skipped: true,
      imported: 0,
    };
  }

  const payload = {
    source_key: "manual_import",
    rows,
  };

  const response = await fetch(
    `${SUPABASE_URL}/functions/v1/ingest-tee-times`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-import-secret": MANUAL_IMPORT_SECRET,
      },
      body: JSON.stringify(payload),
    }
  );

  const responseText = await response.text();

  console.log("IMPORT STATUS:", response.status);
  console.log("IMPORT RESPONSE:", responseText);

  if (!response.ok) {
    throw new Error(`Import failed: ${response.status} ${responseText}`);
  }

  return {
    skipped: false,
    imported: rows.length,
    responseText,
  };
}

// ---------------------------------------------------------------------------
// Shadow mode (lifecycle_pilot_state = 'shadow') — mirrors the BRS wiring:
// computes and logs a proposal only, never touches tee_times.
// ---------------------------------------------------------------------------

// Caller-asserted snapshot completeness for IG: true only when the page
// showed real teesheet markers and NOT a login-wall/error page. This
// mirrors the stricter IG rule established during investigation — IG has
// no structural "echoes the request back" signal like BRS's tee_date, so
// an untrusted/ambiguous page is never treated as a genuine empty
// snapshot. The caller (scrapeCourseInner) is the only place that can
// actually observe the page and make this determination; this module
// takes it as an input rather than re-deriving it from a URL/HTML string.
const shadowConfig = {
  supabaseUrl: SUPABASE_URL,
  supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
  manualImportSecret: MANUAL_IMPORT_SECRET,
  correlationId: RUN_CORRELATION_ID,
};

async function runShadowProposalForCourse(courseConfig, slotDate, scraperRunId, snapshotComplete, extractedRowsForShadow) {
  return lifecycleShadow.runIgShadowProposalForCourse(
    shadowConfig,
    courseConfig,
    slotDate,
    scraperRunId,
    snapshotComplete,
    extractedRowsForShadow,
  );
}

async function run() {
  ensureOutputDir();

  const courses = await fetchCoursesFromSupabase();

  console.log("MODE: V2_IMPORT_LIMITED_INTELLIGENT_GOLF");
  console.log("PROVIDER:", PROVIDER);
  console.log("SCRAPE_ENABLED_ONLY: true");
  console.log("COURSE_TIMEOUT_MS:", COURSE_TIMEOUT_MS);
  console.log("COURSES LOADED:", courses.length);
  console.log(JSON.stringify(courses, null, 2));

  const browser = await chromium.launch({
    headless: true,
  });

  const allRows = [];
  const courseResults = [];

  for (const courseConfig of courses) {
    try {
      const state = courseConfig.lifecyclePilotState;
      const isStableState = state === "stable_active" || state === "stable_reconciling";

      // Snapshot token must be obtained BEFORE the provider network
      // request — here, the Playwright page navigation inside
      // scrapeCourse. Same-day-only scraping means the expected date is
      // always today, known ahead of the fetch.
      let snapshotBegin = null;
      if (isStableState) {
        snapshotBegin = await lifecycleShadow.beginLifecycleSnapshot(shadowConfig, courseConfig, todayIsoDate());
        if (!snapshotBegin.body?.ok) {
          console.error(`[${courseConfig.courseName}] BEGIN SNAPSHOT REJECTED:`, JSON.stringify(snapshotBegin, null, 2));
        }
      }

      const result = await scrapeCourse(browser, courseConfig);
      courseResults.push(result);

      const extractedForShadow = result.extractedRows.map((r) => ({ slotTime: r.slot_time, price: r.price }));

      if (isStableState && result.slotDate) {
        // Stable states: legacy identity is never built or sent — this
        // course is excluded from allRows/uniqueRows entirely.
        if (!snapshotBegin?.body?.ok) {
          console.error(`[${courseConfig.courseName}] SKIPPED STABLE INGESTION: begin_lifecycle_snapshot was rejected before the fetch, no apply attempted.`);
        } else {
          try {
            const activeResult = await lifecycleShadow.applyIgSnapshotIngestion(
              shadowConfig,
              courseConfig,
              result.slotDate,
              snapshotBegin.body.snapshot_token,
              result.snapshotComplete,
              extractedForShadow,
            );
            console.log(`[${courseConfig.courseName}] STABLE INGESTION (${state}):`, JSON.stringify(activeResult, null, 2));
          } catch (activeError) {
            console.error(`[${courseConfig.courseName}] STABLE INGESTION ERROR:`, activeError);
          }
        }
      } else if (!isStableState) {
        allRows.push(...result.extractedRows);
      }

      // Shadow mode: separate call, logs a proposal only, never alters
      // allRows/uniqueRows — the legacy ingestion path below is
      // byte-for-byte unaffected by this.
      if (state === "shadow" && result.slotDate) {
        try {
          await runShadowProposalForCourse(
            courseConfig,
            result.slotDate,
            null,
            result.snapshotComplete,
            extractedForShadow,
          );
        } catch (shadowError) {
          console.error(`[${courseConfig.courseName}] SHADOW PROPOSAL ERROR:`, shadowError);
        }
      }
    } catch (error) {
      console.error(`[${courseConfig.courseName}] V2 IG IMPORT SCRAPE ERROR:`, error);

      courseResults.push({
        ok: false,
        course: courseConfig.courseName,
        provider: courseConfig.provider,
        extractedRows: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await browser.close();

  const uniqueRows = Array.from(
    new Map(allRows.map((row) => [row.external_id, row])).values()
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "rows-to-import.json"),
    JSON.stringify(uniqueRows, null, 2)
  );

  const importResult = await importRows(uniqueRows);

  const summary = {
    mode: "V2_IMPORT_LIMITED_INTELLIGENT_GOLF",
    provider: PROVIDER,
    scrapeEnabledOnly: true,
    totalCourses: courses.length,
    successfulCourses: courseResults.filter((r) => r.ok).length,
    failedCourses: courseResults.filter((r) => !r.ok).length,
    totalRowsExtracted: allRows.length,
    totalUniqueRowsImported: uniqueRows.length,
    importResult,
    courses: courseResults.map((r) => ({
      course: r.course,
      provider: r.provider,
      ok: r.ok,
      extractedCount: r.extractedRows ? r.extractedRows.length : 0,
      error: r.error || null,
    })),
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "summary.json"),
    JSON.stringify(summary, null, 2)
  );

  console.log("V2 IG IMPORT SUMMARY:");
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  runShadowProposalForCourse,
  isIgSnapshotComplete,
  londonTodayIsoDate,
  tomorrowIsoDate,
  extractSlotDateFromBody,
  extractDateFromUrl,
  extractRowsFromAnchors,
  buildExternalId,
  resolveIgSlotDate,
};
