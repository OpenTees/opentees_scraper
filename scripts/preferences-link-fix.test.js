// Regression coverage for the broken /profile-setup reminder-link defect.
//
// send-setup-reminders.js and send-no-matches-emails.js both call
// main()/process.exit() unconditionally at module load and require live
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/RESEND_API_KEY env vars just to
// import without throwing — they can't be require()'d directly in a test.
// Matching this repo's existing pattern of reading scraper scripts as
// plain text where execution isn't practical, these assert on the source
// itself rather than importing it.
const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");

function readScript(name) {
  return readFileSync(path.join(__dirname, name), "utf8");
}

test("send-setup-reminders links to /preferences via the homepage, never /profile-setup or a raw email", () => {
  const code = readScript("send-setup-reminders.js");
  assert.match(code, /\$\{SITE_URL\}\/\?utm_source=setup_reminder/);
  assert.doesNotMatch(code, /\/profile-setup/);
  assert.doesNotMatch(code, /email=\$\{encodeURIComponent\(email\)\}/);
  assert.doesNotMatch(code, /\?email=/);
});

test("send-no-matches-emails links to /preferences via the homepage, never /profile-setup or a raw email", () => {
  const code = readScript("send-no-matches-emails.js");
  assert.match(code, /\$\{SITE_URL\}\/\?utm_source=no_matches_email/);
  assert.doesNotMatch(code, /\/profile-setup/);
  assert.doesNotMatch(code, /email=\$\{encodeURIComponent\(email\)\}/);
  assert.doesNotMatch(code, /\?email=/);
});

test("neither reminder script's URL builder still accepts an email argument", () => {
  for (const name of ["send-setup-reminders.js", "send-no-matches-emails.js"]) {
    const code = readScript(name);
    assert.doesNotMatch(
      code,
      /function (setupUrl|preferencesUrl)\(email\)/,
      `${name} should build its link without an email parameter`,
    );
  }
});
