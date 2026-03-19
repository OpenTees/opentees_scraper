const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const OUTPUT_DIR = path.join(process.cwd(), "scraper-output");

const COURSES = [
  {
    targetUrl: "https://members.manningsheath.com/visitorbooking/",
    courseName: "Mannings Heath Golf Club",
    providerCourseId: "intelligent-golf-mannings-heath",
    courseSlug: "mannings-heath",
    googleRating: 4.3,
    googleReviews: 1248,
  },
  {
    targetUrl: "https://reigatehill.intelligentgolf.co.uk/visitorbooking/",
    courseName: "Reigate Hill Golf Club",
    providerCourseId: "intelligent-golf-reigate-hill",
    courseSlug: "reigate-hill",
    googleRating: 4.2,
    googleReviews: 987,
  },
  {
    targetUrl: "https://www.charthamparkgolfclub.com/visitorbooking/",
    courseName: "Chartham Park Golf & Country Club",
    providerCourseId: "intelligent-golf-chartham-park",
    courseSlug: "chartham-park",
    googleRating: 4.1,
    googleReviews: 612,
  },
  {
    targetUrl: "https://www.theleatherheadclub.com/visitorbooking/",
    courseName: "The Leatherhead Club",
    providerCourseId: "intelligent-golf-leatherhead",
    courseSlug: "leatherhead",
    googleRating: null,
    googleReviews: null,
  },
  {
    targetUrl: "https://www.kingswood-golf.co.uk/visitorbooking/",
    courseName: "Kingswood Golf Club",
    providerCourseId: "intelligent-golf-kingswood",
    courseSlug: "kingswood",
    googleRating: null,
    googleReviews: null,
  },
  {
    targetUrl: "https://golf.addingtoncourt-golfclub.co.uk/visitorbooking/",
    courseName: "Addington Court",
    providerCourseId: "intelligent-golf-addington-court",
    courseSlug: "addington-court",
    googleRating: null,
    googleReviews: null,
  },
  {
    targetUrl: "https://www.ifieldgolf.com/visitorbooking/",
    courseName: "Ifield Golf Club",
    providerCourseId: "intelligent-golf-ifield",
    courseSlug: "ifield",
    googleRating: null,
    googleReviews: null,
  },
  {
    targetUrl: "https://www.hammanor.co.uk/visitorbooking/",
    courseName: "Ham Manor Golf Club",
    providerCourseId: "intelligent-golf-ham-manor",
    courseSlug: "ham-manor",
    googleRating: null,
    googleReviews: null,
  },
  {
    targetUrl: "https://horsham.intelligentgolf.co.uk/visitorbooking/",
    courseName: "Horsham Golf & Fitness",
    providerCourseId: "intelligent-golf-horsham",
    courseSlug: "horsham",
    googleRating: null,
    googleReviews: null,
  },
  {
    targetUrl: "https://bognorregis.hub.clubv1.com/Visitors/TeeSheet?date=2026-03-19",
    courseName: "Bognor Regis Golf Club",
    providerCourseId: "clubv1-bognor-regis",
    courseSlug: "bognor-regis",
    googleRating: null,
    googleReviews: null,
  },
  {
    targetUrl: "https://hornepark.intelligentgolf.co.uk/visitorbooking/",
    courseName: "Horne Park Golf Club",
    providerCourseId: "intelligent-golf-horne-park",
    courseSlug: "horne-park",
    googleRating: null,
    googleReviews: null,
  },
];

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
  const match = bodyText.match(
    /\b(?:Mon|Tue|Tues|Wed|Thu|Thur|Fri|Sat|Sun),?\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\b/i,
  );

  if (!match) {
    return null;
  }

  const day = String(match[1]).padStart(2, "0");
  const month = monthNameToNumber(match[2]);
  const year = new Date().getUTCFullYear();

  if (!month) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

function extractDateFromUrl(targetUrl) {
  const match = String(targetUrl || "").match(/[?&]date=(\d{4}-\d{2}-\d{2})/i);
  return match ? match[1] : null;
}

function normalisePrice(priceText) {
  if (!priceText) return null;

  let cleaned = String(priceText)
    .replace(/[^\d.]/g, "")
    .replace(/(\..*)\./g, "$1")
    .replace(/^\./, "");

  const value = Number(cleaned);

  if (!Number.isFinite(value)) return null;

  return Math.round(value);
}

function buildExternalId(courseSlug, slotDate, slotTime, price) {
  return `ig-${courseSlug}-${slotDate}-${slotTime}-${price ?? "na"}`;
}

async function tryAcceptCookies(page) {
  await page.click("text=ACCEPT COOKIES").catch(() => {});
  await page.click("text=Accept Cookies").catch(() => {});
  await page.click("text=Accept cookies").catch(() => {});
}

