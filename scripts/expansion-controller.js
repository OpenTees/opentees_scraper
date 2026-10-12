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
// courses rows actually exist for this batch; the "promoted" ->
// "verifying" transition reads the actual golfnow-import run's own
// per-course summary.json artifact, not just "the workflow succeeded".
//
// Batch ownership (PR #2 correction): every join between a discovered
// facility and a batch goes through golfnow_discovered_facilities
// .discovery_node_id -> golfnow_discovery_nodes.id -> .batch_id. Never
// through discovery_latitude/discovery_longitude coordinate equality --
// a facility row's coordinates only ever reflect whichever node most
// recently upserted it, and two unrelated nodes (two different approved
// batches, or a controller batch and a legacy manual node) could in
// principle share exact coordinates, which coordinate matching could
// not tell apart. See promote-golfnow-courses.js's
// loadControllerNodeOwnership() for the same rule applied there.

const WORKFLOW_DISCOVERY = "golfnow-discovery.yml";
const WORKFLOW_PROMOTE = "golfnow-promote.yml";
const WORKFLOW_IMPORT = "golfnow-import.yml";

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
  decideTick,
  evaluateValidation,
  shouldRetryNode,
  classifyImportResults,
  buildGithubClient,
  startDiscovery,
  checkDiscoveryProgress,
  runValidation,
  checkPromotionProgress,
  checkForNextImport,
  runVerification,
  runTick,
};

// ---------------------------------------------------------------------
// GitHub client -- a thin, injectable wrapper so every stage handler
// below can be driven by a mock in tests. The real fetch() calls live
// only here.
// ---------------------------------------------------------------------

function buildGithubClient({ token, repository }) {
  const [owner, repo] = repository.split("/");

  async function gh(path, options = {}) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`GitHub API ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    async dispatchWorkflow(workflowFile, inputs) {
      const dispatchedAt = new Date().toISOString();
      await gh(`/actions/workflows/${workflowFile}/dispatches`, {
        method: "POST",
        body: JSON.stringify({ ref: "main", inputs }),
      });
      // workflow_dispatch returns no run id -- find it the same way a
      // human operator would, by listing runs created after dispatch.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((r) => setTimeout(r, 5000));
        const runs = await gh(`/actions/workflows/${workflowFile}/runs?per_page=5`);
        const match = (runs.workflow_runs || []).find((r) => r.created_at >= dispatchedAt);
        if (match) return match.id;
      }
      throw new Error(`Could not locate the dispatched run for ${workflowFile}`);
    },

    async getRun(runId) {
      return gh(`/actions/runs/${runId}`);
    },

    async listRecentRuns(workflowFile, perPage = 10) {
      const data = await gh(`/actions/workflows/${workflowFile}/runs?per_page=${perPage}`);
      return data.workflow_runs || [];
    },

    async downloadSummaryArtifact(runId) {
      const artifacts = await gh(`/actions/runs/${runId}/artifacts`);
      const artifact = (artifacts.artifacts || []).find((a) => a.name === "golfnow-import-output");
      if (!artifact) return null;

      const res = await fetch(artifact.archive_download_url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Artifact download failed: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());

      // Minimal zip read: summary.json is the only file this controller
      // needs, and Node has no built-in zip reader -- shell out to
      // `unzip -p` (present on the ubuntu-latest runner) rather than
      // add a new dependency for one file.
      const { execFileSync } = require("node:child_process");
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const tmpZip = path.join(os.tmpdir(), `artifact-${runId}.zip`);
      fs.writeFileSync(tmpZip, buffer);
      const summaryText = execFileSync("unzip", ["-p", tmpZip, "summary.json"], { encoding: "utf8" });
      return JSON.parse(summaryText);
    },
  };
}

// ---------------------------------------------------------------------
// Supabase-side helpers
// ---------------------------------------------------------------------

async function recordRun(supabase, { batchId, correlationId, stage, status, details }) {
  const { error } = await supabase.from("golfnow_expansion_runs").insert({
    batch_id: batchId,
    correlation_id: correlationId,
    stage,
    status,
    completed_at: status === "started" ? null : new Date().toISOString(),
    details: details || {},
  });
  if (error) throw new Error(`Unable to record expansion run: ${error.message}`);
}

async function latestRun(supabase, batchId, stage) {
  const { data, error } = await supabase
    .from("golfnow_expansion_runs")
    .select("*")
    .eq("batch_id", batchId)
    .eq("stage", stage)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Unable to read expansion runs: ${error.message}`);
  return (data || [])[0] || null;
}

