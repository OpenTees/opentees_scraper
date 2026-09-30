const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const lifecycleShadow = require("./lifecycle-shadow");

const OUTPUT_DIR = path.join(process.cwd(), "scraper-output-v2-import");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MANUAL_IMPORT_SECRET = process.env.MANUAL_IMPORT_SECRET;

const PROVIDER = "brs";
const RUN_CORRELATION_ID = crypto.randomUUID();

const COURSE_TIMEOUT_MS = Number(process.env.COURSE_TIMEOUT_MS || 45000);

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
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
    // Absent on any Supabase project that hasn't applied the lifecycle
    // migration yet (undefined, not an error) — defaults to 'legacy' /
    // shadow-inert behaviour below, exactly like every course that has
    // never been moved off its default.
    lifecyclePilotState: course.lifecycle_pilot_state ?? "legacy",
    lifecycleGeneration: course.lifecycle_generation ?? 0,
  }));
}

function extractRowsFromBrsBody(bodyText, courseConfig, finalUrl, title) {
  const text = String(bodyText || "").replace(/\s+/g, " ").trim();

  const priceMatch = text.match(/TEE TIMES FROM\s*£\s*([0-9]+(?:\.[0-9]{2})?)/i);
  const price = priceMatch ? normalisePrice(priceMatch[1]) : null;

  if (!price) return [];

  const afterPrice = text.split(priceMatch[0])[1] || "";

  const timeMatches = Array.from(
    afterPrice.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)
  );

  const slotDate = todayIsoDate();

  const rows = timeMatches.map((match) => {
    const slotTime = `${match[1].padStart(2, "0")}:${match[2]}`;

    return {
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
      booking_url: finalUrl,
      google_rating: courseConfig.googleRating,
      google_reviews: courseConfig.googleReviews,
      raw_payload: {
        source: "courses_v2_import_brs",
        provider: courseConfig.provider,
        club: courseConfig.courseName,
        target_url: courseConfig.targetUrl,
        final_url: finalUrl,
        title,
        price_text: priceMatch[0],
      },
    };
  });

  return Array.from(
    new Map(rows.map((row) => [row.external_id, row])).values()
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

    const title = await page.title();
    const finalUrl = page.url();

    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 10000 })
      .catch(() => "");

    const bodyPreview = bodyText.replace(/\s+/g, " ").trim().slice(0, 2000);

    const extractedRows = extractRowsFromBrsBody(
      bodyText,
      courseConfig,
      finalUrl,
      title
    );

    const safeSlug =
      courseConfig.courseSlug ||
      courseConfig.courseName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const info = {
      courseName: courseConfig.courseName,
      provider: courseConfig.provider,
      targetUrl: courseConfig.targetUrl,
      finalUrl,
      title,
      slotDate: todayIsoDate(),
      extractedCount: extractedRows.length,
      extractedPreview: extractedRows.slice(0, 10),
      bodyPreview,
    };

    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${safeSlug}-page-info.json`),
      JSON.stringify(info, null, 2)
    );

    console.log(`[${courseConfig.courseName}] V2 IMPORT PAGE INFO:`);
    console.log(JSON.stringify(info, null, 2));

    return {
      ok: true,
      course: courseConfig.courseName,
      provider: courseConfig.provider,
      extractedRows,
      info,
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
// Shadow mode (lifecycle_pilot_state = 'shadow') — computes and logs a
// proposed stable identity + reconciliation decision without ever touching
// tee_times. Only reached for a course explicitly moved to 'shadow'; every
// course at its default ('legacy') never calls any of this.
// ---------------------------------------------------------------------------

const shadowConfig = {
  supabaseUrl: SUPABASE_URL,
  supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
  manualImportSecret: MANUAL_IMPORT_SECRET,
  correlationId: RUN_CORRELATION_ID,
};

async function runShadowProposalForCourse(courseConfig, slotDate, scraperRunId, teesheetJsonOverride) {
  return lifecycleShadow.runBrsShadowProposalForCourse(
    shadowConfig,
    courseConfig,
    slotDate,
    scraperRunId,
    teesheetJsonOverride,
  );
}

async function run() {
  ensureOutputDir();

  const courses = await fetchCoursesFromSupabase();

  console.log("MODE: V2_IMPORT_LIMITED_BRS");
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
      const result = await scrapeCourse(browser, courseConfig);
      courseResults.push(result);

      const state = courseConfig.lifecyclePilotState;

      if (state === "stable_active" || state === "stable_reconciling") {
        // Stable states: legacy identity is never built or sent for this
        // course — it is deliberately excluded from allRows/uniqueRows,
        // so the unfenced legacy ingestion call below cannot touch it.
        // Stable rows go through the snapshot-token path instead (begin
        // -> fresh BRS teesheet fetch -> apply), using a fresh BRS
        // teesheet fetch (the HTML-scrape extraction above doesn't carry
        // BRS's provider slot id, which the stable identity needs). The
        // token is obtained before this fetch, not after, so an older
        // in-flight scrape can never silently overwrite a newer one once
        // both reach the database.
        try {
          const activeResult = await lifecycleShadow.runBrsSnapshotIngestion(
            shadowConfig,
            courseConfig,
            todayIsoDate(),
          );
          console.log(`[${courseConfig.courseName}] STABLE INGESTION (${state}):`, JSON.stringify(activeResult, null, 2));
        } catch (activeError) {
          console.error(`[${courseConfig.courseName}] STABLE INGESTION ERROR:`, activeError);
        }
      } else {
        // legacy or shadow: today's unchanged legacy identity/ingestion.
        allRows.push(...result.extractedRows);
      }

      // Shadow mode: computes and logs a proposal only, via a completely
      // separate call — never alters `allRows`/`uniqueRows`, so the
      // legacy ingestion path below is byte-for-byte unaffected by this.
      if (state === "shadow") {
        try {
          await runShadowProposalForCourse(
            courseConfig,
            todayIsoDate(),
            null,
          );
        } catch (shadowError) {
          console.error(`[${courseConfig.courseName}] SHADOW PROPOSAL ERROR:`, shadowError);
        }
      }
    } catch (error) {
      console.error(`[${courseConfig.courseName}] V2 IMPORT SCRAPE ERROR:`, error);

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
    mode: "V2_IMPORT_LIMITED_BRS",
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

  console.log("V2 IMPORT SUMMARY:");
  console.log(JSON.stringify(summary, null, 2));
}

// Guarded so this file remains directly runnable (`node scrape-from-courses-v2-import.js`,
// unchanged behaviour) while also being safely `require()`-able for local
// testing of the shadow-mode functions without triggering a live Playwright run.
if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  runShadowProposalForCourse,
};
