// Real-execution-layer tests for the UK Expansion Controller's stage
// handlers, using a mocked Supabase client (in-memory tables, real
// filter/insert/update semantics) and a mocked GitHub client (records
// every call, returns scripted responses). These exercise the actual
// exported functions main()/runLive() call -- startDiscovery,
// checkDiscoveryProgress, runValidation, checkPromotionProgress,
// checkForNextImport, runVerification, runTick -- never a
// reimplementation of their logic. No real network call, no real
// Supabase write, anywhere in this file.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  startDiscovery,
  checkDiscoveryProgress,
  runValidation,
  checkPromotionProgress,
  checkForNextImport,
  runVerification,
  runTick,
} = require("./expansion-controller");

// --- mock Supabase: in-memory tables with real filter/insert/update ---

let idCounter = 0;
function genId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

class TableQuery {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.mode = "select";
    this.single_ = false;
    this.countOnly = false;
    this._limit = null;
    this.patch = null;
    this.insertRows = null;
  }
  select(_cols, opts) {
    if (opts && opts.count) this.countOnly = Boolean(opts.head);
    return this;
  }
  eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
  neq(col, val) { this.filters.push((r) => r[col] !== val); return this; }
  gte(col, val) { this.filters.push((r) => r[col] >= val); return this; }
  in(col, arr) { this.filters.push((r) => arr.includes(r[col])); return this; }
  not(col, _op, val) {
    if (val === null) this.filters.push((r) => r[col] !== null && r[col] !== undefined);
    return this;
  }
  order(col, opts) { this._orderCol = col; this._orderAsc = Boolean(opts && opts.ascending); return this; }
  limit(n) { this._limit = n; return this; }
  single() { this.single_ = true; return this; }
  update(patch) { this.mode = "update"; this.patch = patch; return this; }
  insert(rows) { this.mode = "insert"; this.insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
  then(resolve) { resolve(this.table._run(this)); }
}

function makeTable(rows) {
  return {
    _rows: rows.map((r) => ({ ...r })),
    _run(query) {
      if (query.mode === "insert") {
        const inserted = query.insertRows.map((r) => ({ id: r.id || genId("row"), ...r }));
        this._rows.push(...inserted);
        return query.single_ ? { data: inserted[0], error: null } : { data: inserted, error: null };
      }
      if (query.mode === "update") {
        const matching = this._rows.filter((r) => query.filters.every((f) => f(r)));
        for (const row of matching) Object.assign(row, query.patch);
        return { data: matching, error: null };
      }
      let matching = this._rows.filter((r) => query.filters.every((f) => f(r)));
      if (query._orderCol) {
        matching = [...matching].sort((a, b) => {
          const av = a[query._orderCol];
          const bv = b[query._orderCol];
          if (av === bv) return 0;
          const cmp = av > bv ? 1 : -1;
          return query._orderAsc ? cmp : -cmp;
        });
      }
      if (query._limit != null) matching = matching.slice(0, query._limit);
      if (query.countOnly) return { data: null, count: matching.length, error: null };
      if (query.single_) {
        if (matching.length !== 1) return { data: null, error: { message: `expected 1 row, got ${matching.length}` } };
        return { data: { ...matching[0] }, error: null };
      }
      return { data: matching.map((r) => ({ ...r })), error: null };
    },
  };
}

function makeMockSupabase(initialTables = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(initialTables)) tables[name] = makeTable(rows);
  return {
    from(name) {
      if (!tables[name]) tables[name] = makeTable([]);
      return new TableQuery(tables[name]);
    },
    _rows(name) { return tables[name] ? tables[name]._rows : []; },
  };
}

// --- mock GitHub client -------------------------------------------------

function makeMockGithub(overrides = {}) {
  const calls = [];
  return {
    calls,
    async dispatchWorkflow(file, inputs) {
      calls.push(["dispatchWorkflow", file, inputs]);
      return overrides.dispatchWorkflow ? overrides.dispatchWorkflow(file, inputs) : "run-1";
    },
    async getRun(id) {
      calls.push(["getRun", id]);
      return overrides.getRun ? overrides.getRun(id) : { status: "completed", conclusion: "success" };
    },
    async listRecentRuns(file) {
      calls.push(["listRecentRuns", file]);
      return overrides.listRecentRuns ? overrides.listRecentRuns(file) : [];
    },
    async downloadSummaryArtifact(id) {
      calls.push(["downloadSummaryArtifact", id]);
      return overrides.downloadSummaryArtifact ? overrides.downloadSummaryArtifact(id) : null;
    },
  };
}

