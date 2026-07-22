const { randomUUID } = require("crypto");

function environment() {
  const value = process.env.MEASUREMENT_ENVIRONMENT;
  return ["production", "staging", "development", "test"].includes(value)
    ? value
    : "production";
}

function createScraperMeasurement({ sourceName, provider }) {
  const correlationId = randomUUID();
  const scraperRunId = randomUUID();
  const startedAt = Date.now();

  async function emit(eventName, properties = {}) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const secret = process.env.MEASUREMENT_INGEST_SECRET;
    if (!supabaseUrl || !secret) {
      console.error(
        `Measurement event failed: ${eventName} (configuration_unavailable)`,
      );
      return false;
    }

    const payload = {
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      event_name: eventName,
      event_version: 1,
      schema_version: 1,
      environment: environment(),
      actor_type: "system",
      correlation_id: correlationId,
      source_type: "scraper",
      source_name: sourceName,
      provider_id: provider,
      scraper_run_id: scraperRunId,
      properties: {
        provider,
        execution_platform: "github_actions",
        github_run_id: process.env.GITHUB_RUN_ID || null,
        github_run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
        ...properties,
      },
    };

    try {
      const response = await fetch(
        `${supabaseUrl}/functions/v1/ingest-measurement-event`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-measurement-secret": secret,
          },
          signal: AbortSignal.timeout(1500),
          body: JSON.stringify(payload),
        },
      );
      if (response.ok || response.status === 409) return true;
      console.error(
        `Measurement event failed: ${eventName} (http_${response.status})`,
      );
    } catch {
      console.error(`Measurement event failed: ${eventName} (request_error)`);
    }
    return false;
  }

  return {
    correlationId,
    scraperRunId,
    durationMs: () => Date.now() - startedAt,
    emit,
  };
}

module.exports = { createScraperMeasurement };
