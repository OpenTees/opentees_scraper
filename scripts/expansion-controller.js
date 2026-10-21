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

// Explicit, documented ceiling on the extracted summary.json this
// controller will ever read. A full-scale import's summary legitimately
// grows with the number of courses/rows scraped (run #39's crash was
// ~465 courses / 17,124 rows), so this is set well above any size seen
// in production, not tuned to today's exact numbers -- but it is still a
// bound, not "whatever fits in memory", so a corrupted or runaway
// artifact fails closed (null, see downloadSummaryArtifact) instead of
// exhausting memory on the runner.
const MAX_SUMMARY_ARTIFACT_BYTES = 50 * 1024 * 1024; // 50MB

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
  findRunMatchingToken,
  retryAttemptKey,
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

// Pure: reliably associate a GitHub workflow run with a specific
// controller dispatch by IDENTITY (the dispatch_token embedded in that
// run's own run-name -- see golfnow-discovery.yml/golfnow-promote.yml's
// `run-name:` line), never by creation time alone. Creation time can
// match an unrelated scheduled run, or a run a human happened to
// trigger manually around the same moment; identity can't. Returns
// null (never a guess) when no run carries this exact token yet.
function findRunMatchingToken(runs, token) {
  if (!token) return null;
  return (runs || []).find(
    (r) => typeof r.display_title === "string" && r.display_title.includes(`[ctrl:${token}]`),
  ) || null;
}

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
    // inputs.dispatch_token (set by dispatchDurable) is what makes the
    // run this creates identifiable afterwards -- see
    // findRunMatchingToken. If GitHub hasn't indexed the new run by the
    // time this short poll gives up, this returns null rather than
    // guessing or throwing: the caller's durable reconciliation (same
    // token, same findRunMatchingToken) picks it up on a later tick.
    async dispatchWorkflow(workflowFile, inputs) {
      await gh(`/actions/workflows/${workflowFile}/dispatches`, {
        method: "POST",
        body: JSON.stringify({ ref: "main", inputs }),
      });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((r) => setTimeout(r, 5000));
        const runs = await gh(`/actions/workflows/${workflowFile}/runs?per_page=10`);
        const match = findRunMatchingToken(runs.workflow_runs, inputs.dispatch_token);
        if (match) return match.id;
      }
      return null;
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
      // `unzip` (present on the ubuntu-latest runner) rather than add a
      // new dependency for one file.
      //
      // Extract to a file (-d), never pipe through `unzip -p` into a
      // captured stdout buffer: execFileSync's captured stdout is bounded
      // by Node's default 1MB maxBuffer, and once summary.json crosses
      // that it throws ENOBUFS -- the confirmed cause of controller run
      // #39's crash (465 courses / 17,124 extracted rows produced a
      // summary.json over 1MB). Extracting to disk has no such ceiling,
      // so MAX_SUMMARY_ARTIFACT_BYTES below is this function's own
      // explicit, documented bound, not an accidental one.
      const { execFileSync } = require("node:child_process");
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `expansion-artifact-${runId}-`));
      try {
        const tmpZip = path.join(tmpDir, "artifact.zip");
        fs.writeFileSync(tmpZip, buffer);

        try {
          execFileSync("unzip", ["-o", "-q", tmpZip, "summary.json", "-d", tmpDir]);
        } catch (extractError) {
          console.error(`Unable to extract summary.json from run ${runId}'s artifact: ${extractError.message}`);
          return null;
        }

        const summaryPath = path.join(tmpDir, "summary.json");
        let size;
        try {
          size = fs.statSync(summaryPath).size;
        } catch {
          console.error(`Run ${runId}'s artifact did not contain summary.json`);
          return null;
        }
        if (size > MAX_SUMMARY_ARTIFACT_BYTES) {
          console.error(
            `summary.json from run ${runId} is ${size} bytes, exceeding the ${MAX_SUMMARY_ARTIFACT_BYTES}-byte limit -- refusing to read it`,
          );
          return null;
        }

        const summaryText = fs.readFileSync(summaryPath, "utf8");
        try {
          return JSON.parse(summaryText);
        } catch (parseError) {
          console.error(`summary.json from run ${runId} is not valid JSON: ${parseError.message}`);
          return null;
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
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
    started_at: new Date().toISOString(),
    completed_at: status === "started" ? null : new Date().toISOString(),
    details: details || {},
  });
  if (error) throw new Error(`Unable to record expansion run: ${error.message}`);
}