// --- startDiscovery ------------------------------------------------------

test("startDiscovery: inserts live nodes, dispatches discovery once, records the run with its github_run_id", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Stafford", latitude: 52.8, longitude: -2.1, radius: 35, status: "pending", retry_count: 0, discovery_node_id: null },
      { id: "bn-2", batch_id: "batch-1", node_name: "Derby", latitude: 52.9, longitude: -1.5, radius: 35, status: "pending", retry_count: 0, discovery_node_id: null },
    ],
    golfnow_discovery_nodes: [],
    golfnow_expansion_runs: [],
    golfnow_expansion_batches: [{ id: "batch-1", status: "approved" }],
  });
  const gh = makeMockGithub({ dispatchWorkflow: async () => "run-42" });

  await startDiscovery(supabase, gh, { id: "batch-1" }, "corr-1", 6);

  assert.equal(supabase._rows("golfnow_discovery_nodes").length, 2, "both nodes inserted into the live table");
  const batchNodes = supabase._rows("golfnow_expansion_batch_nodes");
  assert.ok(batchNodes.every((n) => n.discovery_node_id), "every batch node now links to a live discovery node");
  assert.ok(batchNodes.every((n) => n.status === "discovering"));

  assert.equal(gh.calls.filter((c) => c[0] === "dispatchWorkflow").length, 1);
  assert.equal(gh.calls[0][2].limit_nodes, undefined, "must not rely on a bare count/ordering");
  assert.deepEqual(
    gh.calls[0][2].node_ids.split(",").sort(),
    batchNodes.map((n) => n.discovery_node_id).sort(),
    "dispatch is scoped by this batch's exact node ids",
  );

  const runs = supabase._rows("golfnow_expansion_runs");
  const started = runs.find((r) => r.details.github_run_id);
  assert.equal(started.details.github_run_id, "run-42");

  const batch = supabase._rows("golfnow_expansion_batches").find((b) => b.id === "batch-1");
  assert.equal(batch.status, "discovering");
});

test("startDiscovery: restart safety -- calling it again after nodes already exist and a dispatch is already recorded never inserts nodes twice or dispatches twice", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Stafford", latitude: 52.8, longitude: -2.1, radius: 35, status: "pending", retry_count: 0, discovery_node_id: null },
    ],
    golfnow_discovery_nodes: [],
    golfnow_expansion_runs: [],
    golfnow_expansion_batches: [{ id: "batch-1", status: "approved" }],
  });
  const gh = makeMockGithub();

  await startDiscovery(supabase, gh, { id: "batch-1" }, "corr-1", 6);
  const nodeCountAfterFirst = supabase._rows("golfnow_discovery_nodes").length;
  const dispatchCountAfterFirst = gh.calls.filter((c) => c[0] === "dispatchWorkflow").length;

  // Simulate a restarted tick re-entering startDiscovery for the same
  // still-"approved"-looking batch (e.g. the status flip crashed).
  await startDiscovery(supabase, gh, { id: "batch-1" }, "corr-2", 6);

  assert.equal(supabase._rows("golfnow_discovery_nodes").length, nodeCountAfterFirst, "no duplicate node insert on restart");
  assert.equal(
    gh.calls.filter((c) => c[0] === "dispatchWorkflow").length,
    dispatchCountAfterFirst,
    "no duplicate dispatch on restart -- the existing recorded run is reused",
  );
});

// --- startDiscovery: crash-safe dispatch (defect 2) ---------------------
// These exercise dispatchDurable via startDiscovery -- a durable intent
// row written BEFORE the GitHub call, reconciled (never blindly
// re-dispatched or blindly assumed) on a restart.

