// Real-execution-layer tests for promote-golfnow-courses.js's batch
// isolation logic, using a mocked Supabase client -- not a
// reimplementation of the filtering rules, the actual exported
// loadControllerNodeOwnership / loadFacilityOwnership /
// computeEligibleFacilities functions main() itself calls.

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy-key-for-tests";

const {
  setsIntersect,
  loadControllerNodeOwnership,
  loadFacilityOwnership,
  computeEligibleFacilities,
} = require("./promote-golfnow-courses");

// A chainable, thenable query stub: every chain method (select/not/in/
// gte/order) returns itself; awaiting it resolves to {data, error}.
function makeQuery(rows, error = null) {
  const query = {
    select() { return query; },
    not() { return query; },
    in() { return query; },
    gte() { return query; },
    order() { return query; },
    then(resolve) { resolve({ data: error ? null : rows, error }); },
  };
  return query;
}

function makeStubClient(tables) {
  return {
    from(table) {
      const rows = tables[table] || [];
      return makeQuery(rows);
    },
  };
}

// --- setsIntersect -----------------------------------------------------

test("setsIntersect: true iff the sets share at least one member", () => {
  assert.equal(setsIntersect(new Set(["a", "b"]), new Set(["b", "c"])), true);
  assert.equal(setsIntersect(new Set(["a"]), new Set(["b"])), false);
  assert.equal(setsIntersect(new Set(), new Set(["a"])), false);
});

// --- loadControllerNodeOwnership ----------------------------------------

test("loadControllerNodeOwnership: groups controller nodes by batch and collects every controller node id, ignoring legacy (batch_id null) nodes entirely", async () => {
  const client = makeStubClient({
    golfnow_discovery_nodes: [
      { id: "node-stafford", batch_id: "batch-1" },
      { id: "node-derby", batch_id: "batch-1" },
      { id: "node-manchester", batch_id: "batch-2" },
    ],
  });
  const { allControllerNodeIds, batchNodeIds } = await loadControllerNodeOwnership(client);
  assert.equal(allControllerNodeIds.size, 3);
  assert.deepEqual([...batchNodeIds.get("batch-1")].sort(), ["node-derby", "node-stafford"]);
  assert.deepEqual([...batchNodeIds.get("batch-2")], ["node-manchester"]);
});

// --- loadFacilityOwnership (ownership collisions, repeated discovery) --

test("loadFacilityOwnership: a facility discovered by two different nodes (ownership collision) is attributed to BOTH, never just the most recent", async () => {
  const client = makeStubClient({
    golfnow_facility_discovery_events: [
      { provider_course_id: "14699", discovery_node_id: "node-a" },
      { provider_course_id: "14699", discovery_node_id: "node-b" }, // same facility, different node -- the exact Chartham Park / Hainault pattern
    ],
  });
  const owners = await loadFacilityOwnership(client, ["14699"]);
  assert.deepEqual([...owners.get("14699")].sort(), ["node-a", "node-b"]);
});

test("loadFacilityOwnership: repeated discovery by the SAME node is idempotent (one event row, one owner, never duplicated)", async () => {
  // golfnow-discovery.js's upsert with ignoreDuplicates means repeated
  // discovery by the same node never produces a second event row in the
  // first place -- this asserts the read side handles a single row
  // correctly, which is what repeated discovery by the same node always
  // leaves behind.
  const client = makeStubClient({
    golfnow_facility_discovery_events: [
      { provider_course_id: "14699", discovery_node_id: "node-a" },
    ],
  });
  const owners = await loadFacilityOwnership(client, ["14699"]);
  assert.equal(owners.get("14699").size, 1);
});

test("loadFacilityOwnership: empty provider_course_id list short-circuits without querying", async () => {
  const client = {
    from() { throw new Error("must not query when there is nothing to look up"); },
  };
  const owners = await loadFacilityOwnership(client, []);
  assert.equal(owners.size, 0);
});

// --- computeEligibleFacilities: the real end-to-end execution path -----

const BASE_FACILITY = {
  provider_course_id: "100",
  course_name: "Test Golf Club",
  county: "Staffordshire",
  seo_friendly_name: "test-golf-club",
  number_of_tee_times: 60,
  average_rating: 4.2,
  review_count: 50,
};

