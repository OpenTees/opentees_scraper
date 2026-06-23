const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MIN_TEE_TIMES = Number(process.env.MIN_TEE_TIMES || 50);

function buildTargetUrl(row) {
  return `https://www.golfnow.co.uk/tee-times/facility/${row.provider_course_id}-${row.seo_friendly_name}/search`;
}

async function main() {
  console.log(`Promoting GolfNow courses with ${MIN_TEE_TIMES}+ tee times`);

  const { data, error } = await supabase
    .from("golfnow_discovered_facilities")
    .select("*")
    .gte("number_of_tee_times", MIN_TEE_TIMES)
    .not("provider_course_id", "is", null)
    .not("seo_friendly_name", "is", null)
    .not("county", "is", null)
    .order("number_of_tee_times", { ascending: false });

  if (error) throw error;

  const rows = (data || []).map((row) => ({
    course_name: row.course_name,
    county: row.county,
    provider: "golfnow",
    provider_course_id: row.provider_course_id,
    target_url: buildTargetUrl(row),
    course_slug: row.seo_friendly_name,
    enabled: true,
    scrape_enabled: true,
    google_rating: row.average_rating,
    google_reviews: row.review_count,
  }));

  if (!rows.length) {
    console.log("No courses eligible for promotion");
    return;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("courses")
    .upsert(rows, {
      onConflict: "course_name",
      ignoreDuplicates: true,
    })
    .select("course_name, county, provider_course_id");

  if (insertError) throw insertError;

  console.log(`Eligible discovered courses: ${rows.length}`);
  console.log(`Promotion attempted. New rows may be fewer due to existing courses.`);

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