// ---------------------------------------------------------------------
// Crash-safe workflow dispatch (PR #2 correction: "do not assume the
// current post-dispatch insert is crash-safe"). A durable "dispatch
// intent" row -- carrying a unique dispatch_token -- is written BEFORE
// the GitHub API call, not after, so a crash between the API call
// succeeding and the DB write is recovered by reconciliation on the
// next tick, rather than silently forgotten (which could otherwise
// double-dispatch, or leave the batch stuck with no record that
// anything was ever attempted).
//
// Reconciliation matches by that token -- embedded in the dispatched
// run's own run-name (see findRunMatchingToken) -- never by creation
// time alone, which could adopt an unrelated scheduled or manually
// triggered run. If identity can't yet be established, the caller is
// told to wait (`settling: true`), never to guess.
//
// `attemptKey` (default "primary") scopes this to one specific dispatch
// attempt, durable across a restart of that SAME attempt, but distinct
// from any other attempt under the same (batchId, stage) -- e.g. the
// one-shot initial discovery/promotion dispatch ("primary"), or one
// specific discovery-retry wave (see retryAttemptKey). Without this,
// a second, genuinely new retry wave could be mistaken for an earlier
// one still settling, or vice versa.
// ---------------------------------------------------------------------

const DISPATCH_RECONCILE_WINDOW_MS = 2 * 60 * 1000;