function extractRowsFromAnchors(anchorRows, courseConfig, finalUrl, title, slotDate) {
  const extractedRows = [];

  for (const row of anchorRows) {
    const match = String(row.text || "").match(/(\d{1,2}:\d{2})\s*£\s*([0-9]+(?:\.[0-9]{2})?)/i);

    if (!match) {
      continue;
    }

    const slotTime = match[1];
    const price = normalisePrice(match[2]);

    if (!price) {
      continue;
    }

    const bookingUrl = row.href
      ? new URL(row.href, finalUrl).toString()
      : finalUrl;

    extractedRows.push({
      external_id: buildExternalId(
        courseConfig.courseSlug,
        slotDate,
        slotTime,
        price,
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
        source: "visitor_booking_page",
        club: courseConfig.courseName,
        target_url: courseConfig.targetUrl,
        final_url: finalUrl,
        title,
        link_text: row.text,
      },
    });
  }

  return Array.from(
    new Map(extractedRows.map((row) => [row.external_id, row])).values(),
  );
}

async function scrapeCourse(browser, courseConfig) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  console.log(`Opening: ${courseConfig.targetUrl}`);

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

  let slotDate = extractSlotDateFromBody(bodyText);

  if (!slotDate) {
    slotDate = extractDateFromUrl(courseConfig.targetUrl);
  }

  const screenshotPath = path.join(
    OUTPUT_DIR,
    `${courseConfig.courseSlug}-visitorbooking.png`,
  );

  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  const anchorRows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a")).map((a) => ({
      text: (a.innerText || "").replace(/\s+/g, " ").trim(),
      href: a.getAttribute("href"),
    }));
  });

  const extractedRows = slotDate
    ? extractRowsFromAnchors(anchorRows, courseConfig, finalUrl, title, slotDate)
    : [];

  const info = {
    targetUrl: courseConfig.targetUrl,
    finalUrl,
    title,
    courseName: courseConfig.courseName,
    providerCourseId: courseConfig.providerCourseId,
    slotDate: slotDate || null,
    extractedCount: extractedRows.length,
    extractedPreview: extractedRows.slice(0, 10),
    bodyPreview,
    note: !slotDate ? "Could not detect slot date from page body or URL" : null,
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${courseConfig.courseSlug}-page-info.json`),
    JSON.stringify(info, null, 2),
  );

  if (!slotDate) {
    console.log(
      `[${courseConfig.courseName}] No slot date detected from page body or URL. Exiting cleanly for this course.`,
    );
  }

  console.log(`[${courseConfig.courseName}] PAGE INFO:`);
  console.log(JSON.stringify(info, null, 2));

  await page.close();

  return {
    ok: true,
    course: courseConfig.courseName,
    extractedRows,
    info,
  };
}

async function importRows(importSecret, rows) {
  if (!rows.length) {
    console.log("No rows to import. Exiting successfully.");
    return;
  }

  const payload = {
    source_key: "manual_import",
    rows,
  };

  const response = await fetch(
    "https://edkpdujmnwbiwowfwvpr.supabase.co/functions/v1/ingest-tee-times",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-import-secret": importSecret,
      },
      body: JSON.stringify(payload),
    },
  );

  const responseText = await response.text();

  console.log("IMPORT STATUS:", response.status);
  console.log("IMPORT RESPONSE:", responseText);

  if (!response.ok) {
    throw new Error(`Import failed: ${response.status} ${responseText}`);
  }
}

async function run() {
  ensureOutputDir();

  const importSecret = process.env.MANUAL_IMPORT_SECRET;

  if (!importSecret) {
    throw new Error("Missing MANUAL_IMPORT_SECRET");
  }

  const browser = await chromium.launch({
    headless: true,
  });

  const allRows = [];
  const courseResults = [];

  for (const courseConfig of COURSES) {
    try {
      const result = await scrapeCourse(browser, courseConfig);
      courseResults.push(result);
      allRows.push(...result.extractedRows);
    } catch (error) {
      console.error(`[${courseConfig.courseName}] SCRAPE ERROR:`, error);

      courseResults.push({
        ok: false,
        course: courseConfig.courseName,
        extractedRows: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await browser.close();

  const summary = {
    totalCourses: COURSES.length,
    successfulCourses: courseResults.filter((r) => r.ok).length,
    failedCourses: courseResults.filter((r) => !r.ok).length,
    totalRowsExtracted: allRows.length,
    courses: courseResults.map((r) => ({
      course: r.course,
      ok: r.ok,
      extractedCount: r.extractedRows ? r.extractedRows.length : 0,
      error: r.error || null,
    })),
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "summary.json"),
    JSON.stringify(summary, null, 2),
  );

  console.log("SCRAPE SUMMARY:");
  console.log(JSON.stringify(summary, null, 2));

  await importRows(importSecret, allRows);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