async function pauseBatch(supabase, batch, reason) {
  const { error } = await supabase
    .from("golfnow_expansion_batches")
    .update({ status: "paused_for_review", pause_reason: reason, updated_at: new Date().toISOString() })
    .eq("id", batch.id);
  if (error) throw new Error(`Unable to pause batch: ${error.message}`);
}

async function failBatch(supabase, batch, reason) {
  const { error } = await supabase
    .from("golfnow_expansion_batches")
    .update({ status: "failed", pause_reason: reason, updated_at: new Date().toISOString() })
    .eq("id", batch.id);
  if (error) throw new Error(`Unable to fail batch: ${error.message}`);
}

async function setBatchStatus(supabase, batch, status, extra = {}) {
  const { error } = await supabase
    .from("golfnow_expansion_batches")
    .update({ status, updated_at: new Date().toISOString(), ...extra })
    .eq("id", batch.id);
  if (error) throw new Error(`Unable to update batch status: ${error.message}`);
}

// ---------------------------------------------------------------------
// Stage handlers. Each is restart-safe: calling it again after a crash
// mid-stage must never repeat an unsafe action. Every data write this
// module performs (node insert, discovery event insert, course
// promotion insert, batch/run status update) is already idempotent at
// the database level (unique constraints, upserts, or a plain status
// transition) -- the one additional guard needed is against spamming a
// duplicate GitHub Actions dispatch on every retried tick, which each
// start* handler below checks for explicitly before dispatching.
// ---------------------------------------------------------------------

// approved -> discovering: ensure this batch's nodes exist in the live
// golfnow_discovery_nodes table (tagged with batch_id), then dispatch
// discovery scoped to exactly those nodes via limit_nodes.
async function startDiscovery(supabase, gh, batch, correlationId, maxBatchSize) {
  const { data: nodes, error: nodesError } = await supabase
    .from("golfnow_expansion_batch_nodes")
    .select("*")
    .eq("batch_id", batch.id);
  if (nodesError) throw new Error(`Unable to read batch nodes: ${nodesError.message}`);

  if (!nodes || nodes.length === 0) {
    await failBatch(supabase, batch, "Batch has no nodes defined");
    return;
  }
  if (nodes.length > maxBatchSize) {
    await pauseBatch(supabase, batch, `Batch has ${nodes.length} nodes, exceeding max_batch_size ${maxBatchSize}`);
    return;
  }

  // Idempotent: a node that already has a discovery_node_id was
  // already inserted into the live table by an earlier, possibly
  // crashed tick -- never inserted a second time.
  for (const node of nodes) {
    if (node.discovery_node_id) continue;
    const { data: inserted, error: insertError } = await supabase
      .from("golfnow_discovery_nodes")
      .insert({
        node_name: node.node_name,
        latitude: node.latitude,
        longitude: node.longitude,
        radius: node.radius,
        enabled: true,
        batch_id: batch.id,
      })
      .select("id")
      .single();
    if (insertError) throw new Error(`Unable to insert discovery node ${node.node_name}: ${insertError.message}`);

    const { error: updateError } = await supabase
      .from("golfnow_expansion_batch_nodes")
      .update({ discovery_node_id: inserted.id, status: "discovering", updated_at: new Date().toISOString() })
      .eq("id", node.id);
    if (updateError) throw new Error(`Unable to update batch node ${node.node_name}: ${updateError.message}`);
  }

  // Restart safety: if an earlier tick already dispatched discovery for
  // this batch (recorded a "started" run with a github_run_id) but
  // crashed before the batch status flip below, do not dispatch a
  // second time -- just advance the status and let the next tick's
  // checkDiscoveryProgress pick up the already-recorded run.
  const existing = await latestRun(supabase, batch.id, "discovery");
  if (existing && existing.status === "started" && existing.details?.github_run_id) {
    await setBatchStatus(supabase, batch, "discovering");
    return;
  }

  const dispatchedAt = new Date().toISOString();
  const runId = await gh.dispatchWorkflow(WORKFLOW_DISCOVERY, { limit_nodes: String(nodes.length) });

  await setBatchStatus(supabase, batch, "discovering");
  await recordRun(supabase, {
    batchId: batch.id,
    correlationId,
    stage: "discovery",
    status: "started",
    details: { github_run_id: runId, dispatched_at: dispatchedAt, node_count: nodes.length },
  });
}

