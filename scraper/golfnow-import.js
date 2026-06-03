const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(process.cwd(), "golfnow-import-output");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MANUAL_IMPORT_SECRET = process.env.MANUAL_IMPORT_SECRET;

const PROVIDER = "golfnow";

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function tomorrowGolfNowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: "Europe/London",
  });
}

function extractFacilityId(targetUrl) {
  const match = String(targetUrl || "").match(/facility\/(\d+)/i);
  return match ? Number(match[1]) : null;
}

function normalisePrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

async function fetchCoursesFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const url =
    `${SUPABASE_URL}/rest/v1/courses` +
    `?select=course_name,target_url,provider_course_id,course_slug,google_rating,google_reviews,provider,enabled,scrape_enabled` +
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

  return rows
    .map((course) => {
      const facilityId = extractFacilityId(course.target_url);

      return {
        targetUrl: course.target_url,
        courseName: course.course_name,
        providerCourseId: course.provider_course_id,
        courseSlug: course.course_slug,
        googleRating: course.google_rating,
        googleReviews: course.google_reviews,
        provider: course.provider,
        enabled: course.enabled,
        scrapeEnabled: course.scrape_enabled,
        facilityId,
      };
    })
    .filter((course) => Number.isFinite(course.facilityId));
}

function buildPayload(course) {
  return {
    useWidgetNextAvailableDays: null,
    nextAvailableTeeTime: null,
    tags: null,
    address: null,
    pageSize: 30,
    teeTimeCount: 20,
    pageNumber: 0,
    date: tomorrowGolfNowDate(),
    sortBy: "Date",
    sortByRollup: "Date.MinDate",
    sortDirection: "Asc",
    hotDealsOnly: false,
    golfPassPerksOnly: false,
    bestDealsOnly: false,
    promotedCampaignsOnly: false,
    priceMin: 0,
    priceMax: 10000,
    players: 0,
    timePeriod: "Any",
    timeMin: 10,
    timeMax: 42,
    holes: "Any",
    facilityType: "GolfCourse",
    latitude: null,
    longitude: null,
    radius: 35,
    maxAllowedRadius: null,
    facilityId: course.facilityId,
    facilityIds: [],
    marketId: null,
    marketName: null,
    searchType: "Facility",
    view: "Grouping",
    nonGPS: null,
    excludeFeaturedFacilities: true,
    excludePrivateFacilities: false,
    rateTagCodes: null,
    customerToken: null,
    rateType: "all",
    currentClientDate: new Date().toISOString(),
    daysToSearch: null,
    facilityTagsExclusive: null,
    isSimulator: null,
    isHotDealsZoneMoreDeals: null,
    facilityGroupId: null,
    trackmanOnly: false,
  };
}

function mapTeeTimes(json, course) {
  const teeTimes = json?.ttResults?.teeTimes || [];

  return teeTimes
    .map((teeTime) => {
      const rate = teeTime.teeTimeRates?.[0];
      const dateTime = teeTime.time?.date || null;

      const slotDate = dateTime ? dateTime.slice(0, 10) : null;
      const slotTime = dateTime ? dateTime.slice(11, 16) : teeTime.time?.formatted || null;

      const price =
        normalisePrice(teeTime.displayRate?.value) ??
        normalisePrice(teeTime.minTeeTimeRate?.value) ??
        normalisePrice(rate?.singlePlayerPrice?.greensFees?.value);

      const teeTimeRateId =
        rate?.teeTimeRateId ||
        teeTime.defaultTeeTimeRateId ||
        null;

      const detailUrl =
        teeTime.detailUrl ||
        rate?.detailUrl ||
        null;

      const bookingUrl = detailUrl
        ? `https://www.golfnow.co.uk${detailUrl}`
        : `https://www.golfnow.co.uk/tee-times/facility/${course.facilityId}`;

      return {
        external_id: `golfnow-${course.facilityId}-${teeTimeRateId || `${slotDate}-${slotTime}`}`,
        provider_course_id: course.providerCourseId,
        course_name: course.courseName,
        slot_date: slotDate,
        slot_time: slotTime,
        price,
        players: 4,
        booking_url: bookingUrl,
        google_rating: course.googleRating,
        google_reviews: course.googleReviews,
        raw_payload: {
          source: "golfnow_import",
          facility_id: course.facilityId,
          tee_time_rate_id: teeTimeRateId,
          detail_url: detailUrl,
          provider: course.provider,
          target_url: course.targetUrl,
        },
      };
    })
    .filter((row) => row.slot_date && row.slot_time && row.booking_url);
}

async function fetchGolfNowRowsForCourse(course) {
  const referer = course.targetUrl.includes("golfnow.")
    ? course.targetUrl
    : `https://www.golfnow.co.uk/tee-times/facility/${course.facilityId}/search`;

  const response = await fetch(
    "https://www.golfnow.co.uk/api/tee-times/tee-time-search-results",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://www.golfnow.co.uk",
        Referer: referer,
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify(buildPayload(course)),
    }
  );

  const text = await response.text();

  console.log(`[${course.courseName}] GOLFNOW STATUS:`, response.status);
  console.log(`[${course.courseName}] BODY PREVIEW:`, text.slice(0, 300));

  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${course.courseSlug || course.facilityId}-raw-response.json`),
    text
  );

  if (!response.ok) {
    throw new Error(`GolfNow request failed for ${course.courseName}: ${response.status}`);
  }

  const json = JSON.parse(text);
  const rows = mapTeeTimes(json, course);

  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${course.courseSlug || course.facilityId}-mapped-rows.json`),
    JSON.stringify(rows, null, 2)
  );

  return rows;
}

async function importRows(rows) {
  if (!SUPABASE_URL) {
    throw new Error("Missing SUPABASE_URL");
  }

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

  console.log("MODE: GOLFNOW_IMPORT_DATABASE_DRIVEN");
  console.log("PROVIDER:", PROVIDER);
  console.log("SCRAPE_ENABLED_ONLY: true");
  console.log("COURSES LOADED:", courses.length);
  console.log(JSON.stringify(courses, null, 2));

  const allRows = [];
  const courseResults = [];

  for (const course of courses) {
    try {
      const rows = await fetchGolfNowRowsForCourse(course);

      allRows.push(...rows);

      courseResults.push({
        course: course.courseName,
        facilityId: course.facilityId,
        ok: true,
        extractedCount: rows.length,
        error: null,
      });
    } catch (error) {
      console.error(`[${course.courseName}] GOLFNOW ERROR:`, error);

      courseResults.push({
        course: course.courseName,
        facilityId: course.facilityId,
        ok: false,
        extractedCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const uniqueRows = Array.from(
    new Map(allRows.map((row) => [row.external_id, row])).values()
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "rows-to-import.json"),
    JSON.stringify(uniqueRows, null, 2)
  );

  const importResult = await importRows(uniqueRows);

  const summary = {
    mode: "GOLFNOW_IMPORT_DATABASE_DRIVEN",
    provider: PROVIDER,
    scrapeEnabledOnly: true,
    totalCourses: courses.length,
    successfulCourses: courseResults.filter((r) => r.ok).length,
    failedCourses: courseResults.filter((r) => !r.ok).length,
    totalRowsExtracted: allRows.length,
    totalUniqueRowsImported: uniqueRows.length,
    importResult,
    courses: courseResults,
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "summary.json"),
    JSON.stringify(summary, null, 2)
  );

  console.log("GOLFNOW IMPORT SUMMARY:");
  console.log(JSON.stringify(summary, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