test("startDiscovery: a dispatch_pending intent with a matching later GitHub run is reconciled, never re-dispatched", async () => {
  const intentStartedAt = new Date().toISOString();
  const supabase = makeMockSupabase({
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Stafford", latitude: 52.8, longitude: -2.1, radius: 35, status: "discovering", retry_count: 0, discovery_node_id: "node-existing" },
    ],
    golfnow_discovery_nodes: [{ id: "node-existing", batch_id: "batch-1" }],
    golfnow_expansion_runs: [
      { id: "run-row-1", batch_id: "batch-1", stage: "discovery", status: "dispatch_pending", started_at: intentStartedAt, details: {} },
    ],
    golfnow_expansion_batches: [{ id: "batch-1", status: "approved" }],
  });
  const gh = makeMockGithub({
    listRecentRuns: async () => [{ id: "run-reconciled", created_at: new Date(Date.now() + 1000).toISOString() }],
  });

  await startDiscovery(supabase, gh, { id: "batch-1" }, "corr-1", 6);

  assert.equal(gh.calls.filter((c) => c[0] === "dispatchWorkflow").length, 0, "never dispatches a second time once reconciled");
  const run = supabase._rows("golfnow_expansion_runs").find((r) => r.id === "run-row-1");
  assert.equal(run.status, "started");
  assert.equal(run.details.github_run_id, "run-reconciled");
  assert.equal(supabase._rows("golfnow_expansion_batches")[0].status, "discovering");
});

test("startDiscovery: a fresh dispatch_pending intent with no matching GitHub run yet waits rather than risking a duplicate dispatch", async () => {
  const intentStartedAt = new Date().toISOString(); // just now -- inside the reconcile window
  const supabase = makeMockSupabase({
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Stafford", latitude: 52.8, longitude: -2.1, radius: 35, status: "discovering", retry_count: 0, discovery_node_id: "node-existing" },
    ],
    golfnow_discovery_nodes: [{ id: "node-existing", batch_id: "batch-1" }],
    golfnow_expansion_runs: [
      { id: "run-row-1", batch_id: "batch-1", stage: "discovery", status: "dispatch_pending", started_at: intentStartedAt, details: {} },
    ],
    golfnow_expansion_batches: [{ id: "batch-1", status: "approved" }],
  });
  const gh = makeMockGithub({ listRecentRuns: async () => [] });

  await startDiscovery(supabase, gh, { id: "batch-1" }, "corr-1", 6);

  assert.equal(gh.calls.filter((c) => c[0] === "dispatchWorkflow").length, 0, "must not dispatch while the original attempt might still land");
  const run = supabase._rows("golfnow_expansion_runs").find((r) => r.id === "run-row-1");
  assert.equal(run.status, "dispatch_pending", "intent left pending for the next tick to re-check");
  assert.equal(supabase._rows("golfnow_expansion_batches")[0].status, "approved", "batch not advanced while settling");
});

test("startDiscovery: a stale dispatch_pending intent (past the reconcile window) with no matching run is safely re-dispatched, reusing the same intent row", async () => {
  const staleStartedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
  const supabase = makeMockSupabase({
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Stafford", latitude: 52.8, longitude: -2.1, radius: 35, status: "discovering", retry_count: 0, discovery_node_id: "node-existing" },
    ],
    golfnow_discovery_nodes: [{ id: "node-existing", batch_id: "batch-1" }],
    golfnow_expansion_runs: [
      { id: "run-row-1", batch_id: "batch-1", stage: "discovery", status: "dispatch_pending", started_at: staleStartedAt, details: {} },
    ],
    golfnow_expansion_batches: [{ id: "batch-1", status: "approved" }],
  });
  const gh = makeMockGithub({ listRecentRuns: async () => [], dispatchWorkflow: async () => "run-fresh" });

  await startDiscovery(supabase, gh, { id: "batch-1" }, "corr-1", 6);

  assert.equal(gh.calls.filter((c) => c[0] === "dispatchWorkflow").length, 1);
  assert.equal(supabase._rows("golfnow_expansion_runs").length, 1, "the stale intent row is reused, not duplicated");
  const run = supabase._rows("golfnow_expansion_runs")[0];
  assert.equal(run.status, "started");
  assert.equal(run.details.github_run_id, "run-fresh");
  assert.equal(supabase._rows("golfnow_expansion_batches")[0].status, "discovering");
});

