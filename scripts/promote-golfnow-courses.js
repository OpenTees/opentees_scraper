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
// manual invocation, forever) means "promote from the whole table,
// excluding everything controller-managed" -- see the strict isolation
// rule below, not merely the previous "unchanged" behaviour.
const BATCH_ID = process.env.BATCH_ID || null;

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

// Loads every controller-managed discovery node (batch_id not null),
// keyed by node id -- never by coordinate (two different approved
// batches, or a controller batch and a legacy manual node, could in
// principle share exact coordinates, which coordinate matching could
// not tell apart). Legacy/manual nodes (batch_id null -- every node
// that existed before the controller, plus anything added by hand in
// future) are entirely unaffected: they were never in this set.
//
// Strict isolation (per the approved spec): ANY controller-managed node,
// regardless of its batch's current status -- including "completed" --
// permanently removes a facility from the unscoped promotion path. Only
// a BATCH_ID-scoped call may ever promote a controller-managed facility.
// There is deliberately no "cleared, so the unscoped cron may now also
// promote it" exception: that would reopen exactly the bypass this rule
// exists to close.
async function loadControllerNodeOwnership(client) {
  const { data, error } = await client
    .from("golfnow_discovery_nodes")
    .select("id, batch_id")
    .not("batch_id", "is", null);

  if (error) throw error;

  const allControllerNodeIds = new Set(); // ANY controller node, any status -- permanently excluded from unscoped
  const batchNodeIds = new Map(); // batch_id -> Set(discovery_node_id) -- for BATCH_ID scoping

  for (const row of data || []) {
    allControllerNodeIds.add(row.id);
    if (!batchNodeIds.has(row.batch_id)) batchNodeIds.set(row.batch_id, new Set());
    batchNodeIds.get(row.batch_id).add(row.id);
  }

  return { allControllerNodeIds, batchNodeIds };
}

// Durable ownership (see golfnow_facility_discovery_events migration):
// which node(s) have EVER discovered each provider_course_id, append-
// only and never overwritten by a later discovery from a different
// node. This, not golfnow_discovered_facilities.discovery_node_id (a
// mutable "last node to touch this row" pointer), is what promotion
// scoping reads ownership from.
async function loadFacilityOwnership(client, providerCourseIds) {
  const ownerNodesByProviderCourseId = new Map();
  if (providerCourseIds.length === 0) return ownerNodesByProviderCourseId;

  const { data, error } = await client
    .from("golfnow_facility_discovery_events")
    .select("provider_course_id, discovery_node_id")
    .in("provider_course_id", providerCourseIds);

  if (error) throw error;

  for (const row of data || []) {
    if (!ownerNodesByProviderCourseId.has(row.provider_course_id)) {
      ownerNodesByProviderCourseId.set(row.provider_course_id, new Set());
    }
    ownerNodesByProviderCourseId.get(row.provider_course_id).add(row.discovery_node_id);
  }

  return ownerNodesByProviderCourseId;
}

function setsIntersect(a, b) {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

// The real execution path, from a read client through to the final
// eligible-rows-to-insert list -- everything except the insert itself.
// Takes an injectable client so this exact function (not a
// reimplementation) is what both main() and the test suite exercise.
async function computeEligibleFacilities(client, { minTeeTimes, batchId }) {
  const { allControllerNodeIds, batchNodeIds } = await loadControllerNodeOwnership(client);

  const { data: discovered, error: discoveredError } = await client
    .from("golfnow_discovered_facilities")
    .select("*")
    .gte("number_of_tee_times", minTeeTimes)
    .not("provider_course_id", "is", null)
    .not("seo_friendly_name", "is", null)
    .not("county", "is", null)
    .order("number_of_tee_times", { ascending: false });

  if (discoveredError) throw discoveredError;

  const ownerNodesByProviderCourseId = await loadFacilityOwnership(
    client,
    (discovered || []).map((row) => row.provider_course_id),
  );

  let scoped = discovered || [];

  if (batchId) {
    // Explicit batch scoping: only facilities with a durable discovery
    // event from a node belonging to THIS batch (never coordinates, and
    // never the mutable discovery_node_id column -- see
    // golfnow_facility_discovery_events). This is what makes the
    // controller's own promotion call unable to accidentally promote an
    // unrelated discovered facility -- the exact leakage found and
    // reported during Phase 1.
    const allowed = batchNodeIds.get(batchId) || new Set();
    scoped = scoped.filter((row) => {
      const owners = ownerNodesByProviderCourseId.get(row.provider_course_id);
      return owners != null && setsIntersect(owners, allowed);
    });
  } else {
    // Unscoped (every existing scheduled/manual call): strict,
    // permanent isolation. A facility with a durable discovery event
    // from ANY controller-managed node -- regardless of that node's
    // batch status, including "completed" -- is excluded here, full
    // stop. Only a BATCH_ID-scoped call may ever promote it. A facility
    // never discovered by a controller node (every pre-existing row,
    // and anything only ever discovered by a legacy/manual node) is
    // never excluded here, exactly as before this feature existed.
    scoped = scoped.filter((row) => {
      const owners = ownerNodesByProviderCourseId.get(row.provider_course_id);
      return owners == null || !setsIntersect(owners, allControllerNodeIds);
    });
  }

  const { data: existing, error: existingError } = await client
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

  return scoped.filter((row) => {
    const providerCourseId = String(row.provider_course_id || "");

    if (!providerCourseId) return false;
    if (existingIds.has(providerCourseId)) return false;
    const courseName = String(row.course_name || "").toLowerCase().trim();

if (existingNames.has(courseName)) return false;
    if (isBlocked(row)) return false;

    return true;
  });
}

async function main() {
  console.log(
    `Promoting GolfNow courses with ${MIN_TEE_TIMES}+ tee times` +
      (BATCH_ID ? ` (scoped to batch ${BATCH_ID})` : ""),
  );

  const eligible = await computeEligibleFacilities(supabase, { minTeeTimes: MIN_TEE_TIMES, batchId: BATCH_ID });

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

module.exports = {
  isBlocked,
  buildTargetUrl,
  setsIntersect,
  loadControllerNodeOwnership,
  loadFacilityOwnership,
  computeEligibleFacilities,
};
