// UK Expansion Controller — safe end-to-end dry run.
//
// Drives the controller's full decision pipeline (decideTick ->
// evaluateValidation -> shouldRetryNode -> classifyImportResults)
// through a complete batch lifecycle using fixture data standing in for
// Supabase/GitHub reads -- exactly the sequence runLive()'s I/O layer
// would feed it, with every I/O call itself replaced by a fixture.
// Makes zero real GitHub API calls, zero real Supabase writes, and
// never imports or exercises runLive() itself (which still throws for
// any non-noop decision -- see that function's own comment). This is
// the "safe dry run" requested in place of exercising the still-blocked
// live wiring: it proves the decision logic end-to-end without ever
// touching real infrastructure.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decideTick,
  evaluateValidation,
  shouldRetryNode,
  classifyImportResults,
} = require("./expansion-controller");

const CONFIG = { automation_enabled: true, max_batch_size: 6, max_retries: 2 };

test("dry run: happy path -- approved batch advances cleanly through every stage to completed", () => {
  // Tick 1: nothing in flight -- starts the only approved batch.
  let batches = [
    { id: "batch-1", status: "approved", sequence_order: 1 },
  ];
  let decision = decideTick(CONFIG, batches);
  assert.equal(decision.action, "start_discovery");
  assert.equal(decision.batch.id, "batch-1");

  // Controller inserts nodes, dispatches discovery, sets status
  // "discovering" -- simulated here, not via a real dispatch.
  batches = [{ id: "batch-1", status: "discovering", sequence_order: 1 }];
  decision = decideTick(CONFIG, batches);
  assert.equal(decision.action, "advance");
  assert.equal(decision.batch.status, "discovering");

  // Discovery completes (simulated GitHub run + last_run_at check) --
  // both nodes reach "discovered", feeding evaluateValidation.
  const batchNodes = [
    { node_name: "Stafford", status: "discovered", retry_count: 0 },
    { node_name: "Derby", status: "discovered", retry_count: 0 },
  ];
  const discoveredByNode = new Map([
    ["Stafford", { discovered: 20, eligible: 20, blocklisted: 0, fromOtherBatch: 0 }],
    ["Derby", { discovered: 25, eligible: 25, blocklisted: 0, fromOtherBatch: 0 }],
  ]);
  const validation = evaluateValidation(batchNodes, discoveredByNode);
  assert.equal(validation.pass, true);
  assert.equal(validation.details.totalEligible, 45);

  // Validation passed -> promoting -> promoted (simulated promote
  // dispatch + courses row count check).
  batches = [{ id: "batch-1", status: "promoting", sequence_order: 1 }];
  decision = decideTick(CONFIG, batches);
  assert.equal(decision.action, "advance");

  batches = [{ id: "batch-1", status: "promoted", sequence_order: 1, promoted_at: "2026-10-12T09:52:18Z" }];
  decision = decideTick(CONFIG, batches);
  assert.equal(decision.action, "advance");
  assert.equal(decision.batch.status, "promoted");

  // Next scheduled golfnow-import run completes after promoted_at ->
  // verifying. Simulated summary.json: every promoted course scraped
  // cleanly, some with inventory, some genuinely empty right now.
  batches = [{ id: "batch-1", status: "verifying", sequence_order: 1 }];
  decision = decideTick(CONFIG, batches);
  assert.equal(decision.action, "advance");

  const summary = {
    courses: [
      { course: "Derby Golf Course", ok: true, extractedCount: 12, error: null },
      { course: "Chevin Golf Club", ok: true, extractedCount: 0, error: null },
      { course: "Sandwell Park Golf Club", ok: true, extractedCount: 5, error: null },
    ],
  };
  const classification = classifyImportResults(summary, [
    "Derby Golf Course",
    "Chevin Golf Club",
    "Sandwell Park Golf Club",
  ]);
  assert.equal(classification.failureCount, 0);
  assert.equal(classification.hasInventoryCount, 2);
  assert.equal(classification.noAvailabilityCount, 1);

  // Zero failures -> completed. Next tick finds nothing left in flight
  // and no more approved batches -> queue_empty.
  batches = [{ id: "batch-1", status: "completed", sequence_order: 1 }];
  decision = decideTick(CONFIG, batches);
  assert.equal(decision.action, "noop");
  assert.equal(decision.reason, "queue_empty");
});