test("startDiscovery: a batch exceeding max_batch_size is paused, never dispatched", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_batch_nodes: Array.from({ length: 8 }, (_, i) => ({
      id: `bn-${i}`, batch_id: "batch-1", node_name: `Node${i}`, latitude: 1, longitude: 1, radius: 35, status: "pending", retry_count: 0, discovery_node_id: null,
    })),
    golfnow_discovery_nodes: [],
    golfnow_expansion_runs: [],
    golfnow_expansion_batches: [{ id: "batch-1", status: "approved" }],
  });
  const gh = makeMockGithub();
  await startDiscovery(supabase, gh, { id: "batch-1" }, "corr-1", 6);
  assert.equal(gh.calls.length, 0);
  const batch = supabase._rows("golfnow_expansion_batches").find((b) => b.id === "batch-1");
  assert.equal(batch.status, "paused_for_review");
});

// --- checkDiscoveryProgress ----------------------------------------------

test("checkDiscoveryProgress: every node's last_run_at advanced -> all marked discovered, batch moves to validating", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_runs: [
      { batch_id: "batch-1", stage: "discovery", status: "started", started_at: "2026-10-12T10:00:00Z", details: { github_run_id: "run-1", dispatched_at: "2026-10-12T10:00:00Z" } },
    ],
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Stafford", status: "discovering", retry_count: 0, discovery_node_id: "node-a" },
    ],
    golfnow_discovery_nodes: [{ id: "node-a", last_run_at: "2026-10-12T10:05:00Z" }],
    golfnow_discovered_facilities: [
      { provider_course_id: "1", discovery_node_id: "node-a" },
      { provider_course_id: "2", discovery_node_id: "node-a" },
    ],
    golfnow_expansion_batches: [{ id: "batch-1", status: "discovering" }],
  });
  const gh = makeMockGithub({ getRun: async () => ({ status: "completed", conclusion: "success" }) });

  await checkDiscoveryProgress(supabase, gh, { id: "batch-1" }, "corr-1", 2);

  const node = supabase._rows("golfnow_expansion_batch_nodes")[0];
  assert.equal(node.status, "discovered");
  assert.equal(node.discovered_count, 2);
  const batch = supabase._rows("golfnow_expansion_batches")[0];
  assert.equal(batch.status, "validating");
});

test("checkDiscoveryProgress: last_run_at did NOT advance and retries remain -> node retried, discovery re-dispatched for just that node", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_runs: [
      { batch_id: "batch-1", stage: "discovery", status: "started", started_at: "2026-10-12T10:00:00Z", details: { github_run_id: "run-1", dispatched_at: "2026-10-12T10:00:00Z" } },
    ],
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Leeds", status: "discovering", retry_count: 0, discovery_node_id: "node-a" },
    ],
    golfnow_discovery_nodes: [{ id: "node-a", last_run_at: "2026-10-11T09:00:00Z" }], // stale -- before dispatch
    golfnow_discovered_facilities: [],
    golfnow_expansion_batches: [{ id: "batch-1", status: "discovering" }],
  });
  const gh = makeMockGithub({ getRun: async () => ({ status: "completed", conclusion: "success" }) });

  await checkDiscoveryProgress(supabase, gh, { id: "batch-1" }, "corr-1", 2);

  const node = supabase._rows("golfnow_expansion_batch_nodes")[0];
  assert.equal(node.status, "pending");
  assert.equal(node.retry_count, 1);
  assert.equal(gh.calls.filter((c) => c[0] === "dispatchWorkflow").length, 1);
  // Batch stays in discovering -- not yet moved to validating.
  const batch = supabase._rows("golfnow_expansion_batches")[0];
  assert.equal(batch.status, "discovering");
});

test("checkDiscoveryProgress: retry dispatch scopes explicitly by the retried node's id, not a bare count -- defect 1", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_runs: [
      { batch_id: "batch-1", stage: "discovery", status: "started", started_at: "2026-10-12T10:00:00Z", details: { github_run_id: "run-1", dispatched_at: "2026-10-12T10:00:00Z" } },
    ],
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Leeds", status: "discovering", retry_count: 0, discovery_node_id: "node-leeds" },
      { id: "bn-2", batch_id: "batch-1", node_name: "Bristol", status: "discovered", retry_count: 0, discovery_node_id: "node-bristol", discovered_count: 5 },
    ],
    golfnow_discovery_nodes: [{ id: "node-leeds", last_run_at: "2026-10-11T09:00:00Z" }], // stale
    golfnow_discovered_facilities: [],
    golfnow_expansion_batches: [{ id: "batch-1", status: "discovering" }],
  });
  const gh = makeMockGithub({ getRun: async () => ({ status: "completed", conclusion: "success" }) });

  await checkDiscoveryProgress(supabase, gh, { id: "batch-1" }, "corr-1", 2);

  const dispatchCall = gh.calls.find((c) => c[0] === "dispatchWorkflow");
  assert.equal(dispatchCall[2].node_ids, "node-leeds", "only the retried node is re-dispatched, by exact id");
  assert.equal(dispatchCall[2].limit_nodes, undefined, "must not rely on a bare count/ordering");
});