async function recentRunsForStage(supabase, batchId, stage, limit) {
  const { data, error } = await supabase
    .from("golfnow_expansion_runs")
    .select("*")
    .eq("batch_id", batchId)
    .eq("stage", stage)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Unable to read expansion runs: ${error.message}`);
  return data || [];
}

// Pure: a deterministic, durable identity for one discovery-retry wave,
// derived only from exactly which nodes are retrying and at exactly
// which retry_count -- both already committed to the database before
// this is ever called. Stable across a crash-restart of the SAME wave
// (nothing re-increments retry_count for an already-"pending" node);
// distinct from any other wave (a different node set and/or a higher
// retry_count changes the key).
function retryAttemptKey(pendingNodes) {
  return pendingNodes
    .map((n) => `${n.id}:${n.retry_count}`)
    .sort()
    .join(",");
}

async function recordDispatchIntent(supabase, { batchId, correlationId, stage, attemptKey, token }) {
  const { data, error } = await supabase
    .from("golfnow_expansion_runs")
    .insert({
      batch_id: batchId,
      correlation_id: correlationId,
      stage,
      status: "dispatch_pending",
      started_at: new Date().toISOString(),
      completed_at: null,
      details: { attempt_key: attemptKey, dispatch_token: token },
    })
    .select("*")
    .single();
  if (error) throw new Error(`Unable to record dispatch intent: ${error.message}`);
  return data;
}

async function confirmDispatch(supabase, runRowId, githubRunId, extraDetails = {}) {
  const { data: row, error: readError } = await supabase
    .from("golfnow_expansion_runs")
    .select("*")
    .eq("id", runRowId)
    .single();
  if (readError) throw new Error(`Unable to read dispatch intent: ${readError.message}`);

  const { error } = await supabase
    .from("golfnow_expansion_runs")
    .update({
      status: "started",
      details: { ...row.details, ...extraDetails, github_run_id: githubRunId, dispatched_at: new Date().toISOString() },
    })
    .eq("id", runRowId);
  if (error) throw new Error(`Unable to confirm dispatch: ${error.message}`);
}

// Returns { runId, isNew, reconciled?, settling? }. `settling: true`
// means identity for a previous intent can't yet be established -- the
// caller must leave the batch/node state untouched and let the next
// tick re-check, rather than dispatch a possible duplicate or adopt an
// unrelated run.
async function dispatchDurable(supabase, gh, { batchId, correlationId, stage, attemptKey = "primary", workflowFile, inputs }) {
  const candidates = await recentRunsForStage(supabase, batchId, stage, 10);
  const mine = candidates.filter((r) => (r.details?.attempt_key || "primary") === attemptKey);

  const confirmed = mine.find((r) => r.status === "started" && r.details?.github_run_id);
  if (confirmed) {
    return { runId: confirmed.details.github_run_id, isNew: false };
  }

  let intent = mine.find((r) => r.status === "dispatch_pending") || null;

  if (intent) {
    // An earlier tick recorded intent to dispatch but crashed before
    // (or while) confirming the result. Reconcile by the durable token
    // this exact intent carries -- never by creation time, which could
    // adopt an unrelated scheduled or manually triggered run.
    const token = intent.details?.dispatch_token;
    const runs = await gh.listRecentRuns(workflowFile, 20);
    const match = findRunMatchingToken(runs, token);
    if (match) {
      await confirmDispatch(supabase, intent.id, match.id);
      return { runId: match.id, isNew: false, reconciled: true };
    }

    const elapsedMs = Date.now() - new Date(intent.started_at).getTime();
    if (elapsedMs < DISPATCH_RECONCILE_WINDOW_MS) {
      // Too soon to tell whether the original API call reached GitHub
      // yet -- wait for it to show up rather than risk a duplicate.
      return { runId: null, isNew: false, settling: true };
    }
    // No run carries this token after a safe reconciliation window:
    // the original dispatch attempt never reached GitHub. Reuse the
    // same intent row (and its token) rather than recording a second
    // one or adopting whatever run happens to exist.
  } else {
    const token = (globalThis.crypto || require("node:crypto")).randomUUID();
    intent = await recordDispatchIntent(supabase, { batchId, correlationId, stage, attemptKey, token });
  }

  const token = intent.details.dispatch_token;
  const runId = await gh.dispatchWorkflow(workflowFile, { ...inputs, dispatch_token: token });
  if (!runId) {
    // Dispatched, but this tick's own short poll couldn't yet establish
    // which run is ours. Leave the intent pending rather than guess --
    // the next tick's reconciliation (same token) will find it once
    // GitHub has indexed it.
    return { runId: null, isNew: false, settling: true };
  }

  await confirmDispatch(supabase, intent.id, runId);
  return { runId, isNew: true };
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
  // crashed tick -- never inserted a second time. Collect every node's
  // live id as we go: this is what lets the dispatch below scope
  // discovery to EXACTLY this batch's nodes, by id, rather than relying
  // on golfnow_discovery_nodes' last_run_at ordering + a bare count
  // (which a concurrent legacy node's own last_run_at could disturb).
  const nodeIds = [];
  for (const node of nodes) {
    if (node.discovery_node_id) {
      nodeIds.push(node.discovery_node_id);
      continue;
    }
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
    nodeIds.push(inserted.id);

    const { error: updateError } = await supabase
      .from("golfnow_expansion_batch_nodes")
      .update({ discovery_node_id: inserted.id, status: "discovering", updated_at: new Date().toISOString() })
      .eq("id", node.id);
    if (updateError) throw new Error(`Unable to update batch node ${node.node_name}: ${updateError.message}`);
  }

  // Crash-safe dispatch (see dispatchDurable): writes a durable intent
  // before calling GitHub, and reconciles against GitHub's own run list
  // on a restart rather than assuming the post-dispatch insert landed.
  const { settling } = await dispatchDurable(supabase, gh, {
    batchId: batch.id,
    correlationId,
    stage: "discovery",
    attemptKey: "primary",
    workflowFile: WORKFLOW_DISCOVERY,
    inputs: { node_ids: nodeIds.join(",") },
  });

  if (settling) return; // too soon to tell if the earlier attempt reached GitHub -- re-check next tick

  await setBatchStatus(supabase, batch, "discovering");
}

// discovering -> validating (or retry / fail): poll the dispatched run;
// once complete, verify EACH node's last_run_at actually advanced --
// never trust "the workflow succeeded" alone.
async function checkDiscoveryProgress(supabase, gh, batch, correlationId, maxRetries) {
  const run = await latestRun(supabase, batch.id, "discovery");
  if (!run) {
    await pauseBatch(supabase, batch, "Discovering state with no recorded dispatch -- manual review needed");
    return;
  }
  if (run.status === "dispatch_pending") {
    // A dispatch (initial or a retry wave) is still settling -- see
    // dispatchDurable. Never pause or guess here; just wait.
    console.log("Discovery dispatch still settling; will re-check next tick");
    return;
  }

  const githubRunId = run.details?.github_run_id;
  const dispatchedAt = run.details?.dispatched_at;
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

  // Pass 1: decide, ONCE per node per wave, whether a currently-
  // "discovering" node actually advanced under the latest dispatch
  // above. A node already sitting at "pending" is awaiting a retry
  // dispatch already decided on an earlier tick -- it must never be
  // re-evaluated or re-incremented here, or a slow-to-land retry would
  // burn through its retry budget on every tick before its own
  // dispatch even lands. This is also what keeps retryAttemptKey (used
  // by the dispatch below) stable across a crash-restart of the same
  // wave: the set of pending nodes and their retry_count never changes
  // except by this pass, and this pass only ever touches "discovering"
  // nodes.
  for (const node of nodes) {
    if (node.status !== "discovering") continue;

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

  // Pass 2: dispatch (or resume/reconcile) the retry for every node
  // currently "pending", via the SAME durable, identity-based mechanism
  // as the initial dispatch -- scoped by retryAttemptKey, a durable
  // identity derived from exactly which nodes are retrying at exactly
  // which retry_count, so a crash-restart of this same wave resumes it
  // and a genuinely new, later wave never collides with an earlier one.
  const pendingNodes = refreshedNodes.filter((n) => n.status === "pending");
  if (pendingNodes.length > 0) {
    const attemptKey = retryAttemptKey(pendingNodes);
    const pendingNodeIds = pendingNodes.map((n) => n.discovery_node_id).filter(Boolean);

    const { runId, settling } = await dispatchDurable(supabase, gh, {
      batchId: batch.id,
      correlationId,
      stage: "discovery",
      attemptKey,
      workflowFile: WORKFLOW_DISCOVERY,
      inputs: { node_ids: pendingNodeIds.join(",") },
    });

    if (settling) return;

    // Identity for this wave's dispatch is now established -- move
    // these nodes back to "discovering" so the next tick's Pass 1
    // evaluates them against it exactly once.
    if (runId) {
      for (const node of pendingNodes) {
        const { error: resumeError } = await supabase
          .from("golfnow_expansion_batch_nodes")
          .update({ status: "discovering", updated_at: new Date().toISOString() })
          .eq("id", node.id);
        if (resumeError) throw new Error(`Unable to resume node ${node.node_name}: ${resumeError.message}`);
      }
    }
    return;
  }

  const stillDiscovering = refreshedNodes.some((n) => n.status === "discovering");
  if (stillDiscovering) return; // a node's retry dispatch was just resumed above; let the next tick evaluate it

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
  // Crash-safe dispatch (see dispatchDurable): writes a durable intent
  // before calling GitHub, and reconciles against GitHub's own run list
  // on a restart rather than assuming the post-dispatch insert landed.
  const { settling } = await dispatchDurable(supabase, gh, {
    batchId: batch.id,
    correlationId,
    stage: "promotion",
    workflowFile: WORKFLOW_PROMOTE,
    inputs: { min_tee_times: String(batch.min_tee_times), batch_id: batch.id },
  });

  if (settling) return; // too soon to tell if the earlier attempt reached GitHub -- re-check next tick

  await setBatchStatus(supabase, batch, "promoting");
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
// completed after promoted_at, and PIN its exact run id the moment
// it's first confirmed -- a durable "import_verification"/"started"
// run row, mirroring how discovery/promotion pin their own
// github_run_id. Every later verification step reads that pinned id;
// none of them re-search recent runs, so a second run that happens to
// also qualify (completed, after promoted_at) can never be silently
// substituted for the one actually confirmed here.
async function checkForNextImport(supabase, gh, batch, correlationId) {
  const alreadyPinned = await latestRun(supabase, batch.id, "import_verification");
  if (alreadyPinned && alreadyPinned.details?.github_run_id) {
    await setBatchStatus(supabase, batch, "verifying");
    return;
  }

  const runs = await gh.listRecentRuns(WORKFLOW_IMPORT, 10);
  // Require actual success, not merely "completed" -- a completed run
  // can still have conclusion 'failure'/'cancelled'/'timed_out', and
  // pinning one of those would send runVerification to read an
  // artifact from a run that never produced trustworthy results.
  const completedSince = runs.find(
    (r) => r.status === "completed" && r.conclusion === "success" && r.created_at >= batch.promoted_at,
  );
  if (!completedSince) {
    console.log("No successfully completed golfnow-import run since promotion yet; waiting for the normal schedule");
    return;
  }

  await recordRun(supabase, {
    batchId: batch.id,
    correlationId,
    stage: "import_verification",
    status: "started",
    details: { github_run_id: completedSince.id },
  });
  await setBatchStatus(supabase, batch, "verifying");
}

// verifying -> completed: read the PINNED import run's own summary.json
// (never a freshly re-searched run) and classify every course this
// batch promoted (the exact list recorded by checkPromotionProgress,
// not re-derived) as has_inventory / no_availability / scraper_failure
// -- never inferred from the workflow's exit status alone.
async function runVerification(supabase, gh, batch, correlationId) {
  const promotionRun = await latestRun(supabase, batch.id, "promotion");
  const courseNames = promotionRun?.details?.course_names;
  if (!courseNames || courseNames.length === 0) {
    await pauseBatch(supabase, batch, "No recorded course list from the promotion stage to verify against");
    return;
  }

  const pinnedRun = await latestRun(supabase, batch.id, "import_verification");
  const importRunId = pinnedRun?.details?.github_run_id;
  if (!importRunId) {
    await pauseBatch(supabase, batch, "No pinned import run recorded from the promoted->verifying transition -- manual review needed");
    return;
  }

  const summary = await gh.downloadSummaryArtifact(importRunId);
  if (!summary) {
    await pauseBatch(supabase, batch, `Could not read summary.json from import run ${importRunId}`);
    return;
  }

  const classification = classifyImportResults(summary, courseNames);

  await recordRun(supabase, {
    batchId: batch.id,
    correlationId,
    stage: "import_verification",
    status: classification.failureCount > 0 ? "paused" : "succeeded",
    details: { ...classification, github_run_id: importRunId },
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
      await checkForNextImport(supabase, gh, batch, correlationId);
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
