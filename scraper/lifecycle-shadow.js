// BRS/IG lifecycle shadow-mode computation — pure functions, no I/O.
//
// Shadow mode NEVER touches tee_times. It only computes, for a course
// currently in lifecycle_pilot_state = 'shadow', what the stable-identity
// rows and the reconciliation deactivation list WOULD be, so they can be
// logged to reconciliation_shadow_log for inspection. The scraper's real,
// unchanged legacy-format rows are what actually get ingested, exactly as
// before this module existed — this file adds a second, parallel, and
// strictly read-only computation, not a replacement path.
//
// Mirrors the "stable:" namespace and identity contract already migrated
// and tested in supabase/functions/_shared/lifecycle-identity.ts:
//   BRS:  stable:{providerCourseId}:{slotDate}:{providerSlotId}
//   IG:   stable:{providerCourseId}:{slotDate}:{slotTime}

function buildStableExternalIdBrs(providerCourseId, slotDate, providerSlotId) {
  return `stable:${providerCourseId}:${slotDate}:${providerSlotId}`;
}

function buildStableExternalIdIg(providerCourseId, slotDate, slotTime) {
  return `stable:${providerCourseId}:${slotDate}:${slotTime}`;
}

// IG snapshot-completeness heuristic for shadow mode only (never used by
// the existing legacy extraction/ingestion path, which is unchanged).
// Confirmed during investigation: an unauthenticated/tokenless request to
// IG's date-switch mechanism returns a real "Login Required" page rather
// than an error status, so a title/body match on that phrase is the
// concrete, observed signal for "untrusted, do not treat as complete" —
// deliberately conservative: absence of that marker is NOT by itself
// treated as proof of completeness, since only slotDate detection plus
// the absence of a login-wall marker together indicate a genuinely
// rendered teesheet page. Anything else (no slotDate, or a login-wall
// marker present) fails closed.
function isIgSnapshotComplete(bodyText, title, slotDate) {
  const text = String(bodyText || "");
  const pageTitle = String(title || "");
  const looksLikeLoginWall =
    /login required/i.test(text) || /login required/i.test(pageTitle);
  return Boolean(slotDate) && !looksLikeLoginWall;
}

// ---------------------------------------------------------------------------
// BRS
// ---------------------------------------------------------------------------
//
// Snapshot-completeness rule (matches the BRS teesheet API evidence
// gathered during investigation): a response only counts as a complete,
// trustworthy snapshot for the requested date if it parsed as the expected
// JSON shape AND its own `tee_date` field echoes back the date that was
// actually requested. Anything else (error body, missing tee_date, a
// tee_date that doesn't match, or no response object at all) is NOT a
// snapshot reconciliation may be proposed from — fail closed, propose
// nothing, and say why.

function isBrsSnapshotComplete(teesheetResponse, requestedSlotDate) {
  if (!teesheetResponse || typeof teesheetResponse !== "object") return false;
  const data = teesheetResponse.data;
  if (!data || typeof data !== "object") return false;
  if (!Array.isArray(data.tee_times)) return false;
  if (data.tee_date !== requestedSlotDate) return false;
  if (teesheetResponse.message || teesheetResponse.code) return false;
  return true;
}

// teesheetTeeTimes: the raw `data.tee_times` array from BRS's own API shape
// (each item: { id, time, green_fees: [{ green_fee1_ball, ... }] }).
// currentActiveLegacyExternalIds: external_ids of tee_times rows currently
// active in the database for this course+date under the LEGACY scheme —
// supplied by the caller (read via a normal select before this runs);
// this module never queries the database itself.
function computeBrsShadowProposal({
  providerCourseId,
  slotDate,
  teesheetResponse,
  currentActiveLegacyExternalIds,
}) {
  const snapshotComplete = isBrsSnapshotComplete(teesheetResponse, slotDate);

  if (!snapshotComplete) {
    return {
      snapshotComplete: false,
      proposedStableExternalIds: [],
      wouldDeactivateLegacyExternalIds: [],
      rejected: true,
      rejectReason: "brs_snapshot_not_proven_complete",
    };
  }

  const teeTimes = teesheetResponse.data.tee_times;

  const proposedStableExternalIds = teeTimes.map((slot) =>
    buildStableExternalIdBrs(providerCourseId, slotDate, slot.id)
  );

  // A legacy row "would be deactivated" if reconciliation ran: every
  // currently-active legacy row for this course+date, since a complete
  // fresh snapshot supersedes all of them regardless of which specific
  // physical slots it does or doesn't still contain (mirrors
  // stable_transition's own real deactivation scope: course+date, not a
  // slot-by-slot diff).
  const wouldDeactivateLegacyExternalIds = [...(currentActiveLegacyExternalIds || [])];

  return {
    snapshotComplete: true,
    proposedStableExternalIds,
    wouldDeactivateLegacyExternalIds,
    rejected: false,
    rejectReason: null,
  };
}