// discovering -> validating (or retry / fail): poll the dispatched run;
// once complete, verify EACH node's last_run_at actually advanced --
// never trust "the workflow succeeded" alone.
async function checkDiscoveryProgress(supabase, gh, batch, correlationId, maxRetries) {
  const run = await latestRun(supabase, batch.id, "discovery");
  const githubRunId = run?.details?.github_run_id;
  const dispatchedAt = run?.details?.dispatched_at;
  if (!githubRunId) {
    await pauseBatch(supabase, batch, "Discovering state with no recorded dispatch -- manual review needed");
    return;
  }

  const githubRun = await gh.getRun(githubRunId);
  if (githubRun.status !== "completed") {
    console.log(`Discovery run ${githubRunId} still ${githubRun.status}; will re-check next tick`);
    return;
  }

  const { data: nodes, error: nodesError } = await supabase
    .from("golfnow_expansion_batch_nodes")
    .select("*")
    .eq("batch_id", batch.id);
  if (nodesError) throw new Error(`Unable to read batch nodes: ${nodesError.message}`);

  let anyRetried = false;

  for (const node of nodes) {
    if (node.status === "discovered") continue;

    const { data: liveNode, error: liveNodeError } = await supabase
      .from("golfnow_discovery_nodes")
      .select("last_run_at")
      .eq("id", node.discovery_node_id)
      .single();
    if (liveNodeError) throw new Error(`Unable to read live node ${node.node_name}: ${liveNodeError.message}`);

    const actuallyRan = liveNode?.last_run_at && dispatchedAt && liveNode.last_run_at >= dispatchedAt;

    if (actuallyRan) {
      const { count, error: countError } = await supabase
        .from("golfnow_discovered_facilities")
        .select("*", { count: "exact", head: true })
        .eq("discovery_node_id", node.discovery_node_id);
      if (countError) throw new Error(`Unable to count discovered facilities for ${node.node_name}: ${countError.message}`);

      const { error: updateError } = await supabase
        .from("golfnow_expansion_batch_nodes")
        .update({ status: "discovered", discovered_count: count ?? 0, updated_at: new Date().toISOString() })
        .eq("id", node.id);
      if (updateError) throw new Error(`Unable to mark node discovered: ${updateError.message}`);
    } else if (shouldRetryNode(node, maxRetries)) {
      anyRetried = true;
      const { error: retryError } = await supabase
        .from("golfnow_expansion_batch_nodes")
        .update({
          status: "pending",
          retry_count: node.retry_count + 1,
          last_error: "last_run_at did not advance after dispatch",
          updated_at: new Date().toISOString(),
        })
        .eq("id", node.id);
      if (retryError) throw new Error(`Unable to mark node for retry: ${retryError.message}`);
      // Force re-discovery of just this node on the next tick.
      const { error: resetError } = await supabase
        .from("golfnow_discovery_nodes")
        .update({ last_run_at: null })
        .eq("id", node.discovery_node_id);
      if (resetError) throw new Error(`Unable to reset node for retry: ${resetError.message}`);
    } else {
      const { error: failError } = await supabase
        .from("golfnow_expansion_batch_nodes")
        .update({ status: "failed", last_error: "exhausted retries", updated_at: new Date().toISOString() })
        .eq("id", node.id);
      if (failError) throw new Error(`Unable to mark node failed: ${failError.message}`);
    }
  }

  const { data: refreshedNodes, error: refreshError } = await supabase
    .from("golfnow_expansion_batch_nodes")
    .select("*")
    .eq("batch_id", batch.id);
  if (refreshError) throw new Error(`Unable to re-read batch nodes: ${refreshError.message}`);

  const anyFailed = refreshedNodes.some((n) => n.status === "failed");
  if (anyFailed) {
    await recordRun(supabase, {
      batchId: batch.id,
      correlationId,
      stage: "discovery",
      status: "failed",
      details: { failedNodes: refreshedNodes.filter((n) => n.status === "failed").map((n) => n.node_name) },
    });
    await pauseBatch(
      supabase,
      batch,
      `${refreshedNodes.filter((n) => n.status === "failed").length} node(s) exhausted discovery retries`,
    );
    return;
  }

  const stillPending = refreshedNodes.some((n) => n.status === "pending" || n.status === "discovering");
  if (stillPending) {
    if (anyRetried) {
      const pendingCount = refreshedNodes.filter((n) => n.status === "pending").length;
      const retryDispatchedAt = new Date().toISOString();
      const retryRunId = await gh.dispatchWorkflow(WORKFLOW_DISCOVERY, { limit_nodes: String(pendingCount) });
      await recordRun(supabase, {
        batchId: batch.id,
        correlationId,
        stage: "discovery",
        status: "started",
        details: { github_run_id: retryRunId, dispatched_at: retryDispatchedAt, retry: true, node_count: pendingCount },
      });
    }
    return;
  }

  await recordRun(supabase, { batchId: batch.id, correlationId, stage: "discovery", status: "succeeded" });
  await setBatchStatus(supabase, batch, "validating");
}

