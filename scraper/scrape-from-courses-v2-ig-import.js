const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const OUTPUT_DIR = path.join(process.cwd(), "scraper-output-v2-ig-import");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MANUAL_IMPORT_SECRET = process.env.MANUAL_IMPORT_SECRET;

const ALLOWED_COURSES = [
  "Hever Castle Golf Club",
  "Tilgate Forest Golf Centre"
];

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

  const courseFilter = ALLOWED_COURSES.map((name) => `"${name}"`).join(",");

  const url =
    `${SUPABASE_URL}/rest/v1/courses` +
    `?select=course_name,target_url,provider_course_id,course_slug,google_rating,google_reviews,provider,enabled` +
    `&course_name=in.(${courseFilter})` +
    `&provider=eq.intelligent_golf` +
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
    targetUrl: course.target_url,
    courseName: course.course_name,
    providerCourseId: course.provider_course_id,
    courseSlug: course.course_slug,
    googleRating: course.google_rating,
    googleReviews: course.google_reviews,
    provider: course.provider,
    enabled: course.enabled,
  }));
}

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

    const title = await page.title();
    const finalUrl = page.url();

    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 10000 })
      .catch(() => "");

    const bodyPreview = bodyText.replace(/\s+/g, " ").trim().slice(0, 2000);

    const slotDate =
      extractSlotDateFromBody(bodyText) ||
      extractDateFromUrl(finalUrl) ||
      extractDateFromUrl(courseConfig.targetUrl);

    const anchorRows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a")).map((a) => ({
        text: (a.innerText || "").replace(/\s+/g, " ").trim(),
        href: a.getAttribute("href"),
      }));
    }).catch(() => []);

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
      slotDate: slotDate || null,
      extractedCount: extractedRows.length,
      extractedPreview: extractedRows.slice(0, 10),
      bodyPreview,
      note: !slotDate ? "Could not detect slot date from page body or URL" : null,
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

async function run() {
  ensureOutputDir();

  const courses = await fetchCoursesFromSupabase();

  console.log("MODE: V2_IMPORT_LIMITED_INTELLIGENT_GOLF");
  console.log("ALLOWED_COURSES:", ALLOWED_COURSES);
  console.log("COURSE_TIMEOUT_MS:", COURSE_TIMEOUT_MS);
  console.log("COURSES LOADED:", courses.length);
  console.log(JSON.stringify(courses, null, 2));

  const missingCourses = ALLOWED_COURSES.filter(
    (name) => !courses.some((course) => course.courseName === name)
  );

  if (missingCourses.length) {
    throw new Error(`Missing expected courses from Supabase: ${missingCourses.join(", ")}`);
  }

  const browser = await chromium.launch({
    headless: true,
  });

  const allRows = [];
  const courseResults = [];

  for (const courseConfig of courses) {
    try {
      const result = await scrapeCourse(browser, courseConfig);
      courseResults.push(result);
      allRows.push(...result.extractedRows);
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
    allowedCourses: ALLOWED_COURSES,
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

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