// ---------------------------------------------------------------------------
// Intelligent Golf
// ---------------------------------------------------------------------------
//
// Stricter rule than BRS, per the earlier investigation: IG has no
// structural "echoes the request back" signal to trust the way BRS's
// tee_date does. An unrecognised, empty, error, or login-wall response
// must NEVER be treated as a genuine empty snapshot — only an explicitly
// marked-complete extraction (the caller asserts this from real page
// structure: expected teesheet markers present, no login-wall markers) may
// have reconciliation proposed from it, and even then, a snapshot that
// maps two different extracted rows to the SAME proposed stable identity
// (same course+date+time, i.e. the same physical slot appearing twice in
// the same batch) is a data-quality problem, not a reconciliation input —
// fail closed rather than guess which one is real.

function computeIgShadowProposal({
  providerCourseId,
  slotDate,
  snapshotComplete, // caller-asserted: real page markers present, no login-wall
  extractedRows, // [{ slotTime, price }] — as IG's own extraction already produces
  currentActiveLegacyExternalIds,
}) {
  if (!snapshotComplete) {
    return {
      snapshotComplete: false,
      proposedStableExternalIds: [],
      wouldDeactivateLegacyExternalIds: [],
      rejected: true,
      rejectReason: "ig_snapshot_not_proven_complete",
    };
  }

  const idsByTime = new Map();
  const collisions = new Set();
  for (const row of extractedRows || []) {
    const id = buildStableExternalIdIg(providerCourseId, slotDate, row.slotTime);
    if (idsByTime.has(id)) collisions.add(id);
    idsByTime.set(id, true);
  }

  if (collisions.size > 0) {
    return {
      snapshotComplete: true,
      proposedStableExternalIds: [],
      wouldDeactivateLegacyExternalIds: [],
      rejected: true,
      rejectReason: "ig_identity_collision",
      collidingIdentities: Array.from(collisions),
    };
  }

  const proposedStableExternalIds = Array.from(idsByTime.keys());
  const wouldDeactivateLegacyExternalIds = [...(currentActiveLegacyExternalIds || [])];

  return {
    snapshotComplete: true,
    proposedStableExternalIds,
    wouldDeactivateLegacyExternalIds,
    rejected: false,
    rejectReason: null,
  };
}

// ---------------------------------------------------------------------------
// I/O helpers — deliberately kept here rather than in the Playwright-based
// scraper entry files, so they carry no dependency on Playwright and can be
// exercised directly (including in local testing) without launching a
// browser. Each takes its Supabase config explicitly rather than reading
// module-level environment constants, so callers (and tests) control it.
// ---------------------------------------------------------------------------

async function fetchActiveLegacyExternalIds(config, providerCourseId, slotDate) {
  const url =
    `${config.supabaseUrl}/rest/v1/tee_times` +
    `?select=external_id` +
    `&source=eq.manual_import` +
    `&provider_course_id=eq.${encodeURIComponent(providerCourseId)}` +
    `&slot_date=eq.${slotDate}` +
    `&is_active=eq.true` +
    `&external_id=not.like.stable:*`;

  const response = await fetch(url, {
    headers: {
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    },
  });
  if (!response.ok) return [];
  const rows = await response.json();
  return rows.map((r) => r.external_id);
}

