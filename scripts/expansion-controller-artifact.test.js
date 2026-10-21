// Regression coverage for buildGithubClient().downloadSummaryArtifact --
// the REAL zip-extraction implementation, not a mock. Controller run #39
// crashed with "Error: spawnSync unzip ENOBUFS" while verifying a
// large import (465 courses, 17,124 extracted rows): the original code
// read the archive via `execFileSync("unzip", ["-p", ...])`, which
// captures the child process's stdout into a buffer bounded by Node's
// default 1MB maxBuffer -- once summary.json exceeded that, execFileSync
// threw ENOBUFS and the whole controller tick crashed instead of the
// batch being paused for review like every other verification failure.
//
// The fix extracts to disk (-d) instead of capturing stdout, so there is
// no maxBuffer ceiling, and adds its OWN explicit, documented size limit
// (MAX_SUMMARY_ARTIFACT_BYTES) so a corrupted or runaway artifact still
// fails closed (null -> pauseBatch) rather than reading an unbounded
// amount into memory. These tests build REAL zip fixtures with the
// system `zip` binary and drive the REAL function end-to-end (fetch
// mocked, nothing else), so a regression back to the captured-stdout
// approach would fail test 2 below exactly as it failed in production.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { buildGithubClient } = require("./expansion-controller");

const RUN_ID = 39; // the actual run number this bug was found on

function buildArtifactZip(entries) {
  // entries: { [fileName]: content }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-fixture-"));
  const zipPath = path.join(dir, "artifact.zip");
  const fileNames = [];
  for (const [name, content] of Object.entries(entries)) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    fileNames.push(name);
  }
  execFileSync("zip", ["-q", "-j", zipPath, ...fileNames], { cwd: dir });
  const buffer = fs.readFileSync(zipPath);
  fs.rmSync(dir, { recursive: true, force: true });
  return buffer;
}

function mockFetchForArtifact(zipBuffer, { artifactName = "golfnow-import-output" } = {}) {
  return async (url) => {
    if (String(url).includes("/artifacts") && !String(url).includes("download")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          artifacts: [{ name: artifactName, archive_download_url: "https://example.com/download/fake.zip" }],
        }),
      };
    }
    if (String(url) === "https://example.com/download/fake.zip") {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength),
      };
    }
    throw new Error(`Unexpected fetch call in test: ${url}`);
  };
}

test("downloadSummaryArtifact: a normal-sized summary.json is read and parsed correctly", async (t) => {
  const summary = { mode: "golfnow_import", courses: [{ course: "A", ok: true, extractedCount: 3 }] };
  const zip = buildArtifactZip({ "summary.json": JSON.stringify(summary) });

  const originalFetch = global.fetch;
  global.fetch = mockFetchForArtifact(zip);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const gh = buildGithubClient({ token: "test-token", repository: "OpenTees/opentees_scraper" });
  const result = await gh.downloadSummaryArtifact(RUN_ID);
  assert.deepEqual(result, summary);
});

test("downloadSummaryArtifact: a large summary.json (over the OLD 1MB execFileSync maxBuffer, under the new documented limit) is read correctly -- the exact regression run #39 hit", async (t) => {
  // 465 courses / 17,124 rows in production produced a summary.json over
  // 1MB. Build one comfortably past that threshold (~3MB) to prove the
  // fix, without approaching the new 50MB ceiling.
  const padding = "x".repeat(3 * 1024 * 1024);
  const summary = {
    mode: "golfnow_import",
    totalCourses: 465,
    successfulCourses: 425,
    failedCourses: 40,
    totalRowsExtracted: 17124,
    padding,
  };
  const zip = buildArtifactZip({ "summary.json": JSON.stringify(summary) });

  const originalFetch = global.fetch;
  global.fetch = mockFetchForArtifact(zip);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const gh = buildGithubClient({ token: "test-token", repository: "OpenTees/opentees_scraper" });
  const result = await gh.downloadSummaryArtifact(RUN_ID);
  assert.equal(result.totalCourses, 465);
  assert.equal(result.totalRowsExtracted, 17124);
  assert.equal(result.padding, padding);
});

