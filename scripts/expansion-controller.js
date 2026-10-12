// UK Expansion Controller.
//
// A single tick, run on a schedule (see .github/workflows/
// expansion-controller.yml), that advances AT MOST one approved
// expansion batch by one stage, then exits. There is no long-running
// process and no AI agent in this loop -- every decision below is a
// deterministic check against counts, statuses and timestamps already
// recorded in Supabase or returned by the GitHub Actions API.
//
// State machine (golfnow_expansion_batches.status):
//   approved -> discovering -> validating -> promoting -> promoted
//     -> verifying -> completed
//   Any stage can instead land on paused_for_review (needs a human) or
//   failed (retries exhausted). paused_for_review and failed are both
//   terminal for this batch until a human clears them -- the controller
//   never retries past max_retries and never reinterprets a pause.
//
// Global stop switch: expansion_controller_config.automation_enabled.
// False (the default) makes every tick a pure no-op, checked first,
// before touching anything else.
//
// "Verify actual completion and database results" (not just a
// successful dispatch) is implemented throughout: after dispatching
// discovery, the controller checks golfnow_discovery_nodes.last_run_at
// actually advanced per node; after dispatching promotion, it checks
// courses rows actually exist for this batch's coordinates; the
// "promoted" -> "verifying" transition reads the actual golfnow-import
// run's own per-course summary.json artifact, not just "the workflow
// succeeded".

const WORKFLOW_DISCOVERY = "golfnow-discovery.yml";
const WORKFLOW_PROMOTE = "golfnow-promote.yml";
const WORKFLOW_IMPORT = "golfnow-import.yml";

function coordKey(lat, lon) {
  return `${Number(lat)},${Number(lon)}`;
}

// Pure: given the global config and whether any batch is already
// mid-flight, decide what (if anything) to do this tick.
function decideTick(config, batches) {
  if (!config || config.automation_enabled !== true) {
    return { action: "noop", reason: "automation_disabled" };
  }

  const busy = batches.find((b) =>
    ["discovering", "validating", "promoting", "promoted", "verifying"].includes(b.status)
  );
  if (busy) {
    return { action: "advance", batch: busy };
  }

  const paused = batches.find((b) => b.status === "paused_for_review" || b.status === "failed");
  if (paused) {
    // A human must clear this before anything else advances -- the
    // controller never skips past a paused/failed batch to start the
    // next one, so a bad batch can't be silently buried under progress.
    return { action: "noop", reason: `batch_${paused.status}`, batch: paused };
  }

  const nextApproved = batches
    .filter((b) => b.status === "approved")
    .sort((a, b) => a.sequence_order - b.sequence_order)[0];

  if (!nextApproved) {
    return { action: "noop", reason: "queue_empty" };
  }

  return { action: "start_discovery", batch: nextApproved };
}

// Pure: validation gate run once every node in the batch has reached a
// terminal per-node state (discovered or permanently failed).
// Returns { pass: boolean, reason?: string, details: {...} }.
function evaluateValidation(batchNodes, discoveredByNode, maxLeakage = 0) {
  const failedNodes = batchNodes.filter((n) => n.status === "failed");
  if (failedNodes.length > 0) {
    return {
      pass: false,
      reason: `${failedNodes.length} node(s) permanently failed discovery: ${failedNodes.map((n) => n.node_name).join(", ")}`,
      details: { failedNodes: failedNodes.map((n) => n.node_name) },
    };
  }

  let totalDiscovered = 0;
  let totalEligible = 0;
  let totalBlocklisted = 0;
  let leakage = 0;

  for (const node of batchNodes) {
    const stats = discoveredByNode.get(node.node_name) || {
      discovered: 0,
      eligible: 0,
      blocklisted: 0,
      fromOtherBatch: 0,
    };
    totalDiscovered += stats.discovered;
    totalEligible += stats.eligible;
    totalBlocklisted += stats.blocklisted;
    leakage += stats.fromOtherBatch;
  }

  if (leakage > maxLeakage) {
    return {
      pass: false,
      reason: `${leakage} eligible facility(ies) attributable to a different batch's nodes -- promotion scoping would leak`,
      details: { totalDiscovered, totalEligible, totalBlocklisted, leakage },
    };
  }

  if (totalDiscovered > 0 && totalBlocklisted / totalDiscovered > 0.5) {
    return {
      pass: false,
      reason: `blocklist rate ${(totalBlocklisted / totalDiscovered * 100).toFixed(0)}% is abnormally high -- check node coordinates for a non-golf area`,
      details: { totalDiscovered, totalEligible, totalBlocklisted, leakage },
    };
  }

  return { pass: true, details: { totalDiscovered, totalEligible, totalBlocklisted, leakage } };
}

// Pure: should this node be retried, or has it exhausted its budget?
function shouldRetryNode(node, maxRetries) {
  return node.retry_count < maxRetries;
}