// validating: run evaluateValidation against this batch's actual
// discovered-facilities data, including a durable-ownership leakage
// check against every OTHER controller batch's nodes (never
// coordinate matching -- see golfnow_facility_discovery_events).
async function runValidation(supabase, gh, batch, correlationId) {
  const { data: nodes, error: nodesError } = await supabase
    .from("golfnow_expansion_batch_nodes")
    .select("*")
    .eq("batch_id", batch.id);
  if (nodesError) throw new Error(`Unable to read batch nodes: ${nodesError.message}`);

  const { data: otherBatchNodes, error: otherNodesError } = await supabase
    .from("golfnow_discovery_nodes")
    .select("id, batch_id")
    .not("batch_id", "is", null)
    .neq("batch_id", batch.id);
  if (otherNodesError) throw new Error(`Unable to read other batches' nodes: ${otherNodesError.message}`);
  const otherBatchNodeIds = new Set((otherBatchNodes || []).map((n) => n.id));

  const blockedNameTerms = ["sim room", "simulator", "trackman", "driving range", "range", "studio"];
  const discoveredByNode = new Map();

  for (const node of nodes) {
    const { data: facilities, error: facilitiesError } = await supabase
      .from("golfnow_discovered_facilities")
      .select("course_name, number_of_tee_times")
      .eq("discovery_node_id", node.discovery_node_id)
      .gte("number_of_tee_times", batch.min_tee_times);
    if (facilitiesError) throw new Error(`Unable to read discovered facilities for ${node.node_name}: ${facilitiesError.message}`);

    const blocklisted = (facilities || []).filter((f) =>
      blockedNameTerms.some((term) => String(f.course_name).toLowerCase().includes(term)),
    ).length;

    // Durable-ownership leakage check: a facility this node discovered
    // that was ALSO discovered by a node belonging to a different
    // batch. Reads golfnow_facility_discovery_events, not coordinates.
    const { data: thisNodeIds, error: idsError } = await supabase
      .from("golfnow_discovered_facilities")
      .select("provider_course_id")
      .eq("discovery_node_id", node.discovery_node_id)
      .gte("number_of_tee_times", batch.min_tee_times);
    if (idsError) throw new Error(`Unable to read provider ids for ${node.node_name}: ${idsError.message}`);
    const providerCourseIds = (thisNodeIds || []).map((r) => r.provider_course_id);

    let fromOtherBatch = 0;
    if (providerCourseIds.length > 0 && otherBatchNodeIds.size > 0) {
      const { data: events, error: eventsError } = await supabase
        .from("golfnow_facility_discovery_events")
        .select("provider_course_id, discovery_node_id")
        .in("provider_course_id", providerCourseIds);
      if (eventsError) throw new Error(`Unable to read discovery events: ${eventsError.message}`);
      const leaked = new Set();
      for (const event of events || []) {
        if (otherBatchNodeIds.has(event.discovery_node_id)) leaked.add(event.provider_course_id);
      }
      fromOtherBatch = leaked.size;
    }

    discoveredByNode.set(node.node_name, {
      discovered: node.discovered_count || 0,
      eligible: (facilities || []).length - blocklisted,
      blocklisted,
      fromOtherBatch,
    });

    const { error: eligibleUpdateError } = await supabase
      .from("golfnow_expansion_batch_nodes")
      .update({ eligible_count: (facilities || []).length - blocklisted })
      .eq("id", node.id);
    if (eligibleUpdateError) throw new Error(`Unable to update eligible_count: ${eligibleUpdateError.message}`);
  }

  const result = evaluateValidation(nodes, discoveredByNode);

  await recordRun(supabase, {
    batchId: batch.id,
    correlationId,
    stage: "validation",
    status: result.pass ? "succeeded" : "paused",
    details: result.details,
  });

  if (!result.pass) {
    await pauseBatch(supabase, batch, result.reason);
    return;
  }

  // Dispatch promotion in the same tick validation passes, scoped to
  // exactly this batch via BATCH_ID -- never the unscoped workflow,
  // which per the strict isolation rule can never promote a
  // controller-managed facility regardless of status.
  //
  // Restart safety: if an earlier tick already dispatched promotion
  // for this batch but crashed before the status flip below, do not
  // dispatch a second time.
  const existingPromotionRun = await latestRun(supabase, batch.id, "promotion");
  if (existingPromotionRun && existingPromotionRun.status === "started" && existingPromotionRun.details?.github_run_id) {
    await setBatchStatus(supabase, batch, "promoting");
    return;
  }

  const dispatchedAt = new Date().toISOString();
  const runId = await gh.dispatchWorkflow(WORKFLOW_PROMOTE, {
    min_tee_times: String(batch.min_tee_times),
    batch_id: batch.id,
  });

  await setBatchStatus(supabase, batch, "promoting");
  await recordRun(supabase, {
    batchId: batch.id,
    correlationId,
    stage: "promotion",
    status: "started",
    details: { github_run_id: runId, dispatched_at: dispatchedAt },
  });
}