test("downloadSummaryArtifact: a summary.json past the documented size limit fails closed (null), never throws or reads it anyway", async (t) => {
  const oversized = "x".repeat(51 * 1024 * 1024); // past the 50MB bound
  const zip = buildArtifactZip({ "summary.json": oversized });

  const originalFetch = global.fetch;
  global.fetch = mockFetchForArtifact(zip);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const gh = buildGithubClient({ token: "test-token", repository: "OpenTees/opentees_scraper" });
  const result = await gh.downloadSummaryArtifact(RUN_ID);
  assert.equal(result, null, "must return null (-> pauseBatch) rather than throw or silently truncate");
});

test("downloadSummaryArtifact: malformed (non-JSON) summary.json content fails closed (null), never throws", async (t) => {
  const zip = buildArtifactZip({ "summary.json": "{ this is not valid JSON" });

  const originalFetch = global.fetch;
  global.fetch = mockFetchForArtifact(zip);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const gh = buildGithubClient({ token: "test-token", repository: "OpenTees/opentees_scraper" });
  const result = await gh.downloadSummaryArtifact(RUN_ID);
  assert.equal(result, null);
});

test("downloadSummaryArtifact: an artifact zip that doesn't actually contain summary.json fails closed (null), never throws", async (t) => {
  const zip = buildArtifactZip({ "other-file.txt": "not what we're looking for" });

  const originalFetch = global.fetch;
  global.fetch = mockFetchForArtifact(zip);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const gh = buildGithubClient({ token: "test-token", repository: "OpenTees/opentees_scraper" });
  const result = await gh.downloadSummaryArtifact(RUN_ID);
  assert.equal(result, null);
});

test("downloadSummaryArtifact: a genuinely corrupt (not-a-zip) artifact fails closed (null), never throws", async (t) => {
  const zip = Buffer.from("this is not a zip file at all");

  const originalFetch = global.fetch;
  global.fetch = mockFetchForArtifact(zip);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const gh = buildGithubClient({ token: "test-token", repository: "OpenTees/opentees_scraper" });
  const result = await gh.downloadSummaryArtifact(RUN_ID);
  assert.equal(result, null);
});

test("downloadSummaryArtifact: no golfnow-import-output artifact on the run returns null without ever attempting a download", async (t) => {
  const originalFetch = global.fetch;
  let downloadAttempted = false;
  global.fetch = async (url) => {
    if (String(url).includes("/artifacts")) {
      return { ok: true, status: 200, json: async () => ({ artifacts: [{ name: "some-other-artifact", archive_download_url: "https://example.com/x.zip" }] }) };
    }
    downloadAttempted = true;
    throw new Error("should never reach here");
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const gh = buildGithubClient({ token: "test-token", repository: "OpenTees/opentees_scraper" });
  const result = await gh.downloadSummaryArtifact(RUN_ID);
  assert.equal(result, null);
  assert.equal(downloadAttempted, false);
});

test("downloadSummaryArtifact: an HTTP failure downloading the archive itself still throws (unchanged, pre-existing behaviour)", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/artifacts") && !String(url).includes("download")) {
      return { ok: true, status: 200, json: async () => ({ artifacts: [{ name: "golfnow-import-output", archive_download_url: "https://example.com/download/fake.zip" }] }) };
    }
    return { ok: false, status: 500 };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const gh = buildGithubClient({ token: "test-token", repository: "OpenTees/opentees_scraper" });
  await assert.rejects(() => gh.downloadSummaryArtifact(RUN_ID), /Artifact download failed: 500/);
});

test("downloadSummaryArtifact: cleans up its temporary extraction directory after a successful read", async (t) => {
  const summary = { mode: "golfnow_import" };
  const zip = buildArtifactZip({ "summary.json": JSON.stringify(summary) });

  const originalFetch = global.fetch;
  global.fetch = mockFetchForArtifact(zip);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("expansion-artifact-"));
  const gh = buildGithubClient({ token: "test-token", repository: "OpenTees/opentees_scraper" });
  await gh.downloadSummaryArtifact(RUN_ID);
  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("expansion-artifact-"));
  assert.equal(after.length, before.length, "no leftover temp extraction directories");
});