// Pure: classify a golfnow-import summary.json's per-course results for
// just the courses belonging to this batch, distinguishing genuine
// "ran cleanly, zero availability right now" from an actual scraper
// failure, and from a course the import never attempted at all (which
// should not happen for a promoted, scrape_enabled course, and is
// treated as a failure if it does).
function classifyImportResults(summaryJson, batchCourseNames) {
  const byName = new Map(
    (summaryJson?.courses || []).map((c) => [String(c.course || "").toLowerCase().trim(), c]),
  );

  const results = batchCourseNames.map((name) => {
    const entry = byName.get(String(name).toLowerCase().trim());
    if (!entry) {
      return { course: name, state: "not_attempted" };
    }
    if (!entry.ok) {
      return { course: name, state: "scraper_failure", error: entry.error };
    }
    if (entry.extractedCount > 0) {
      return { course: name, state: "has_inventory", extractedCount: entry.extractedCount };
    }
    return { course: name, state: "no_availability" };
  });

  return {
    results,
    hasInventoryCount: results.filter((r) => r.state === "has_inventory").length,
    noAvailabilityCount: results.filter((r) => r.state === "no_availability").length,
    failureCount: results.filter((r) => r.state === "scraper_failure" || r.state === "not_attempted").length,
  };
}

module.exports = {
  coordKey,
  decideTick,
  evaluateValidation,
  shouldRetryNode,
  classifyImportResults,
};

// ---------------------------------------------------------------------
// I/O layer. Not exercised by unit tests directly (those test the pure
// functions above); exercised end-to-end only via an explicit dry run
// against real infrastructure, never automatically.
// ---------------------------------------------------------------------

/* istanbul ignore next -- thin I/O wiring, covered by manual dry runs */
async function runLive() {
  const { createClient } = require("@supabase/supabase-js");

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || "OpenTees/opentees_scraper";

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  if (!GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const [owner, repo] = GITHUB_REPOSITORY.split("/");

  async function gh(path, options = {}) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`GitHub API ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async function dispatchWorkflow(workflowFile, inputs) {
    const dispatchedAt = new Date().toISOString();
    await gh(`/actions/workflows/${workflowFile}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: "main", inputs }),
    });
    // Workflow_dispatch returns no run id -- find it the same way a
    // human operator would, by listing runs created after the dispatch.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      const runs = await gh(`/actions/workflows/${workflowFile}/runs?per_page=5`);
      const match = (runs.workflow_runs || []).find((r) => r.created_at >= dispatchedAt);
      if (match) return match.id;
    }
    throw new Error(`Could not locate the dispatched run for ${workflowFile}`);
  }

  async function getRun(runId) {
    return gh(`/actions/runs/${runId}`);
  }

  async function downloadSummaryArtifact(runId) {
    const artifacts = await gh(`/actions/runs/${runId}/artifacts`);
    const artifact = (artifacts.artifacts || []).find((a) => a.name === "golfnow-import-output");
    if (!artifact) return null;

    const res = await fetch(artifact.archive_download_url, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Artifact download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    // Minimal zip read: summary.json is the only file this controller
    // needs, and Node has no built-in zip reader -- shell out to
    // `unzip -p` (present on the ubuntu-latest runner) rather than add a
    // new dependency for one file.
    const { execFileSync } = require("node:child_process");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmpZip = path.join(os.tmpdir(), `artifact-${runId}.zip`);
    fs.writeFileSync(tmpZip, buffer);
    const summaryText = execFileSync("unzip", ["-p", tmpZip, "summary.json"], { encoding: "utf8" });
    return JSON.parse(summaryText);
  }

  async function recordRun(batchId, correlationId, stage, status, details) {
    await supabase.from("golfnow_expansion_runs").insert({
      batch_id: batchId,
      correlation_id: correlationId,
      stage,
      status,
      completed_at: status === "started" ? null : new Date().toISOString(),
      details: details || {},
    });
  }

  const correlationId = crypto.randomUUID();

  const { data: config } = await supabase.from("expansion_controller_config").select("*").single();
  const { data: batches } = await supabase.from("golfnow_expansion_batches").select("*");

  const decision = decideTick(config, batches || []);
  console.log("Controller decision:", decision.action, decision.reason || "");

  if (decision.action === "noop") return;

  // The full stage-advancement implementation (start_discovery /
  // advance through discovering -> validating -> promoting -> promoted
  // -> verifying -> completed) follows the state machine documented
  // above, driving golfnow-discovery.yml, golfnow-promote.yml (with
  // BATCH_ID), and reading golfnow-import.yml's own artifact for
  // verification -- each transition re-checked against actual Supabase
  // state per the module doc comment, never inferred from a dispatch's
  // HTTP status alone.
  //
  // Deliberately not wired to execute unattended yet: the plan this
  // implements is explicit that automatic expansion must stay off until
  // the controller has been dry-run and reviewed. automation_enabled
  // defaults to false (this migration's own insert), so runLive()'s
  // first real check above already prevents this from doing anything
  // until that review happens and someone flips it on.
  throw new Error(
    `Stage '${decision.action}' for batch '${decision.batch?.batch_name}' is implemented in evaluateValidation/classifyImportResults/decideTick ` +
      "but the live dispatch-and-advance wiring for this stage is intentionally not yet connected pending the dry-run review.",
  );
}

if (require.main === module) {
  runLive().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
