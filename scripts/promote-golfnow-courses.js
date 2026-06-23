const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MIN_TEE_TIMES = Number(process.env.MIN_TEE_TIMES || 50);

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

async function main() {
  console.log(`Promoting GolfNow courses with ${MIN_TEE_TIMES}+ tee times`);

  const { data: discovered, error: discoveredError } = await supabase
    .from("golfnow_discovered_facilities")
    .select("*")
    .gte("number_of_tee_times", MIN_TEE_TIMES)
    .not("provider_course_id", "is", null)
    .not("seo_friendly_name", "is", null)
    .not("county", "is", null)
    .order("number_of_tee_times", { ascending: false });

  if (discoveredError) throw discoveredError;

  const { data: existing, error: existingError } = await supabase
    .from("courses")
    .select("provider_course_id")
    .eq("provider", "golfnow")
    .not("provider_course_id", "is", null);

  if (existingError) throw existingError;

  const existingIds = new Set((existing || []).map((r) => String(r.provider_course_id)));

  const eligible = (discovered || []).filter((row) => {
    const providerCourseId = String(row.provider_course_id || "");

    if (!providerCourseId) return false;
    if (existingIds.has(providerCourseId)) return false;
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
