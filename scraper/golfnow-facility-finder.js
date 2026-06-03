const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(process.cwd(), "golfnow-facility-finder-output");

const SEARCH_AREAS = [
  {
    name: "Kent / Sevenoaks",
    latitude: 51.270683,
    longitude: 0.09694,
    radius: 60,
  },
  {
    name: "Surrey / Guildford",
    latitude: 51.2362,
    longitude: -0.5704,
    radius: 60,
  },
  {
    name: "West Sussex / Horsham",
    latitude: 51.0629,
    longitude: -0.3259,
    radius: 60,
  },
  {
    name: "East Sussex / Crowborough",
    latitude: 51.0600,
    longitude: 0.1630,
    radius: 60,
  },
];

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

function buildPayload(area, pageNumber = 0) {
  return {
    useWidgetNextAvailableDays: null,
    nextAvailableTeeTime: null,
    tags: null,
    address: null,
    pageSize: 100,
    teeTimeCount: 20,
    pageNumber,
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
    latitude: area.latitude,
    longitude: area.longitude,
    radius: area.radius,
    maxAllowedRadius: null,
    facilityId: null,
    facilityIds: [],
    marketId: null,
    marketName: null,
    searchType: "Location",
    view: "Grouping",
    nonGPS: null,
    excludeFeaturedFacilities: false,
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

function extractFacilities(json) {
  const teeTimes = json?.ttResults?.teeTimes || [];

  const facilities = new Map();

  for (const teeTime of teeTimes) {
    const facility = teeTime.facility;
    if (!facility?.facilityId) continue;

    const key = String(facility.facilityId);

    if (!facilities.has(key)) {
      facilities.set(key, {
        facilityId: facility.facilityId,
        name: facility.name,
        seoFriendlyName: facility.seoFriendlyName,
        city: facility.address?.city || null,
        stateProvince: facility.address?.stateProvince || null,
        postalCode: facility.address?.postalCode || null,
        latitude: facility.latitude || null,
        longitude: facility.longitude || null,
        averageRating: facility.averageRating || null,
        reviewCount: facility.reviewCount || null,
        websiteAddress: facility.websiteAddress || null,
        teeTimeCount: 0,
        firstTeeTime: teeTime.time?.date || null,
        minPrice: null,
        targetUrl: facility.seoFriendlyName
          ? `https://www.golfnow.co.uk/tee-times/facility/${facility.seoFriendlyName}/search`
          : `https://www.golfnow.co.uk/tee-times/facility/${facility.facilityId}/search`,
      });
    }

    const existing = facilities.get(key);

    existing.teeTimeCount += 1;

    const price = Number(
      teeTime.displayRate?.value ??
      teeTime.minTeeTimeRate?.value ??
      teeTime.teeTimeRates?.[0]?.singlePlayerPrice?.greensFees?.value
    );

    if (Number.isFinite(price)) {
      existing.minPrice =
        existing.minPrice === null ? Math.round(price) : Math.min(existing.minPrice, Math.round(price));
    }
  }

  return Array.from(facilities.values());
}

async function fetchArea(area) {
  const response = await fetch(
    "https://www.golfnow.co.uk/api/tee-times/tee-time-search-results",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://www.golfnow.co.uk",
        Referer: "https://www.golfnow.co.uk/tee-times/search",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify(buildPayload(area)),
    }
  );

  const text = await response.text();

  console.log(`[${area.name}] STATUS:`, response.status);
  console.log(`[${area.name}] BODY PREVIEW:`, text.slice(0, 300));

  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${area.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-raw.json`),
    text
  );

  if (!response.ok) {
    return {
      area: area.name,
      ok: false,
      status: response.status,
      facilities: [],
    };
  }

  const json = JSON.parse(text);
  const facilities = extractFacilities(json);

  return {
    area: area.name,
    ok: true,
    status: response.status,
    facilities,
  };
}

async function run() {
  ensureOutputDir();

  const results = [];

  for (const area of SEARCH_AREAS) {
    const result = await fetchArea(area);
    results.push(result);
  }

  const allFacilities = [];

  for (const result of results) {
    for (const facility of result.facilities) {
      allFacilities.push({
        searchArea: result.area,
        ...facility,
      });
    }
  }

  const deduped = Array.from(
    new Map(allFacilities.map((facility) => [facility.facilityId, facility])).values()
  ).sort((a, b) => {
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "facility-finder-summary.json"),
    JSON.stringify(
      {
        date: tomorrowGolfNowDate(),
        searchAreas: SEARCH_AREAS,
        totalUniqueFacilities: deduped.length,
        facilities: deduped,
      },
      null,
      2
    )
  );

  console.log("GOLFNOW FACILITY FINDER SUMMARY:");
  console.log(JSON.stringify({
    date: tomorrowGolfNowDate(),
    totalUniqueFacilities: deduped.length,
    facilities: deduped.map((facility) => ({
      facilityId: facility.facilityId,
      name: facility.name,
      city: facility.city,
      postalCode: facility.postalCode,
      teeTimeCount: facility.teeTimeCount,
      minPrice: facility.minPrice,
      targetUrl: facility.targetUrl,
    })),
  }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