// Deliberately does NOT touch tee_times — the only table this ever writes
// to is reconciliation_shadow_log, via ingest-tee-times's shadow_proposal
// handling (see supabase/functions/ingest-tee-times/index.ts).
async function sendShadowProposal(config, courseConfig, slotDate, proposal, scraperRunId) {
  const payload = {
    source_key: "manual_import",
    rows: [],
    shadow_proposal: {
      course_id: courseConfig.id,
      provider_course_id: courseConfig.providerCourseId,
      slot_date: slotDate,
      scraper_run_id: scraperRunId,
      snapshot_complete: proposal.snapshotComplete,
      proposed_stable_external_ids: proposal.proposedStableExternalIds,
      would_deactivate_legacy_external_ids: proposal.wouldDeactivateLegacyExternalIds,
      rejected: proposal.rejected,
      reject_reason: proposal.rejectReason,
      colliding_identities: proposal.collidingIdentities || [],
    },
  };

  const response = await fetch(
    `${config.supabaseUrl}/functions/v1/ingest-tee-times`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-import-secret": config.manualImportSecret,
        "x-correlation-id": config.correlationId,
        "x-scraper-run-id": scraperRunId,
      },
      body: JSON.stringify(payload),
    },
  );
  const responseText = await response.text();
  return { status: response.status, body: responseText };
}

// BRS's visitor-booking SPA (visitors.brsgolf.com/<club-slug>) is
// multi-tenant: every API call, including course discovery, must carry
// an `X-Club-Id: <club-slug>` header or the API cannot identify which
// club's data to return at all (confirmed against production: identical
// request without this header returns 500 for every real club tested,
// regardless of course_id). This was the actual root cause of every BRS
// club's shadow snapshot coming back incomplete in production, not the
// course_id value — course_id=1 already worked once the header was
// added. Deliberately never guessed/hardcoded per club: the correct
// club-id is always derivable from the club's own target_url path.
function deriveBrsClubSlug(targetUrl) {
  try {
    const url = new URL(targetUrl);
    const slug = url.pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
    return slug || null;
  } catch {
    return null;
  }
}