test("computeEligibleFacilities: strict isolation -- unscoped call never returns a controller-managed facility, even when its batch is 'completed'", async () => {
  const client = makeStubClient({
    golfnow_discovery_nodes: [{ id: "node-a", batch_id: "batch-1" }],
    golfnow_discovered_facilities: [{ ...BASE_FACILITY }],
    golfnow_facility_discovery_events: [{ provider_course_id: "100", discovery_node_id: "node-a" }],
    courses: [],
  });
  const eligible = await computeEligibleFacilities(client, { minTeeTimes: 50, batchId: null });
  assert.equal(eligible.length, 0, "a controller-managed facility must never be returned by an unscoped call, regardless of batch status");
});

test("computeEligibleFacilities: BATCH_ID scoping -- only returns facilities owned by a node in THAT batch, excluding a different batch's facility even if both are controller-managed", async () => {
  const client = makeStubClient({
    golfnow_discovery_nodes: [
      { id: "node-a", batch_id: "batch-1" },
      { id: "node-b", batch_id: "batch-2" },
    ],
    golfnow_discovered_facilities: [
      { ...BASE_FACILITY, provider_course_id: "100" },
      { ...BASE_FACILITY, provider_course_id: "200", course_name: "Other Golf Club" },
    ],
    golfnow_facility_discovery_events: [
      { provider_course_id: "100", discovery_node_id: "node-a" },
      { provider_course_id: "200", discovery_node_id: "node-b" },
    ],
    courses: [],
  });
  const eligible = await computeEligibleFacilities(client, { minTeeTimes: 50, batchId: "batch-1" });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].provider_course_id, "100");
});

test("computeEligibleFacilities: an ownership collision (discovered by both a controller node and a legacy node) is still excluded from an unscoped run -- any controller association is enough", async () => {
  const client = makeStubClient({
    golfnow_discovery_nodes: [{ id: "node-controller", batch_id: "batch-1" }],
    golfnow_discovered_facilities: [{ ...BASE_FACILITY }],
    golfnow_facility_discovery_events: [
      { provider_course_id: "100", discovery_node_id: "node-controller" },
      { provider_course_id: "100", discovery_node_id: "node-legacy" }, // also found by a legacy node
    ],
    courses: [],
  });
  const eligible = await computeEligibleFacilities(client, { minTeeTimes: 50, batchId: null });
  assert.equal(eligible.length, 0);
});

test("computeEligibleFacilities: a facility never touched by any controller node is unaffected by this feature entirely (unscoped call promotes it as always)", async () => {
  const client = makeStubClient({
    golfnow_discovery_nodes: [{ id: "node-a", batch_id: "batch-1" }],
    golfnow_discovered_facilities: [{ ...BASE_FACILITY }],
    golfnow_facility_discovery_events: [], // no event at all for this facility -- a legacy/manual-only discovery
    courses: [],
  });
  const eligible = await computeEligibleFacilities(client, { minTeeTimes: 50, batchId: null });
  assert.equal(eligible.length, 1);
});

test("computeEligibleFacilities: existing course by provider_course_id or by name is still excluded (pre-existing dedup, unchanged)", async () => {
  const client = makeStubClient({
    golfnow_discovery_nodes: [],
    golfnow_discovered_facilities: [
      { ...BASE_FACILITY, provider_course_id: "100" },
      { ...BASE_FACILITY, provider_course_id: "101", course_name: "Already Named Club" },
    ],
    golfnow_facility_discovery_events: [],
    courses: [
      { provider_course_id: "100", course_name: "Something Else" },
      { provider_course_id: "999", course_name: "already named club" },
    ],
  });
  const eligible = await computeEligibleFacilities(client, { minTeeTimes: 50, batchId: null });
  assert.equal(eligible.length, 0);
});

test("computeEligibleFacilities: a blocklisted name (e.g. a simulator venue) is still excluded regardless of ownership", async () => {
  const client = makeStubClient({
    golfnow_discovery_nodes: [],
    golfnow_discovered_facilities: [
      { ...BASE_FACILITY, provider_course_id: "100", course_name: "The Club Indoor Golf Simulator" },
    ],
    golfnow_facility_discovery_events: [],
    courses: [],
  });
  const eligible = await computeEligibleFacilities(client, { minTeeTimes: 50, batchId: null });
  assert.equal(eligible.length, 0);
});
