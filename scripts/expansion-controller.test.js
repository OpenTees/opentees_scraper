const assert = require("node:assert/strict");
const test = require("node:test");

const {
  coordKey,
  decideTick,
  evaluateValidation,
  shouldRetryNode,
  classifyImportResults,
} = require("./expansion-controller");

// --- decideTick ---------------------------------------------------------

test("decideTick: automation_enabled=false is always a no-op, regardless of queue state", () => {
  const config = { automation_enabled: false, max_batch_size: 6, max_retries: 2 };
  const batches = [{ id: "b1", status: "approved", sequence_order: 1 }];
  const result = decideTick(config, batches);
  assert.equal(result.action, "noop");
  assert.equal(result.reason, "automation_disabled");
});

test("decideTick: an in-flight batch (discovering/validating/promoting/promoted/verifying) is advanced before anything else", () => {
  const config = { automation_enabled: true };
  const batches = [
    { id: "b1", status: "approved", sequence_order: 1 },
    { id: "b2", status: "validating", sequence_order: 2 },
  ];
  const result = decideTick(config, batches);
  assert.equal(result.action, "advance");
  assert.equal(result.batch.id, "b2");
});

test("decideTick: a paused_for_review or failed batch blocks the queue -- never silently skipped to start the next approved batch", () => {
  const config = { automation_enabled: true };
  const batches = [
    { id: "b1", status: "paused_for_review", sequence_order: 1 },
    { id: "b2", status: "approved", sequence_order: 2 },
  ];
  const result = decideTick(config, batches);
  assert.equal(result.action, "noop");
  assert.equal(result.reason, "batch_paused_for_review");
  assert.equal(result.batch.id, "b1");
});

test("decideTick: with nothing in-flight and nothing paused, starts the lowest sequence_order approved batch", () => {
  const config = { automation_enabled: true };
  const batches = [
    { id: "b2", status: "approved", sequence_order: 2 },
    { id: "b1", status: "approved", sequence_order: 1 },
    { id: "b3", status: "completed", sequence_order: 0 },
  ];
  const result = decideTick(config, batches);
  assert.equal(result.action, "start_discovery");
  assert.equal(result.batch.id, "b1");
});

test("decideTick: an empty or fully-completed queue is a no-op", () => {
  const config = { automation_enabled: true };
  const batches = [{ id: "b1", status: "completed", sequence_order: 1 }];
  const result = decideTick(config, batches);
  assert.equal(result.action, "noop");
  assert.equal(result.reason, "queue_empty");
});

// --- evaluateValidation --------------------------------------------------

function node(name, status = "discovered") {
  return { node_name: name, status };
}

test("evaluateValidation: passes cleanly when every node discovered, zero leakage, normal blocklist rate", () => {
  const nodes = [node("Manchester"), node("Leeds")];
  const discoveredByNode = new Map([
    ["Manchester", { discovered: 27, eligible: 27, blocklisted: 0, fromOtherBatch: 0 }],
    ["Leeds", { discovered: 28, eligible: 25, blocklisted: 0, fromOtherBatch: 0 }],
  ]);
  const result = evaluateValidation(nodes, discoveredByNode);
  assert.equal(result.pass, true);
  assert.equal(result.details.totalDiscovered, 55);
});

test("evaluateValidation: any permanently failed node fails the batch outright", () => {
  const nodes = [node("Manchester"), node("Leeds", "failed")];
  const result = evaluateValidation(nodes, new Map());
  assert.equal(result.pass, false);
  assert.match(result.reason, /Leeds/);
});

test("evaluateValidation: leakage (eligible facilities attributable to a different batch's nodes) fails the batch -- this is the exact Phase 1 scenario (16 unrelated courses swept into one promotion)", () => {
  const nodes = [node("Stafford"), node("Derby")];
  const discoveredByNode = new Map([
    ["Stafford", { discovered: 20, eligible: 20, blocklisted: 0, fromOtherBatch: 0 }],
    ["Derby", { discovered: 25, eligible: 25, blocklisted: 0, fromOtherBatch: 16 }],
  ]);
  const result = evaluateValidation(nodes, discoveredByNode);
  assert.equal(result.pass, false);
  assert.match(result.reason, /different batch/);
  assert.equal(result.details.leakage, 16);
});

test("evaluateValidation: an abnormally high blocklist rate (e.g. a node centred on the wrong kind of area) pauses for review", () => {
  const nodes = [node("Weird Node")];
  const discoveredByNode = new Map([
    ["Weird Node", { discovered: 10, eligible: 4, blocklisted: 6, fromOtherBatch: 0 }],
  ]);
  const result = evaluateValidation(nodes, discoveredByNode);
  assert.equal(result.pass, false);
  assert.match(result.reason, /blocklist rate/);
});

// --- shouldRetryNode ------------------------------------------------------

test("shouldRetryNode: retries while under the configured max, stops at it", () => {
  assert.equal(shouldRetryNode({ retry_count: 0 }, 2), true);
  assert.equal(shouldRetryNode({ retry_count: 1 }, 2), true);
  assert.equal(shouldRetryNode({ retry_count: 2 }, 2), false);
  assert.equal(shouldRetryNode({ retry_count: 5 }, 2), false);
});

// --- classifyImportResults ------------------------------------------------

test("classifyImportResults: distinguishes genuine no-availability from a scraper failure and from a course never attempted", () => {
  const summary = {
    courses: [
      { course: "Derby Golf Course", ok: true, extractedCount: 12, error: null },
      { course: "Chevin Golf Club", ok: true, extractedCount: 0, error: null },
      { course: "Mickleover Golf Club", ok: false, extractedCount: 0, error: "Timeout" },
    ],
  };
  const result = classifyImportResults(summary, [
    "Derby Golf Course",
    "Chevin Golf Club",
    "Mickleover Golf Club",
    "Ashbourne Golf Club", // not in the summary at all
  ]);

  assert.equal(result.hasInventoryCount, 1);
  assert.equal(result.noAvailabilityCount, 1);
  assert.equal(result.failureCount, 2); // Mickleover (scraper_failure) + Ashbourne (not_attempted)

  const byName = new Map(result.results.map((r) => [r.course, r.state]));
  assert.equal(byName.get("Derby Golf Course"), "has_inventory");
  assert.equal(byName.get("Chevin Golf Club"), "no_availability");
  assert.equal(byName.get("Mickleover Golf Club"), "scraper_failure");
  assert.equal(byName.get("Ashbourne Golf Club"), "not_attempted");
});

test("classifyImportResults: name matching is case/whitespace insensitive", () => {
  const summary = { courses: [{ course: "  Derby Golf Course  ", ok: true, extractedCount: 3, error: null }] };
  const result = classifyImportResults(summary, ["derby golf course"]);
  assert.equal(result.results[0].state, "has_inventory");
});

// --- coordKey --------------------------------------------------------------

test("coordKey: stable, numeric-normalised key so '52.80' and 52.8 (string vs number from different sources) match", () => {
  assert.equal(coordKey("52.8067", "-2.1174"), coordKey(52.8067, -2.1174));
});
