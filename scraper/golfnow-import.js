const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(process.cwd(), "golfnow-import-output");

const SUPABASE_URL = process.env.SUPABASE_URL;
const MANUAL_IMPORT_SECRET = process.env.MANUAL_IMPORT_SECRET;

const COURSE = {
  courseName: "Westerham Golf Club",
  providerCourseId: "golfnow-westerham",
  courseSlug: "westerham",
  facilityId: 13846,
  latitude: 51.270683,
  longitude: 0.09694,
};

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function todayGolfNowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: "Europe/London",
  });
}

function buildPayload() {
  return {
    useWidgetNextAvailableDays: null,
    nextAvailableTeeTime: null,
    tags: null,
    address: null,
    pageSize: 30,
    teeTimeCount: 20,
    pageNumber: 0,
    date: todayGolfNowDate(),
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
    latitude: COURSE.latitude,
    longitude: COURSE.longitude,
    radius: 35,
    maxAllowedRadius: null,
    facilityId: COURSE.facilityId,
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

function normalisePrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function mapTeeTimes(json) {
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
        : `https://www.golfnow.co.uk/tee-times/facility/${COURSE.facilityId}`;

      return {
        external_id: `golfnow-${COURSE.facilityId}-${teeTimeRateId || `${slotDate}-${slotTime}`}`,
        provider_course_id: COURSE.providerCourseId,
        course_name: COURSE.courseName,
        slot_date: slotDate,
        slot_time: slotTime,
        price,
        players: 4,
        booking_url: bookingUrl,
        raw_payload: {
          source: "golfnow_import",
          facility_id: COURSE.facilityId,
          tee_time_rate_id: teeTimeRateId,
          detail_url: detailUrl,
        },
      };
    })
    .filter((row) => row.slot_date && row.slot_time && row.booking_url);
}

async function fetchGolfNowRows() {
  const response = await fetch(
    "https://www.golfnow.co.uk/api/tee-times/tee-time-search-results",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://www.golfnow.co.uk",
        Referer: "https://www.golfnow.co.uk/tee-times/facility/13846-westerham-golf-club/search",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify(buildPayload()),
    }
  );

  const text = await response.text();

  console.log("GOLFNOW STATUS:", response.status);
  console.log("GOLFNOW BODY PREVIEW:", text.slice(0, 500));

  fs.writeFileSync(path.join(OUTPUT_DIR, "raw-response.json"), text);

  if (!response.ok) {
    throw new Error(`GolfNow request failed: ${response.status}`);
  }

  const json = JSON.parse(text);
  const rows = mapTeeTimes(json);

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "rows-to-import.json"),
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

  console.log("MODE: GOLFNOW_IMPORT_LIMITED_WESTERHAM");
  console.log("COURSE:", COURSE);

  const rows = await fetchGolfNowRows();
  const importResult = await importRows(rows);

  const summary = {
    mode: "GOLFNOW_IMPORT_LIMITED_WESTERHAM",
    course: COURSE.courseName,
    facilityId: COURSE.facilityId,
    rowsExtracted: rows.length,
    rowsSentToImporter: rows.length,
    importResult,
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
