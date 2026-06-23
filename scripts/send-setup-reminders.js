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
  const SITE_URL = "https://www.open-tees.com";
  const PROFILE_SETUP_URL = setupUrl(email);

  const LOGO_URL =
    "https://edkpdujmnwbiwowfwvpr.supabase.co/storage/v1/object/public/OpenTees%20Logo/assists/White%20Logo.png";

  const BRAND_BG = "#041E14";
  const CARD_BG = "#0B0B0D";
  const ACCENT = "#2EFF7B";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1.0" />
    <title>Complete your OpenTees setup</title>
  </head>

  <body style="margin:0;padding:0;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      You’re one step away from personalised tee time alerts.
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
      bgcolor="${BRAND_BG}" style="background:${BRAND_BG};">
      <tr>
        <td align="center" bgcolor="${BRAND_BG}" style="background:${BRAND_BG}; padding:22px 12px;">

          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"
            style="width:100%;max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,Arial,sans-serif;">

            <tr>
              <td align="center" bgcolor="${BRAND_BG}" style="background:${BRAND_BG}; padding:8px 10px 6px 10px;">
                <a href="${SITE_URL}" style="text-decoration:none;">
                  <img src="${LOGO_URL}" width="130" alt="OpenTees"
                    style="display:inline-block;border:0;outline:none;text-decoration:none;height:auto;max-width:130px;" />
                </a>

                <div style="margin-top:10px;color:rgba(255,255,255,0.72);font-size:13px;line-height:18px;">
                  Stop searching. Start playing.
                </div>
              </td>
            </tr>

            <tr>
              <td bgcolor="${BRAND_BG}" style="background:${BRAND_BG}; height:10px; line-height:10px; font-size:0;">
                &nbsp;
              </td>
            </tr>

            <tr>
              <td>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                  bgcolor="${CARD_BG}"
                  style="background:${CARD_BG};border-radius:20px;border:1px solid rgba(255,255,255,0.10);overflow:hidden;box-shadow:0 12px 30px rgba(0,0,0,0.35);">

                  <tr>
                    <td height="2" bgcolor="${ACCENT}" style="font-size:0;line-height:0;">
                      &nbsp;
                    </td>
                  </tr>

                  <tr>
                    <td style="padding:26px 24px;">

                      <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                        <tr>
                          <td style="border:1px solid rgba(255,255,255,0.12);border-radius:999px;padding:6px 12px;">
                            <span style="font-size:12px;line-height:16px;color:rgba(255,255,255,0.70);">
                              Setup reminder
                            </span>
                          </td>
                        </tr>
                      </table>

                      <div style="margin-top:14px;color:rgba(255,255,255,0.96);font-size:30px;line-height:36px;font-weight:800;letter-spacing:-0.5px;">
                        You’re one step away from personalised tee time alerts.
                      </div>

                      <div style="margin-top:12px;color:rgba(255,255,255,0.82);font-size:16px;line-height:24px;">
                        You joined OpenTees, but your alert preferences haven’t been completed yet.
                      </div>

                      <div style="margin-top:14px;color:rgba(255,255,255,0.82);font-size:16px;line-height:24px;">
                        Tell us where you want to play, how far you’ll travel, your preferred tee times and your maximum green fee. Then we can start matching you with relevant last-minute tee times.
                      </div>

                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:22px;">
                        <tr>
                          <td bgcolor="${ACCENT}" style="background:${ACCENT};border-radius:12px;">
                            <a href="${PROFILE_SETUP_URL}"
                               style="display:inline-block;padding:14px 22px;font-weight:800;font-size:14px;
                                      color:#07110A !important;text-decoration:none;">
                              Complete your setup
                            </a>
                          </td>
                        </tr>
                      </table>

                      <div style="margin-top:24px;border-top:1px solid rgba(255,255,255,0.10);padding-top:18px;">
                        <div style="font-size:14px;color:rgba(255,255,255,0.95);font-weight:700;margin:0 0 8px;">
                          Why complete setup?
                        </div>

                        <div style="color:rgba(255,255,255,0.72);font-size:14px;line-height:22px;">
                          1. Choose your location and travel distance<br />
                          2. Set your preferred times and max price<br />
                          3. Get alerted when matching tee times appear
                        </div>
                      </div>

                      <div style="margin-top:18px;color:rgba(255,255,255,0.72);font-size:14px;line-height:22px;">
                        Setup takes less than 60 seconds. OpenTees is free to use.
                      </div>

                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td bgcolor="${BRAND_BG}" style="background:${BRAND_BG}; padding:14px 10px 6px 10px;">
                <div style="color:rgba(255,255,255,0.65);font-size:12px;line-height:16px;">
                  You’re receiving this because you signed up at
                  <a href="${SITE_URL}" style="color:rgba(255,255,255,0.90);text-decoration:underline;">open-tees.com</a>.
                </div>
                <div style="margin-top:8px;color:rgba(255,255,255,0.65);font-size:12px;line-height:16px;">
                  © ${new Date().getFullYear()} OpenTees
                </div>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
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