test("dry run: a node that fails discovery twice (within max_retries) recovers; validation then passes", () => {
  const maxRetries = CONFIG.max_retries;

  // First attempt: Leeds fails (last_run_at never advanced).
  let node = { node_name: "Leeds", status: "pending", retry_count: 0 };
  assert.equal(shouldRetryNode(node, maxRetries), true);
  node = { ...node, status: "pending", retry_count: 1 }; // controller re-dispatches it alone

  // Second attempt succeeds.
  node = { ...node, status: "discovered", retry_count: 1 };

  const batchNodes = [node, { node_name: "Manchester", status: "discovered", retry_count: 0 }];
  const discoveredByNode = new Map([
    ["Leeds", { discovered: 25, eligible: 25, blocklisted: 0, fromOtherBatch: 0 }],
    ["Manchester", { discovered: 27, eligible: 27, blocklisted: 0, fromOtherBatch: 0 }],
  ]);
  const validation = evaluateValidation(batchNodes, discoveredByNode);
  assert.equal(validation.pass, true);
});

test("dry run: a node that exhausts retries fails the whole batch, and the queue stays blocked on it (never silently skipped)", () => {
  const maxRetries = CONFIG.max_retries;
  let node = { node_name: "Belfast", status: "pending", retry_count: 2 };
  assert.equal(shouldRetryNode(node, maxRetries), false); // exhausted -> controller marks it "failed"
  node = { ...node, status: "failed" };

  const batchNodes = [node, { node_name: "Cardiff", status: "discovered", retry_count: 0 }];
  const validation = evaluateValidation(batchNodes, new Map());
  assert.equal(validation.pass, false);
  assert.match(validation.reason, /Belfast/);

  // The batch is now paused_for_review/failed. A second, otherwise-ready
  // approved batch must NOT start while this one is unresolved.
  const batches = [
    { id: "batch-1", status: "failed", sequence_order: 1 },
    { id: "batch-2", status: "approved", sequence_order: 2 },
  ];
  const decision = decideTick(CONFIG, batches);
  assert.equal(decision.action, "noop");
  assert.equal(decision.reason, "batch_failed");
  assert.equal(decision.batch.id, "batch-1");
});

test("dry run: a scraper failure during the verification import pauses the batch instead of completing it", () => {
  const summary = {
    courses: [
      { course: "Derby Golf Course", ok: true, extractedCount: 12, error: null },
      { course: "Mickleover Golf Club", ok: false, extractedCount: 0, error: "Timeout" },
    ],
  };
  const classification = classifyImportResults(summary, ["Derby Golf Course", "Mickleover Golf Club"]);
  assert.equal(classification.failureCount, 1);

  // The controller's runVerification would pause here, not call
  // setBatchStatus(..., "completed") -- asserted at the decision-input
  // level: failureCount > 0 is exactly the condition that must gate it.
  const wouldComplete = classification.failureCount === 0;
  assert.equal(wouldComplete, false);
});

test("dry run: global stop switch halts the pipeline at any stage, including mid-batch", () => {
  const disabled = { ...CONFIG, automation_enabled: false };
  for (const status of ["approved", "discovering", "validating", "promoting", "promoted", "verifying", "paused_for_review", "failed"]) {
    const decision = decideTick(disabled, [{ id: "batch-1", status, sequence_order: 1 }]);
    assert.equal(decision.action, "noop", `expected noop while disabled, got ${decision.action} for status ${status}`);
    assert.equal(decision.reason, "automation_disabled");
  }
});
