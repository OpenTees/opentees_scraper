const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  realtime: {
    enabled: false,
  },
});
async function main() {
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

    const url =
      `https://www.golfnow.co.uk/tee-times/search#qc=GeoLocation` +
      `&location=${encodeURIComponent(node.node_name)}` +
      `&facilitytype=0` +
      `&sortby=Facilities.Distance.0` +
      `&view=Course` +
      `&holes=3` +
      `&radius=${node.radius || 35}` +
      `&timemax=42` +
      `&timemin=10` +
      `&players=0` +
      `&pricemax=10000` +
      `&pricemin=0` +
      `&longitude=${node.longitude}` +
      `&latitude=${node.latitude}`;

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(15000);

if (responses.length === 0) {
  console.log(`No API response for ${node.node_name}`);
  console.log("Current page:", page.url());
  continue;
}

const response = responses[responses.length - 1];
const json = await response.json();
    const facilities = json?.ttResults?.facilities || [];

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

  if (filteredRows.length) {
    const { error: upsertError } = await supabase
      .from("golfnow_discovered_facilities")
      .upsert(filteredRows, { onConflict: "provider_course_id" });

    if (upsertError) throw upsertError;
  }

  console.log(`Saved ${filteredRows.length} discovered facilities`);
  console.table(
    filteredRows
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
