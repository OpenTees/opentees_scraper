const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MIN_TEE_TIMES = Number(process.env.MIN_TEE_TIMES || 50);

// Optional: the UK Expansion Controller sets this to scope promotion to
// exactly one approved batch's nodes. Unset (every existing scheduled/
// manual invocation, forever) means "promote from the whole table",
// completely unchanged from before this file was patched.
const BATCH_ID = process.env.BATCH_ID || null;

// Statuses where a controller-managed batch has cleared its own
// validation/pause gate and may be promoted -- by the controller's own
// scoped call (BATCH_ID set) or, from this point on, by the ordinary
// unscoped cron too. Any OTHER status (approved/discovering/validating/
// paused_for_review/failed) means the controller has not yet signed off,
// so that batch's discovered facilities are excluded from an UNSCOPED
// promotion run regardless of who triggers it -- this is what stops the
// existing scheduled workflow from bypassing the controller's approval
// boundary. A controller-scoped run (BATCH_ID set) only ever touches its
// own batch's nodes in the first place, so this exclusion never blocks
// the controller from promoting the batch it is actively processing.
const CLEARED_STATUSES = ["promoting", "promoted", "completed"];

const blockedNameTerms = [
  "sim room",
  "simulator",
  "trackman",
  "driving range",
  "range",
  "studio",
];

function buildTargetUrl(row) {
  return `https://www.golfnow.co.uk/tee-times/facility/${row.provider_course_id}-${row.seo_friendly_name}/search`;
}

function isBlocked(row) {
  const name = String(row.course_name || "").toLowerCase();
  return blockedNameTerms.some((term) => name.includes(term));
}

function coordKey(lat, lon) {
  return `${Number(lat)},${Number(lon)}`;
}

// Loads every controller-managed discovery node (batch_id not null)
// together with its batch's current status. Legacy/manual nodes
// (batch_id null -- every node that existed before the controller, plus
// anything added by hand in future) are entirely unaffected: they were
// never in this set and this function's result never excludes them.
async function loadControllerNodeCoordinates() {
  const { data, error } = await supabase
    .from("golfnow_discovery_nodes")
    .select("latitude, longitude, batch_id, golfnow_expansion_batches(status)")
    .not("batch_id", "is", null);

  if (error) throw error;

  const inFlight = new Set(); // not yet cleared -- exclude from unscoped runs
  const batchCoords = new Map(); // batch_id -> Set(coordKey) -- for BATCH_ID scoping

  for (const row of data || []) {
    const key = coordKey(row.latitude, row.longitude);
    const status = row.golfnow_expansion_batches?.status;

    if (!batchCoords.has(row.batch_id)) batchCoords.set(row.batch_id, new Set());
    batchCoords.get(row.batch_id).add(key);

    if (!CLEARED_STATUSES.includes(status)) {
      inFlight.add(key);
    }
  }

  return { inFlight, batchCoords };
}

async function main() {
  console.log(
    `Promoting GolfNow courses with ${MIN_TEE_TIMES}+ tee times` +
      (BATCH_ID ? ` (scoped to batch ${BATCH_ID})` : ""),
  );

  const { inFlight, batchCoords } = await loadControllerNodeCoordinates();

  const { data: discovered, error: discoveredError } = await supabase
    .from("golfnow_discovered_facilities")
    .select("*")
    .gte("number_of_tee_times", MIN_TEE_TIMES)
    .not("provider_course_id", "is", null)
    .not("seo_friendly_name", "is", null)
    .not("county", "is", null)
    .order("number_of_tee_times", { ascending: false });

  if (discoveredError) throw discoveredError;

  let scoped = discovered || [];

  if (BATCH_ID) {
    // Explicit batch scoping: only this batch's own node coordinates,
    // regardless of what else is sitting in the discovered-facilities
    // table. This is what makes the controller's own promotion call
    // unable to accidentally promote an unrelated discovered facility --
    // the exact leakage found and reported during Phase 1.
    const allowed = batchCoords.get(BATCH_ID) || new Set();
    scoped = scoped.filter((row) => allowed.has(coordKey(row.discovery_latitude, row.discovery_longitude)));
  } else {
    // Unscoped (every existing scheduled/manual call): behaviour is
    // identical to before this patch, EXCEPT a discovered facility whose
    // node belongs to a controller batch that has not yet cleared
    // validation is excluded -- it is not this run's place to promote
    // something the controller is still reviewing.
    scoped = scoped.filter((row) => !inFlight.has(coordKey(row.discovery_latitude, row.discovery_longitude)));
  }

  const { data: existing, error: existingError } = await supabase
  .from("courses")
  .select("course_name, provider_course_id")
  .not("course_name", "is", null);

  if (existingError) throw existingError;

  const existingIds = new Set(
  (existing || [])
    .map((r) => r.provider_course_id)
    .filter(Boolean)
    .map(String)
);

const existingNames = new Set(
  (existing || [])
    .map((r) => String(r.course_name || "").toLowerCase().trim())
    .filter(Boolean)
);

  const eligible = scoped.filter((row) => {
    const providerCourseId = String(row.provider_course_id || "");

    if (!providerCourseId) return false;
    if (existingIds.has(providerCourseId)) return false;
    const courseName = String(row.course_name || "").toLowerCase().trim();

if (existingNames.has(courseName)) return false;
    if (isBlocked(row)) return false;

    return true;
  });

  const rows = eligible.map((row) => ({
    course_name: row.course_name,
    county: row.county,
    provider: "golfnow",
    provider_course_id: String(row.provider_course_id),
    target_url: buildTargetUrl(row),
    course_slug: row.seo_friendly_name,
    enabled: true,
    scrape_enabled: true,
    google_rating: row.average_rating,
    google_reviews: row.review_count,
  }));

  if (!rows.length) {
    console.log("No new eligible courses to promote");
    return;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("courses")
    .insert(rows)
    .select("course_name, county, provider_course_id");

  if (insertError) throw insertError;

  console.log(`New courses promoted: ${inserted?.length || 0}`);

  console.table(
    (inserted || []).slice(0, 30).map((r) => ({
      course: r.course_name,
      county: r.county,
      id: r.provider_course_id,
    }))
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { coordKey, isBlocked, buildTargetUrl, CLEARED_STATUSES };