test("checkDiscoveryProgress: retries exhausted -> node failed, batch paused, no further dispatch", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_runs: [
      { batch_id: "batch-1", stage: "discovery", status: "started", started_at: "2026-10-12T10:00:00Z", details: { github_run_id: "run-1", dispatched_at: "2026-10-12T10:00:00Z" } },
    ],
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Belfast", status: "discovering", retry_count: 2, discovery_node_id: "node-a" },
    ],
    golfnow_discovery_nodes: [{ id: "node-a", last_run_at: "2026-10-11T09:00:00Z" }],
    golfnow_discovered_facilities: [],
    golfnow_expansion_batches: [{ id: "batch-1", status: "discovering" }],
  });
  const gh = makeMockGithub({ getRun: async () => ({ status: "completed", conclusion: "success" }) });

  await checkDiscoveryProgress(supabase, gh, { id: "batch-1" }, "corr-1", 2);

  const node = supabase._rows("golfnow_expansion_batch_nodes")[0];
  assert.equal(node.status, "failed");
  assert.equal(gh.calls.filter((c) => c[0] === "dispatchWorkflow").length, 0);
  const batch = supabase._rows("golfnow_expansion_batches")[0];
  assert.equal(batch.status, "paused_for_review");
});

test("checkDiscoveryProgress: the dispatched run is still in progress -> no state change, no error", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_runs: [
      { batch_id: "batch-1", stage: "discovery", status: "started", started_at: "2026-10-12T10:00:00Z", details: { github_run_id: "run-1", dispatched_at: "2026-10-12T10:00:00Z" } },
    ],
    golfnow_expansion_batch_nodes: [{ id: "bn-1", batch_id: "batch-1", node_name: "Stafford", status: "discovering", retry_count: 0, discovery_node_id: "node-a" }],
    golfnow_discovery_nodes: [{ id: "node-a", last_run_at: null }],
    golfnow_expansion_batches: [{ id: "batch-1", status: "discovering" }],
  });
  const gh = makeMockGithub({ getRun: async () => ({ status: "in_progress", conclusion: null }) });

  await checkDiscoveryProgress(supabase, gh, { id: "batch-1" }, "corr-1", 2);

  const batch = supabase._rows("golfnow_expansion_batches")[0];
  assert.equal(batch.status, "discovering", "unchanged while the run is still in progress");
});

// --- runValidation ---------------------------------------------------------

test("runValidation: clean pass dispatches promotion scoped with BATCH_ID and advances to promoting", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Stafford", discovery_node_id: "node-a", discovered_count: 2, status: "discovered" },
    ],
    golfnow_discovery_nodes: [{ id: "node-a", batch_id: "batch-1" }],
    golfnow_discovered_facilities: [
      { provider_course_id: "1", discovery_node_id: "node-a", course_name: "Derby Golf Course", number_of_tee_times: 60 },
      { provider_course_id: "2", discovery_node_id: "node-a", course_name: "Chevin Golf Club", number_of_tee_times: 70 },
    ],
    golfnow_facility_discovery_events: [
      { provider_course_id: "1", discovery_node_id: "node-a" },
      { provider_course_id: "2", discovery_node_id: "node-a" },
    ],
    golfnow_expansion_runs: [],
    golfnow_expansion_batches: [{ id: "batch-1", status: "validating", min_tee_times: 50 }],
  });
  const gh = makeMockGithub({ dispatchWorkflow: async () => "promote-run-1" });

  await runValidation(supabase, gh, { id: "batch-1", min_tee_times: 50 }, "corr-1");

  assert.equal(gh.calls.filter((c) => c[0] === "dispatchWorkflow" && c[1] === "golfnow-promote.yml").length, 1);
  assert.equal(gh.calls.find((c) => c[0] === "dispatchWorkflow")[2].batch_id, "batch-1");
  const batch = supabase._rows("golfnow_expansion_batches")[0];
  assert.equal(batch.status, "promoting");
});