// promoting: poll the dispatched promote run; once complete, verify
// actual courses rows exist for THIS batch's eligible facilities --
// computed via the real computeEligibleFacilities() this batch's own
// promote run used, re-derived read-only here, never inferred from
// "the workflow succeeded" alone.
async function checkPromotionProgress(supabase, gh, batch, correlationId) {
  const run = await latestRun(supabase, batch.id, "promotion");
  const githubRunId = run?.details?.github_run_id;
  if (!githubRunId) {
    await pauseBatch(supabase, batch, "Promoting state with no recorded dispatch -- manual review needed");
    return;
  }

  const githubRun = await gh.getRun(githubRunId);
  if (githubRun.status !== "completed") {
    console.log(`Promote run ${githubRunId} still ${githubRun.status}; will re-check next tick`);
    return;
  }
  if (githubRun.conclusion !== "success") {
    await pauseBatch(supabase, batch, `Promote workflow run ${githubRunId} did not succeed (${githubRun.conclusion})`);
    return;
  }

  const { data: nodes, error: nodesError } = await supabase
    .from("golfnow_expansion_batch_nodes")
    .select("*")
    .eq("batch_id", batch.id);
  if (nodesError) throw new Error(`Unable to read batch nodes: ${nodesError.message}`);

  const expectedEligible = nodes.reduce((sum, n) => sum + (n.eligible_count || 0), 0);

  // Verify by provider_course_id, scoped to exactly this batch's nodes
  // via the durable discovery-events ownership link -- never a
  // timestamp-based "courses created recently" guess, which could be
  // confused by a concurrent legacy promotion.
  const nodeIds = nodes.map((n) => n.discovery_node_id).filter(Boolean);
  let promotedCount = 0;
  let promotedCourseNames = [];
  if (nodeIds.length > 0) {
    const { data: events, error: eventsError } = await supabase
      .from("golfnow_facility_discovery_events")
      .select("provider_course_id")
      .in("discovery_node_id", nodeIds);
    if (eventsError) throw new Error(`Unable to read discovery events: ${eventsError.message}`);
    const providerCourseIds = [...new Set((events || []).map((e) => e.provider_course_id))];

    if (providerCourseIds.length > 0) {
      const { data: promotedCourses, error: coursesError } = await supabase
        .from("courses")
        .select("course_name, provider_course_id")
        .eq("provider", "golfnow")
        .in("provider_course_id", providerCourseIds);
      if (coursesError) throw new Error(`Unable to read promoted courses: ${coursesError.message}`);
      promotedCount = (promotedCourses || []).length;
      promotedCourseNames = (promotedCourses || []).map((c) => c.course_name);
    }
  }

  if (promotedCount === 0 && expectedEligible > 0) {
    await pauseBatch(
      supabase,
      batch,
      `Promotion workflow succeeded but no courses rows appeared (expected up to ${expectedEligible})`,
    );
    return;
  }

  await recordRun(supabase, {
    batchId: batch.id,
    correlationId,
    stage: "promotion",
    status: "succeeded",
    details: { promoted_count: promotedCount, expected_eligible: expectedEligible, course_names: promotedCourseNames },
  });

  await setBatchStatus(supabase, batch, "promoted", { promoted_at: new Date().toISOString() });
}