// Discovers the correct BRS-internal course_id for a club via the same
// /api/courses/all endpoint the real visitor-booking SPA itself calls —
// never a maintained manual mapping. Confirmed against 9 real production
// BRS clubs: every club has at least one course, and id 1 is present in
// 100% of them — for a single-course club it's trivially the only
// course; for a multi-course (shotgun-start) club it's consistently the
// named "1st Tee" alongside a "10th"/"9th Tee" alternate, i.e. the
// conventional default visitor teesheet. That is the ONLY multi-course
// case this treats as resolved — if a club returns more than one course
// and none of them is id 1, which course_id to use is genuinely
// ambiguous and there is no evidence-based way to pick one, so this
// fails closed (returns null) rather than guessing. Any network error,
// non-200 response, empty body, or malformed/non-array JSON also fails
// closed the same way.
async function discoverBrsCourseId(courseConfig) {
  const clubSlug = deriveBrsClubSlug(courseConfig.targetUrl);
  if (!clubSlug) return null;

  let origin;
  try {
    origin = new URL(courseConfig.targetUrl).origin;
  } catch {
    return null;
  }

  let response;
  try {
    response = await fetch(`${origin}/api/courses/all`, {
      headers: { "X-Requested-With": "XMLHttpRequest", "X-Club-Id": clubSlug },
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let courses;
  try {
    const text = await response.text();
    courses = JSON.parse(text);
  } catch {
    return null;
  }

  if (!Array.isArray(courses) || courses.length === 0) return null;

  if (courses.length === 1) {
    const onlyId = courses[0]?.id;
    return Number.isInteger(onlyId) ? onlyId : null;
  }

  const hasCourseOne = courses.some((c) => c && c.id === 1);
  return hasCourseOne ? 1 : null;
}

async function fetchBrsTeesheetJson(courseConfig, slotDate) {
  const clubSlug = deriveBrsClubSlug(courseConfig.targetUrl);
  if (!clubSlug) return null;

  const courseId = await discoverBrsCourseId(courseConfig);
  if (courseId === null) return null;

  let origin;
  try {
    origin = new URL(courseConfig.targetUrl).origin;
  } catch {
    return null;
  }

  let response;
  try {
    response = await fetch(
      `${origin}/api/casualBooking/teesheet?date=${slotDate}&course_id=${courseId}`,
      { headers: { "X-Requested-With": "XMLHttpRequest", "X-Club-Id": clubSlug } },
    );
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function runBrsShadowProposalForCourse(config, courseConfig, slotDate, scraperRunId, teesheetJsonOverride) {
  if (courseConfig.lifecyclePilotState !== "shadow") return null;

  const teesheetJson = teesheetJsonOverride ?? await fetchBrsTeesheetJson(courseConfig, slotDate);
  const currentActiveLegacyExternalIds = await fetchActiveLegacyExternalIds(
    config,
    courseConfig.providerCourseId,
    slotDate,
  );

  const proposal = computeBrsShadowProposal({
    providerCourseId: courseConfig.providerCourseId,
    slotDate,
    teesheetResponse: teesheetJson,
    currentActiveLegacyExternalIds,
  });

  await sendShadowProposal(config, courseConfig, slotDate, proposal, scraperRunId);
  return proposal;
}

async function runIgShadowProposalForCourse(config, courseConfig, slotDate, scraperRunId, snapshotComplete, extractedRowsForShadow) {
  if (courseConfig.lifecyclePilotState !== "shadow") return null;

  const currentActiveLegacyExternalIds = await fetchActiveLegacyExternalIds(
    config,
    courseConfig.providerCourseId,
    slotDate,
  );

  const proposal = computeIgShadowProposal({
    providerCourseId: courseConfig.providerCourseId,
    slotDate,
    snapshotComplete,
    extractedRows: extractedRowsForShadow,
    currentActiveLegacyExternalIds,
  });

  await sendShadowProposal(config, courseConfig, slotDate, proposal, scraperRunId);
  return proposal;
}

// ---------------------------------------------------------------------------
// Active ingestion (stable_active / stable_reconciling) — builds FULL
// stable-scheme rows (not just identity strings) and sends them through
// the fenced lifecycle RPC, never the unfenced legacy path. No legacy
// identity is ever built or sent for a course in either of these states.
// ---------------------------------------------------------------------------

function buildBrsStableRows(courseConfig, slotDate, teesheetResponse) {
  if (!isBrsSnapshotComplete(teesheetResponse, slotDate)) return null;
  return teesheetResponse.data.tee_times.map((slot) => {
    const priceText = slot.green_fees?.[0]?.green_fee1_ball;
    const price = priceText ? Math.round(Number(priceText)) : null;
    return {
      source: "manual_import",
      external_id: buildStableExternalIdBrs(courseConfig.providerCourseId, slotDate, slot.id),
      provider_course_id: courseConfig.providerCourseId,
      course_name: courseConfig.courseName,
      slot_date: slotDate,
      slot_time: slot.time,
      price,
      players: 4,
      holes: 18,
      booking_url: courseConfig.targetUrl,
      fetched_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      last_seen_run_id: null,
      is_active: true,
      raw_payload: { provider_slot_id: slot.id },
    };
  });
}

// Returns { rows, collision } — rows is null when the snapshot itself is
// untrusted OR a genuine identity collision was found (fail closed either
// way; the caller must not fall back to ingesting anything in that case).
function buildIgStableRows(courseConfig, slotDate, snapshotComplete, extractedRows) {
  if (!snapshotComplete) return { rows: null, collision: false };

  const seen = new Map();
  for (const row of extractedRows || []) {
    const id = buildStableExternalIdIg(courseConfig.providerCourseId, slotDate, row.slotTime);
    if (seen.has(id)) return { rows: null, collision: true };
    seen.set(id, row);
  }

  const rows = Array.from(seen.entries()).map(([externalId, row]) => ({
    source: "manual_import",
    external_id: externalId,
    provider_course_id: courseConfig.providerCourseId,
    course_name: courseConfig.courseName,
    slot_date: slotDate,
    slot_time: row.slotTime,
    price: row.price,
    players: 4,
    holes: 18,
    booking_url: courseConfig.targetUrl,
    fetched_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    last_seen_run_id: null,
    is_active: true,
    raw_payload: {},
  }));

  return { rows, collision: false };
}

// ---------------------------------------------------------------------------
// Snapshot-token ordering — replaces the earlier two-call fenced-ingestion
// + reconcile_request pattern above. That pattern fenced only on
// lifecycle_generation/lifecycle_pilot_state, neither of which changes
// between two ordinary scrapes of the same course in the same state, so a
// stale (older) scrape applied after a newer one could silently overwrite
// it — reproduced and confirmed for both a price-revert (stable_active)
// and a wrongful reconciliation deactivation (stable_reconciling).
//
// begin_lifecycle_snapshot issues a database-issued, monotonically
// increasing token BEFORE the provider network request — never a client
// timestamp — and mutates nothing. apply_lifecycle_snapshot, called after
// the provider fetch completes, is the single atomic write: it rejects
// the whole call with zero mutation if the supplied token is not strictly
// newer than the latest token *actually applied* for that exact
// (course, slot_date), so a stale scrape can never overwrite a newer one
// regardless of arrival order.

async function begin_or_applyRpc(config, fn, args) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function beginLifecycleSnapshot(config, courseConfig, slotDate) {
  return begin_or_applyRpc(config, "begin_lifecycle_snapshot", {
    p_course_id: courseConfig.id,
    p_slot_date: slotDate,
    p_expected_generation: courseConfig.lifecycleGeneration,
    p_expected_lifecycle_state: courseConfig.lifecyclePilotState,
  });
}

async function applyLifecycleSnapshot(config, courseConfig, slotDate, snapshotToken, snapshotComplete, rows) {
  return begin_or_applyRpc(config, "apply_lifecycle_snapshot", {
    p_course_id: courseConfig.id,
    p_provider_course_id: courseConfig.providerCourseId,
    p_slot_date: slotDate,
    p_snapshot_token: snapshotToken,
    p_expected_generation: courseConfig.lifecycleGeneration,
    p_expected_lifecycle_state: courseConfig.lifecyclePilotState,
    p_snapshot_complete: snapshotComplete,
    p_rows: rows,
    p_environment: config.environment || "production",
    p_correlation_id: config.correlationId,
    p_source_name: "manual_import",
    p_scraper_run_id: config.scraperRunId ?? null,
  });
}

// courseConfig.lifecyclePilotState must be 'stable_active' or
// 'stable_reconciling'. Obtains the snapshot token BEFORE fetching BRS's
// teesheet, per the required begin -> fetch -> apply ordering.
async function runBrsSnapshotIngestion(config, courseConfig, slotDate) {
  const begin = await beginLifecycleSnapshot(config, courseConfig, slotDate);
  if (!begin.body?.ok) {
    return { sent: false, reason: "begin_snapshot_rejected", begin };
  }

  const teesheetResponse = await fetchBrsTeesheetJson(courseConfig, slotDate);
  const rows = buildBrsStableRows(courseConfig, slotDate, teesheetResponse);
  if (rows === null) {
    return { sent: false, reason: "snapshot_not_complete", begin };
  }

  const result = await applyLifecycleSnapshot(config, courseConfig, slotDate, begin.body.snapshot_token, true, rows);
  return { sent: true, rows, begin, result };
}

// courseConfig.lifecyclePilotState must be 'stable_active' or
// 'stable_reconciling'. The token must already have been obtained by the
// caller BEFORE the Playwright page navigation (IG's provider network
// request) — this function only builds rows from the already-completed
// extraction and applies the snapshot; it never issues the token itself,
// since issuing must happen strictly before the provider fetch and this
// function only runs after it.
async function applyIgSnapshotIngestion(config, courseConfig, slotDate, snapshotToken, snapshotComplete, extractedRows) {
  const { rows, collision } = buildIgStableRows(courseConfig, slotDate, snapshotComplete, extractedRows);
  if (collision) {
    return { sent: false, reason: "ig_identity_collision" };
  }
  if (rows === null) {
    return { sent: false, reason: "snapshot_not_complete" };
  }

  const result = await applyLifecycleSnapshot(config, courseConfig, slotDate, snapshotToken, true, rows);
  return { sent: true, rows, result };
}

module.exports = {
  buildStableExternalIdBrs,
  buildStableExternalIdIg,
  isBrsSnapshotComplete,
  isIgSnapshotComplete,
  computeBrsShadowProposal,
  computeIgShadowProposal,
  fetchActiveLegacyExternalIds,
  sendShadowProposal,
  deriveBrsClubSlug,
  discoverBrsCourseId,
  fetchBrsTeesheetJson,
  runBrsShadowProposalForCourse,
  runIgShadowProposalForCourse,
  buildBrsStableRows,
  buildIgStableRows,
  beginLifecycleSnapshot,
  applyLifecycleSnapshot,
  runBrsSnapshotIngestion,
  applyIgSnapshotIngestion,
};