test("runValidation: leakage (a facility also owned by a different batch's node) pauses the batch and never dispatches promotion", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Stafford", discovery_node_id: "node-a", discovered_count: 1, status: "discovered" },
    ],
    golfnow_discovery_nodes: [
      { id: "node-a", batch_id: "batch-1" },
      { id: "node-b", batch_id: "batch-2" }, // a different batch's node
    ],
    golfnow_discovered_facilities: [
      { provider_course_id: "1", discovery_node_id: "node-a", course_name: "Shared Facility", number_of_tee_times: 60 },
    ],
    golfnow_facility_discovery_events: [
      { provider_course_id: "1", discovery_node_id: "node-a" },
      { provider_course_id: "1", discovery_node_id: "node-b" }, // same facility, batch-2's node too
    ],
    golfnow_expansion_runs: [],
    golfnow_expansion_batches: [{ id: "batch-1", status: "validating", min_tee_times: 50 }],
  });
  const gh = makeMockGithub();

  await runValidation(supabase, gh, { id: "batch-1", min_tee_times: 50 }, "corr-1");

  assert.equal(gh.calls.length, 0, "promotion must never be dispatched when leakage is detected");
  const batch = supabase._rows("golfnow_expansion_batches")[0];
  assert.equal(batch.status, "paused_for_review");
  assert.match(batch.pause_reason, /different batch/);
});

// --- checkPromotionProgress -------------------------------------------------

test("checkPromotionProgress: promote run succeeded, matching courses rows exist -> batch moves to promoted with the course list recorded", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_runs: [
      { batch_id: "batch-1", stage: "promotion", status: "started", started_at: "2026-10-12T10:10:00Z", details: { github_run_id: "promote-run-1" } },
    ],
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Stafford", discovery_node_id: "node-a", eligible_count: 1 },
    ],
    golfnow_facility_discovery_events: [{ provider_course_id: "100", discovery_node_id: "node-a" }],
    courses: [{ provider_course_id: "100", course_name: "Derby Golf Course", provider: "golfnow" }],
    golfnow_expansion_batches: [{ id: "batch-1", status: "promoting" }],
  });
  const gh = makeMockGithub({ getRun: async () => ({ status: "completed", conclusion: "success" }) });

  await checkPromotionProgress(supabase, gh, { id: "batch-1" }, "corr-1");

  const batch = supabase._rows("golfnow_expansion_batches")[0];
  assert.equal(batch.status, "promoted");
  assert.ok(batch.promoted_at);
  const run = supabase._rows("golfnow_expansion_runs").find((r) => r.status === "succeeded");
  assert.deepEqual(run.details.course_names, ["Derby Golf Course"]);
});

test("checkPromotionProgress: workflow succeeded but zero matching courses appeared when some were expected -> paused, not silently promoted", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_runs: [
      { batch_id: "batch-1", stage: "promotion", status: "started", started_at: "2026-10-12T10:10:00Z", details: { github_run_id: "promote-run-1" } },
    ],
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Stafford", discovery_node_id: "node-a", eligible_count: 1 },
    ],
    golfnow_facility_discovery_events: [{ provider_course_id: "100", discovery_node_id: "node-a" }],
    courses: [], // nothing actually landed
    golfnow_expansion_batches: [{ id: "batch-1", status: "promoting" }],
  });
  const gh = makeMockGithub({ getRun: async () => ({ status: "completed", conclusion: "success" }) });

  await checkPromotionProgress(supabase, gh, { id: "batch-1" }, "corr-1");

  const batch = supabase._rows("golfnow_expansion_batches")[0];
  assert.equal(batch.status, "paused_for_review");
});

test("checkPromotionProgress: the promote workflow run itself failed -> paused, never marked promoted", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_runs: [
      { batch_id: "batch-1", stage: "promotion", status: "started", started_at: "2026-10-12T10:10:00Z", details: { github_run_id: "promote-run-1" } },
    ],
    golfnow_expansion_batch_nodes: [],
    golfnow_expansion_batches: [{ id: "batch-1", status: "promoting" }],
  });
  const gh = makeMockGithub({ getRun: async () => ({ status: "completed", conclusion: "failure" }) });

  await checkPromotionProgress(supabase, gh, { id: "batch-1" }, "corr-1");

  const batch = supabase._rows("golfnow_expansion_batches")[0];
  assert.equal(batch.status, "paused_for_review");
});

