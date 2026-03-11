const payload = {
  source_key: "manual_import",
  rows: [
    {
      external_id: "github-test-001",
      provider_course_id: "github-test",
      course_name: "Cottesmore Golf & Country Club",
      slot_date: "2026-03-12",
      slot_time: "09:40",
      price: 39,
      players: 4,
      booking_url: "https://www.golfnow.co.uk",
      raw_payload: {
        source: "github_test"
      }
    }
  ]
};

async function run() {
  const importSecret = process.env.MANUAL_IMPORT_SECRET;

  if (!importSecret) {
    throw new Error("Missing MANUAL_IMPORT_SECRET");
  }

  const response = await fetch(
    "https://edkpdujmnwbiwowfwvpr.supabase.co/functions/v1/ingest-tee-times",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-import-secret": importSecret
      },
      body: JSON.stringify(payload)
    }
  );

  const text = await response.text();

  console.log("Status:", response.status);
  console.log("Response:", text);

  if (!response.ok) {
    throw new Error(`Import failed: ${response.status} ${text}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