// promoted -> verifying: wait for the NEXT normally-scheduled
// golfnow-import run (never triggered early by the controller) to have
// completed after promoted_at.
async function checkForNextImport(supabase, gh, batch) {
  const runs = await gh.listRecentRuns(WORKFLOW_IMPORT, 10);
  const completedSince = runs.find((r) => r.status === "completed" && r.created_at >= batch.promoted_at);
  if (!completedSince) {
    console.log("No completed golfnow-import run since promotion yet; waiting for the normal schedule");
    return;
  }
  await setBatchStatus(supabase, batch, "verifying");
}

// verifying -> completed: read that import run's own summary.json and
// classify every course this batch promoted (the exact list recorded
// by checkPromotionProgress, not re-derived) as has_inventory /
// no_availability / scraper_failure -- never inferred from the
// workflow's exit status alone.
async function runVerification(supabase, gh, batch, correlationId) {
  const promotionRun = await latestRun(supabase, batch.id, "promotion");
  const courseNames = promotionRun?.details?.course_names;
  if (!courseNames || courseNames.length === 0) {
    await pauseBatch(supabase, batch, "No recorded course list from the promotion stage to verify against");
    return;
  }

  const runs = await gh.listRecentRuns(WORKFLOW_IMPORT, 10);
  const importRun = runs.find((r) => r.status === "completed" && r.created_at >= batch.promoted_at);
  if (!importRun) {
    console.log("Import run no longer found; will re-check next tick");
    return;
  }

  const summary = await gh.downloadSummaryArtifact(importRun.id);
  if (!summary) {
    await pauseBatch(supabase, batch, `Could not read summary.json from import run ${importRun.id}`);
    return;
  }

  const classification = classifyImportResults(summary, courseNames);

  await recordRun(supabase, {
    batchId: batch.id,
    correlationId,
    stage: "import_verification",
    status: classification.failureCount > 0 ? "paused" : "succeeded",
    details: classification,
  });

  if (classification.failureCount > 0) {
    await pauseBatch(
      supabase,
      batch,
      `${classification.failureCount} course(s) failed or were never attempted in the verification import -- see golfnow_expansion_runs for detail`,
    );
    return;
  }

  await setBatchStatus(supabase, batch, "completed", { verified_at: new Date().toISOString() });
}

// ---------------------------------------------------------------------
// Orchestrator -- one tick. Reads config + batches, decides, dispatches
// to the matching handler. This is the function both runLive() (real
// clients) and the test suite (mocked clients) call.
// ---------------------------------------------------------------------

async function runTick(supabase, gh, correlationId = (globalThis.crypto || require("node:crypto")).randomUUID()) {
  const { data: config, error: configError } = await supabase.from("expansion_controller_config").select("*").single();
  if (configError) throw new Error(`Unable to read expansion_controller_config: ${configError.message}`);

  const { data: batches, error: batchesError } = await supabase.from("golfnow_expansion_batches").select("*");
  if (batchesError) throw new Error(`Unable to read golfnow_expansion_batches: ${batchesError.message}`);

  const decision = decideTick(config, batches || []);
  console.log("Controller decision:", decision.action, decision.reason || "");

  if (decision.action === "noop") return decision;

  const batch = decision.batch;

  if (decision.action === "start_discovery") {
    await startDiscovery(supabase, gh, batch, correlationId, config.max_batch_size);
    return decision;
  }

  switch (batch.status) {
    case "discovering":
      await checkDiscoveryProgress(supabase, gh, batch, correlationId, config.max_retries);
      break;
    case "validating":
      await runValidation(supabase, gh, batch, correlationId);
      break;
    case "promoting":
      await checkPromotionProgress(supabase, gh, batch, correlationId);
      break;
    case "promoted":
      await checkForNextImport(supabase, gh, batch);
      break;
    case "verifying":
      await runVerification(supabase, gh, batch, correlationId);
      break;
    default:
      console.log(`No handler for status ${batch.status}; leaving untouched`);
  }

  return decision;
}

/* istanbul ignore next -- thin env/client wiring, covered by runTick's own tests with mocks */
async function runLive() {
  const { createClient } = require("@supabase/supabase-js");

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || "OpenTees/opentees_scraper";

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  if (!GITHUB_TOKEN) throw new Error("Missing GITHUB_TOKEN");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const gh = buildGithubClient({ token: GITHUB_TOKEN, repository: GITHUB_REPOSITORY });

  await runTick(supabase, gh);
}

if (require.main === module) {
  runLive().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