// --- checkForNextImport / runVerification (defect 3: pin the exact ----
// --- qualifying import run id, never re-search/substitute later) -----

test("checkForNextImport: no completed import run since promotion yet -> no state change, nothing pinned", async () => {
  const supabase = makeMockSupabase({ golfnow_expansion_batches: [{ id: "batch-1", status: "promoted", promoted_at: "2026-10-12T10:00:00Z" }] });
  const gh = makeMockGithub({ listRecentRuns: async () => [{ id: 1, status: "completed", created_at: "2026-10-12T09:00:00Z" }] }); // before promotion
  await checkForNextImport(supabase, gh, { id: "batch-1", promoted_at: "2026-10-12T10:00:00Z" }, "corr-1");
  assert.equal(supabase._rows("golfnow_expansion_batches")[0].status, "promoted");
  assert.equal(supabase._rows("golfnow_expansion_runs").length, 0, "nothing pinned when no qualifying run exists yet");
});

test("checkForNextImport: a completed import run after promotion -> pins its exact run id and moves to verifying", async () => {
  const supabase = makeMockSupabase({ golfnow_expansion_batches: [{ id: "batch-1", status: "promoted", promoted_at: "2026-10-12T10:00:00Z" }] });
  const gh = makeMockGithub({ listRecentRuns: async () => [{ id: 777, status: "completed", created_at: "2026-10-12T13:35:00Z" }] });
  await checkForNextImport(supabase, gh, { id: "batch-1", promoted_at: "2026-10-12T10:00:00Z" }, "corr-1");
  assert.equal(supabase._rows("golfnow_expansion_batches")[0].status, "verifying");
  const pinned = supabase._rows("golfnow_expansion_runs").find((r) => r.stage === "import_verification");
  assert.equal(pinned.details.github_run_id, 777);
});

test("checkForNextImport: restart safety -- a run already pinned is never re-searched or replaced by a different qualifying run", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_batches: [{ id: "batch-1", status: "promoted", promoted_at: "2026-10-12T10:00:00Z" }],
    golfnow_expansion_runs: [
      { batch_id: "batch-1", stage: "import_verification", status: "started", started_at: "2026-10-12T13:36:00Z", details: { github_run_id: 777 } },
    ],
  });
  // A second, later-completed import run now also qualifies -- must never be substituted for the one already pinned.
  const gh = makeMockGithub({ listRecentRuns: async () => [{ id: 888, status: "completed", created_at: "2026-10-12T19:35:00Z" }] });
  await checkForNextImport(supabase, gh, { id: "batch-1", promoted_at: "2026-10-12T10:00:00Z" }, "corr-1");
  assert.equal(gh.calls.length, 0, "never re-searches once a run is already pinned");
  const pinned = supabase._rows("golfnow_expansion_runs").find((r) => r.stage === "import_verification");
  assert.equal(pinned.details.github_run_id, 777, "the original pinned run id is untouched");
  assert.equal(supabase._rows("golfnow_expansion_batches")[0].status, "verifying");
});

test("runVerification: every promoted course scraped cleanly (some with inventory, some genuinely empty) -> completed, verifying exactly the pinned run", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_runs: [
      { batch_id: "batch-1", stage: "promotion", status: "succeeded", started_at: "2026-10-12T10:10:00Z", details: { course_names: ["Derby Golf Course", "Chevin Golf Club"] } },
      { batch_id: "batch-1", stage: "import_verification", status: "started", started_at: "2026-10-12T13:36:00Z", details: { github_run_id: 999 } },
    ],
    golfnow_expansion_batches: [{ id: "batch-1", status: "verifying", promoted_at: "2026-10-12T10:00:00Z" }],
  });
  const gh = makeMockGithub({
    downloadSummaryArtifact: async (id) => {
      assert.equal(id, 999, "must verify exactly the pinned run, never a re-derived one");
      return {
        courses: [
          { course: "Derby Golf Course", ok: true, extractedCount: 12, error: null },
          { course: "Chevin Golf Club", ok: true, extractedCount: 0, error: null },
        ],
      };
    },
  });

  await runVerification(supabase, gh, { id: "batch-1", promoted_at: "2026-10-12T10:00:00Z" }, "corr-1");

  const batch = supabase._rows("golfnow_expansion_batches")[0];
  assert.equal(batch.status, "completed");
  assert.ok(batch.verified_at);
  assert.equal(gh.calls.some((c) => c[0] === "listRecentRuns"), false, "must never re-search recent runs during verification");
});

