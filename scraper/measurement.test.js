const assert = require("node:assert/strict");
const test = require("node:test");

const { createScraperMeasurement } = require("./measurement");

test("emits canonical scraper context and correlation", { concurrency: false }, async () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  let request;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.MEASUREMENT_INGEST_SECRET = "test-secret";
  process.env.MEASUREMENT_ENVIRONMENT = "test";
  process.env.GITHUB_RUN_ID = "123";
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 201 };
  };

  try {
    const measurement = createScraperMeasurement({
      sourceName: "github-actions-test",
      provider: "test-provider",
    });
    assert.equal(await measurement.emit("scraper.started"), true);
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.event_name, "scraper.started");
    assert.equal(payload.correlation_id, measurement.correlationId);
    assert.equal(payload.scraper_run_id, measurement.scraperRunId);
    assert.equal(payload.provider_id, "test-provider");
    assert.equal(payload.environment, "test");
    assert.equal(payload.properties.github_run_id, "123");
    assert.equal(request.options.headers["x-measurement-secret"], "test-secret");
  } finally {
    global.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("measurement failure is non-blocking", { concurrency: false }, async () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  const originalError = console.error;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.MEASUREMENT_INGEST_SECRET = "test-secret";
  global.fetch = async () => {
    throw new Error("network failure");
  };
  console.error = () => {};

  try {
    const measurement = createScraperMeasurement({
      sourceName: "github-actions-test",
      provider: "test-provider",
    });
    assert.equal(await measurement.emit("scraper.failed"), false);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    process.env = originalEnv;
  }
});
