const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const TEST_EMAIL = process.env.TEST_EMAIL || "";
const SITE_URL = "https://www.open-tees.com";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY) {
  throw new Error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or RESEND_API_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function setupUrl(email) {
  return `${SITE_URL}/profile-setup?email=${encodeURIComponent(email)}&utm_source=setup_reminder&utm_medium=email&utm_campaign=complete_setup`;
}

function htmlEmail(email) {
  const url = setupUrl(email);

  return `
  <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #102017;">
    <h1 style="font-size: 24px;">Complete your OpenTees setup</h1>

    <p>You joined OpenTees, but your alert preferences haven’t been completed yet.</p>

    <p>Without those details, we can’t match you with the best last-minute tee times near you.</p>

    <p style="margin: 28px 0;">
      <a href="${url}" style="background:#041E14;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:8px;display:inline-block;font-weight:bold;">
        Complete my setup
      </a>
    </p>

    <p>It takes less than 60 seconds to choose your location, travel distance, preferred times and max price.</p>

    <p>OpenTees is already tracking thousands of live tee times across GolfNow, BRS, Intelligent Golf and other booking systems.</p>

    <p>See you on the course,<br/>Dom<br/>Founder, OpenTees</p>

    <p style="font-size:12px;color:#666;">OpenTees is free to use.</p>
  </div>`;
}

function textEmail(email) {
  return `
Complete your OpenTees setup

You joined OpenTees, but your alert preferences haven’t been completed yet.

Without those details, we can’t match you with the best last-minute tee times near you.

Complete your setup here:
${setupUrl(email)}

It takes less than 60 seconds to choose your location, travel distance, preferred times and max price.

OpenTees is free to use.

See you on the course,
Dom
Founder, OpenTees
`;
}

async function sendEmail(email) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "OpenTees <hello@mail.open-tees.com>",
      to: [email],
      subject: "Complete your OpenTees setup",
      html: htmlEmail(email),
      text: textEmail(email),
    }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Resend failed for ${email}: ${response.status} ${JSON.stringify(result)}`);
  }

  return result;
}

async function getRecipients() {
  if (TEST_EMAIL) {
    console.log(`TEST MODE: only sending to ${TEST_EMAIL}`);

    const { data, error } = await supabase
      .from("early_access_old")
      .select("id, email, created_at, setup_reminder_sent_at")
      .ilike("email", TEST_EMAIL)
      .limit(1);

    if (error) throw error;
    return data || [];
  }

  const { data, error } = await supabase
    .from("early_access_old")
    .select("id, email, created_at, setup_reminder_sent_at")
    .is("setup_reminder_sent_at", null)
    .lte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  if (error) throw error;

  const { data: preferences, error: prefError } = await supabase
    .from("user_preferences")
    .select("email");

  if (prefError) throw prefError;

  const completedEmails = new Set(
    (preferences || []).map((row) => String(row.email || "").toLowerCase().trim())
  );

  return (data || []).filter((row) => {
    const email = String(row.email || "").toLowerCase().trim();
    return email && !completedEmails.has(email);
  });
}

async function main() {
  const recipients = await getRecipients();

  console.log(`Setup reminder recipients: ${recipients.length}`);

  for (const recipient of recipients) {
    const email = recipient.email;

    console.log(`Sending setup reminder to ${email}`);

    await sendEmail(email);

    const { error } = await supabase
      .from("early_access_old")
      .update({ setup_reminder_sent_at: new Date().toISOString() })
      .eq("id", recipient.id);

    if (error) throw error;

    console.log(`Marked reminder sent for ${email}`);
  }

  console.log("Setup reminders complete");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