test("runVerification: a scraper failure among the promoted courses pauses instead of completing", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_runs: [
      { batch_id: "batch-1", stage: "promotion", status: "succeeded", started_at: "2026-10-12T10:10:00Z", details: { course_names: ["Mickleover Golf Club"] } },
      { batch_id: "batch-1", stage: "import_verification", status: "started", started_at: "2026-10-12T13:36:00Z", details: { github_run_id: 999 } },
    ],
    golfnow_expansion_batches: [{ id: "batch-1", status: "verifying", promoted_at: "2026-10-12T10:00:00Z" }],
  });
  const gh = makeMockGithub({
    downloadSummaryArtifact: async () => ({
      courses: [{ course: "Mickleover Golf Club", ok: false, extractedCount: 0, error: "Timeout" }],
    }),
  });

  await runVerification(supabase, gh, { id: "batch-1", promoted_at: "2026-10-12T10:00:00Z" }, "corr-1");

  const batch = supabase._rows("golfnow_expansion_batches")[0];
  assert.equal(batch.status, "paused_for_review");
});

test("runVerification: no pinned import run recorded -> paused for manual review, never guesses one", async () => {
  const supabase = makeMockSupabase({
    golfnow_expansion_runs: [
      { batch_id: "batch-1", stage: "promotion", status: "succeeded", started_at: "2026-10-12T10:10:00Z", details: { course_names: ["Mickleover Golf Club"] } },
    ],
    golfnow_expansion_batches: [{ id: "batch-1", status: "verifying", promoted_at: "2026-10-12T10:00:00Z" }],
  });
  const gh = makeMockGithub();

  await runVerification(supabase, gh, { id: "batch-1", promoted_at: "2026-10-12T10:00:00Z" }, "corr-1");

  const batch = supabase._rows("golfnow_expansion_batches")[0];
  assert.equal(batch.status, "paused_for_review");
  assert.equal(gh.calls.length, 0);
});

// --- runTick (orchestrator) --------------------------------------------------

test("runTick: automation disabled -> no handler is ever invoked, nothing in the mock changes", async () => {
  const supabase = makeMockSupabase({
    expansion_controller_config: [{ automation_enabled: false, max_batch_size: 6, max_retries: 2 }],
    golfnow_expansion_batches: [{ id: "batch-1", status: "approved", sequence_order: 1 }],
    golfnow_expansion_batch_nodes: [{ id: "bn-1", batch_id: "batch-1", node_name: "Stafford", status: "pending", retry_count: 0 }],
  });
  const gh = makeMockGithub();

  const decision = await runTick(supabase, gh, "corr-1");

  assert.equal(decision.action, "noop");
  assert.equal(gh.calls.length, 0);
  assert.equal(supabase._rows("golfnow_expansion_batches")[0].status, "approved", "untouched");
});

test("runTick: automation enabled, one approved batch -> starts discovery for real via the real handler", async () => {
  const supabase = makeMockSupabase({
    expansion_controller_config: [{ automation_enabled: true, max_batch_size: 6, max_retries: 2 }],
    golfnow_expansion_batches: [{ id: "batch-1", status: "approved", sequence_order: 1 }],
    golfnow_expansion_batch_nodes: [
      { id: "bn-1", batch_id: "batch-1", node_name: "Stafford", latitude: 52.8, longitude: -2.1, radius: 35, status: "pending", retry_count: 0, discovery_node_id: null },
    ],
    golfnow_discovery_nodes: [],
    golfnow_expansion_runs: [],
  });
  const gh = makeMockGithub({ dispatchWorkflow: async () => "run-99" });

  const decision = await runTick(supabase, gh, "corr-1");

  assert.equal(decision.action, "start_discovery");
  assert.equal(gh.calls.filter((c) => c[0] === "dispatchWorkflow").length, 1);
  assert.equal(supabase._rows("golfnow_expansion_batches")[0].status, "discovering");
});
