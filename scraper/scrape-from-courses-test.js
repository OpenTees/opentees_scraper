const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const OUTPUT_DIR = path.join(process.cwd(), "scraper-output-test");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TEST_PROVIDERS = (process.env.TEST_PROVIDERS || "intelligent_golf")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

const MAX_COURSES = Number(process.env.MAX_COURSES || 5);

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
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

function extractDateFromUrl(targetUrl) {
  const match = String(targetUrl || "").match(/[?&]date=(\d{4}-\d{2}-\d{2})/i);
  return match ? match[1] : null;
}

function extractDateFromClubV1Body(bodyText) {
  const text = String(bodyText || "");

  const match = text.match(
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/i
  );

  if (!match) return null;

  const day = String(match[1]).padStart(2, "0");
  const month = monthNameToNumber(match[2]);
  const year = match[3];

  if (!month) return null;

  return `${year}-${month}-${day}`;
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

function buildExternalId(courseSlug, slotDate, slotTime, price) {
  return `test-${courseSlug}-${slotDate}-${slotTime}-${price ?? "na"}`;
}

async function tryAcceptCookies(page) {
  await page.click("text=ACCEPT COOKIES").catch(() => {});
  await page.click("text=Accept Cookies").catch(() => {});
  await page.click("text=Accept cookies").catch(() => {});
  await page.click("text=I Accept").catch(() => {});
  await page.click("text=Accept All").catch(() => {});
}

async function fetchCoursesFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const providerFilter = TEST_PROVIDERS.map((p) => `"${p}"`).join(",");

  const url =
    `${SUPABASE_URL}/rest/v1/courses` +
    `?select=course_name,target_url,provider_course_id,course_slug,google_rating,google_reviews,provider,enabled` +
    `&enabled=eq.false` +
    `&target_url=not.is.null` +
    `&provider=in.(${providerFilter})` +
    `&order=course_name.asc` +
    `&limit=${MAX_COURSES}`;

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

  return JSON.parse(text).map((course) => ({
    targetUrl: course.target_url,
    courseName: course.course_name,
    providerCourseId: course.provider_course_id,
    courseSlug: course.course_slug,
    googleRating: course.google_rating,
    googleReviews: course.google_reviews,
    provider: course.provider,
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
      external_id: buildExternalId(courseConfig.courseSlug, slotDate, slotTime, price),
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
        source: "courses_table_test_scraper_anchor",
        provider: courseConfig.provider,
        club: courseConfig.courseName,
        target_url: courseConfig.targetUrl,
        final_url: finalUrl,
        title,
        link_text: row.text,
      },
    });
  }

  return Array.from(new Map(extractedRows.map((row) => [row.external_id, row])).values());
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
      external_id: buildExternalId(courseConfig.courseSlug, slotDate, slotTime, price),
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
        source: "courses_table_test_scraper_brs_body",
        provider: courseConfig.provider,
        club: courseConfig.courseName,
        target_url: courseConfig.targetUrl,
        final_url: finalUrl,
        title,
        price_text: priceMatch[0],
      },
    };
  });

  return Array.from(new Map(rows.map((row) => [row.external_id, row])).values());
}

function extractRowsFromClubV1Body(bodyText, courseConfig, finalUrl, title) {
  const text = String(bodyText || "").replace(/\s+/g, " ").trim();

  const slotDate =
    extractDateFromUrl(finalUrl) ||
    extractDateFromClubV1Body(text) ||
    todayIsoDate();

  const rowRegex =
    /\b([01]?\d|2[0-3]):([0-5]\d)\s+([0-9]+(?:\.[0-9]{2})?)\s+[0-9]+(?:\.[0-9]{2})?\s+[0-9]+(?:\.[0-9]{2})?\s+[0-9]+(?:\.[0-9]{2})?\s+Book\b/g;

  const rows = [];

  for (const match of text.matchAll(rowRegex)) {
    const slotTime = `${match[1].padStart(2, "0")}:${match[2]}`;
    const price = normalisePrice(match[3]);

    if (!price) continue;

    rows.push({
      external_id: buildExternalId(courseConfig.courseSlug, slotDate, slotTime, price),
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
        source: "courses_table_test_scraper_clubv1_body",
        provider: courseConfig.provider,
        club: courseConfig.courseName,
        target_url: courseConfig.targetUrl,
        final_url: finalUrl,
        title,
      },
    });
  }

  return Array.from(new Map(rows.map((row) => [row.external_id, row])).values());
}

async function scrapeCourse(browser, courseConfig) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  console.log(`Opening: ${courseConfig.courseName} — ${courseConfig.targetUrl}`);

  await page.goto(courseConfig.targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  await page.waitForTimeout(3000);
  await tryAcceptCookies(page);
  await page.waitForTimeout(8000);

  const title = await page.title();
  const finalUrl = page.url();

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const bodyPreview = bodyText.replace(/\s+/g, " ").trim().slice(0, 3000);

  let slotDate =
    extractSlotDateFromBody(bodyText) ||
    extractDateFromUrl(finalUrl) ||
    extractDateFromUrl(courseConfig.targetUrl);

  const safeSlug =
    courseConfig.courseSlug ||
    courseConfig.courseName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${safeSlug}-test.png`),
    fullPage: false,
  });

  const anchorRows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a")).map((a) => ({
      text: (a.innerText || "").replace(/\s+/g, " ").trim(),
      href: a.getAttribute("href"),
    }));
  });

  let extractedRows = [];

  if (courseConfig.provider === "brs") {
    extractedRows = extractRowsFromBrsBody(bodyText, courseConfig, finalUrl, title);
    slotDate = todayIsoDate();
  } else if (courseConfig.provider === "clubv1") {
    extractedRows = extractRowsFromClubV1Body(bodyText, courseConfig, finalUrl, title);
    slotDate = extractedRows[0]?.slot_date || slotDate || todayIsoDate();
  } else if (slotDate) {
    extractedRows = extractRowsFromAnchors(
      anchorRows,
      courseConfig,
      finalUrl,
      title,
      slotDate
    );
  }

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
    note:
      !slotDate && !["brs", "clubv1"].includes(courseConfig.provider)
        ? "Could not detect slot date from page body or URL"
        : null,
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${safeSlug}-page-info.json`),
    JSON.stringify(info, null, 2)
  );

  console.log(`[${courseConfig.courseName}] TEST PAGE INFO:`);
  console.log(JSON.stringify(info, null, 2));

  await page.close();

  return {
    ok: true,
    course: courseConfig.courseName,
    provider: courseConfig.provider,
    extractedRows,
    info,
  };
}

async function run() {
  ensureOutputDir();

  const courses = await fetchCoursesFromSupabase();

  console.log("TEST PROVIDERS:", TEST_PROVIDERS);
  console.log("MAX COURSES:", MAX_COURSES);
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
      allRows.push(...result.extractedRows);
    } catch (error) {
      console.error(`[${courseConfig.courseName}] TEST SCRAPE ERROR:`, error);

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

  const summary = {
    mode: "TEST_ONLY_NO_IMPORT",
    totalCourses: courses.length,
    successfulCourses: courseResults.filter((r) => r.ok).length,
    failedCourses: courseResults.filter((r) => !r.ok).length,
    totalRowsExtracted: allRows.length,
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

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "extracted-rows-preview.json"),
    JSON.stringify(allRows.slice(0, 50), null, 2)
  );

  console.log("TEST SCRAPE SUMMARY:");
  console.log(JSON.stringify(summary, null, 2));

  console.log("IMPORTANT: This test scraper did not import anything into tee_times.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
