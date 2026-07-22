const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");
const { createScraperMeasurement } = require("../scraper/measurement");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const measurement = createScraperMeasurement({
  sourceName: "github-actions-golfnow-discovery",
  provider: "golfnow",
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  realtime: {
    enabled: false,
  },
});
async function main() {
  await measurement.emit("scraper.started", { authoritative: false });
  const { data: nodes, error } = await supabase
    .from("golfnow_discovery_nodes")
    .select("*")
    .eq("enabled", true)
    .order("last_run_at", { ascending: true, nullsFirst: true })
    .limit(Number(process.env.LIMIT_NODES || 3));

  if (error) throw error;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const allRows = [];

  for (const node of nodes || []) {
    console.log(`Discovering: ${node.node_name}`);

    const responses = [];

page.on("response", async (res) => {
  const url = res.url();

  if (
  url.includes("courses-near-me") ||
  url.includes("tee-time-search-results")
) 
  {

  console.log("Response:", res.status(), url);

}

  if (
    url.includes("courses-near-me") &&
    res.request().method() === "POST"
  ) {
    responses.push(res);
  }
});
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);

const formattedDate = tomorrow.toLocaleDateString("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
    const searchUrl =
  `https://www.golfnow.co.uk/tee-times/search` +
  `#facilitytype=0` +
  `&date=${encodeURIComponent(formattedDate)}` +
  `&holes=3` +
  `&longitude=${node.longitude}` +
  `&latitude=${node.latitude}`;

    console.log("Search URL:", searchUrl);

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(15000);

if (responses.length === 0) {
  console.log(`No API response for ${node.node_name}`);
  console.log("Current page:", page.url());
  continue;
}

const response = responses[responses.length - 1];
const json = await response.json();
    console.log("JSON top-level keys:", Object.keys(json));
console.log("JSON preview:", JSON.stringify(json).slice(0, 2000));
    let facilities = json?.ttResults?.facilities || [];

if (
  facilities.length === 0 &&
  json?.ttException?.nextAvailableFacilitySummary
) {
  facilities = [json.ttException.nextAvailableFacilitySummary];
}

    console.log(`${node.node_name}: ${facilities.length} facilities`);

    for (const f of facilities) {
      allRows.push({
        provider_course_id: String(f.id),
        course_name: f.name,
        county: f.address?.stateProvince || null,
        city: f.address?.city || null,
        latitude: f.latitude || null,
        longitude: f.longitude || null,
        number_of_tee_times: f.numberOfTeeTimes || 0,
        min_price: f.minPrice?.value || null,
        max_price: f.maxPrice?.value || null,
        average_rating: f.averageRating || null,
        review_count: f.numberOfReviews || null,
        seo_friendly_name: f.seoFriendlyName || null,
        discovery_latitude: Number(node.latitude),
        discovery_longitude: Number(node.longitude),
        discovery_radius: Number(node.radius || 35),
        last_seen_at: new Date().toISOString(),
      });
    }

    await supabase
      .from("golfnow_discovery_nodes")
      .update({ last_run_at: new Date().toISOString() })
      .eq("id", node.id);
  }

  await browser.close();

  const filteredRows = allRows.filter((r) => r.number_of_tee_times >= 20);

const dedupedRows = Array.from(
  new Map(
    filteredRows.map((row) => [row.provider_course_id, row])
  ).values()
);

if (dedupedRows.length) {
  const { error: upsertError } = await supabase
    .from("golfnow_discovered_facilities")
    .upsert(dedupedRows, { onConflict: "provider_course_id" });

  if (upsertError) throw upsertError;
}

 console.log(`Saved ${dedupedRows.length} discovered facilities`);

  await measurement.emit("scraper.completed", {
    duration_ms: measurement.durationMs(),
    new_slots: 0,
    updated_slots: 0,
    expired_slots: 0,
    facilities_discovered: dedupedRows.length,
  });

console.table(
  dedupedRows
    .sort((a, b) => b.number_of_tee_times - a.number_of_tee_times)
    .slice(0, 25)
    .map((r) => ({
      id: r.provider_course_id,
      course: r.course_name,
      county: r.county,
      tee_times: r.number_of_tee_times,
    }))
);
}

main().catch(async (err) => {
  await measurement.emit("scraper.failed", {
    failure_stage: "facility_discovery",
    error_class: err instanceof Error ? err.name : "UnknownError",
    duration_ms: measurement.durationMs(),
  });
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
