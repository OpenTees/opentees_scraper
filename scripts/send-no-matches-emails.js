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

function preferencesUrl(email) {
  return `${SITE_URL}/profile-setup?email=${encodeURIComponent(email)}&utm_source=no_matches_email&utm_medium=email&utm_campaign=improve_preferences`;
}

function htmlEmail(user) {
  const email = user.email;
  const name = user.name || "there";
  const url = preferencesUrl(email);

  const LOGO_URL =
    "https://edkpdujmnwbiwowfwvpr.supabase.co/storage/v1/object/public/OpenTees%20Logo/assists/White%20Logo.png";

  const BRAND_BG = "#041E14";
  const CARD_BG = "#0B0B0D";
  const ACCENT = "#2EFF7B";

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${BRAND_BG}" style="background:${BRAND_BG};">
      <tr>
        <td align="center" style="padding:22px 12px;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"
            style="width:100%;max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,Arial,sans-serif;">

            <tr>
              <td align="center" style="padding:8px 10px 16px;">
                <a href="${SITE_URL}" style="text-decoration:none;">
                  <img src="${LOGO_URL}" width="130" alt="OpenTees" style="display:inline-block;border:0;height:auto;max-width:130px;" />
                </a>
                <div style="margin-top:10px;color:rgba(255,255,255,0.72);font-size:13px;line-height:18px;">
                  Stop searching. Start playing.
                </div>
              </td>
            </tr>

            <tr>
              <td>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                  bgcolor="${CARD_BG}"
                  style="background:${CARD_BG};border-radius:20px;border:1px solid rgba(255,255,255,0.10);overflow:hidden;box-shadow:0 12px 30px rgba(0,0,0,0.35);">

                  <tr>
                    <td height="2" bgcolor="${ACCENT}" style="font-size:0;line-height:0;">&nbsp;</td>
                  </tr>

                  <tr>
                    <td style="padding:26px 24px;">
                      <div style="display:inline-block;border:1px solid rgba(255,255,255,0.12);border-radius:999px;padding:6px 12px;font-size:12px;color:rgba(255,255,255,0.70);">
                        Preference check
                      </div>

                      <div style="margin-top:14px;color:rgba(255,255,255,0.96);font-size:30px;line-height:36px;font-weight:800;letter-spacing:-0.5px;">
                        We’re searching, but your filters may be too specific.
                      </div>

                      <div style="margin-top:12px;color:rgba(255,255,255,0.82);font-size:16px;line-height:24px;">
                        Hi ${name},
                      </div>

                      <div style="margin-top:12px;color:rgba(255,255,255,0.82);font-size:16px;line-height:24px;">
                        We’ve been checking live tee times for you, but we haven’t found any that match your current preferences yet.
                      </div>

                      <div style="margin-top:14px;color:rgba(255,255,255,0.82);font-size:16px;line-height:24px;">
                        Your current setup is:
                      </div>

                      <div style="margin-top:12px;color:rgba(255,255,255,0.72);font-size:14px;line-height:22px;">
                        • Radius: ${user.radius_miles || "not set"} miles<br />
                        • Time: ${user.time_window || "not set"}<br />
                        • Days: ${user.days || "not set"}<br />
                        • Players: ${user.players || "not set"}<br />
                        • Max price: £${user.max_price || "not set"}
                      </div>

                      <div style="margin-top:18px;color:rgba(255,255,255,0.82);font-size:16px;line-height:24px;">
                        A small change can make a big difference. Try increasing your travel radius, including more times of day, or adding weekdays if you can play midweek.
                      </div>

                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:22px;">
                        <tr>
                          <td bgcolor="${ACCENT}" style="background:${ACCENT};border-radius:12px;">
                            <a href="${url}"
                               style="display:inline-block;padding:14px 22px;font-weight:800;font-size:14px;color:#07110A !important;text-decoration:none;">
                              Update my preferences
                            </a>
                          </td>
                        </tr>
                      </table>

                      <div style="margin-top:24px;border-top:1px solid rgba(255,255,255,0.10);padding-top:18px;color:rgba(255,255,255,0.72);font-size:14px;line-height:22px;">
                        We’ll keep searching for you. As soon as a tee time matches your preferences, we’ll send you an alert.
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:14px 10px 6px;">
                <div style="color:rgba(255,255,255,0.65);font-size:12px;line-height:16px;">
                  You’re receiving this because you set up OpenTees alerts at
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

function textEmail(user) {
  return `
Hi ${user.name || "there"},

Since you signed up yesterday, OpenTees has been monitoring thousands of live tee times on your behalf.

We haven’t found a match just yet, but that’s usually because your preferences are quite specific—not because we aren’t searching.

Yesterday we searched over 6,000 live tee times across more than 160 golf courses for you.

Your current setup:
- Radius: ${user.radius_miles || "not set"} miles
- Time: ${user.time_window || "not set"}
- Days: ${user.days || "not set"}
- Players: ${user.players || "not set"}
- Max price: £${user.max_price || "not set"}

A small change can make a big difference. Try increasing your travel radius, including more times of day, or adding weekdays if you can play midweek.

Update your preferences:
${preferencesUrl(user.email)}

We'll keep searching for you. As soon as a tee time matches your preferences, we'll send you an alert.

Dom
Founder, OpenTees
`;
}

async function sendEmail(user) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "OpenTees <hello@mail.open-tees.com>",
      to: [user.email],
      subject: "We've started searching for your next tee time ⛳",
      html: htmlEmail(user),
      text: textEmail(user),
    }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Resend failed for ${user.email}: ${response.status} ${JSON.stringify(result)}`);
  }

  return result;
}

async function getMatchCount(email) {
  const { data, error } = await supabase.rpc("get_ranked_matches_for_email", {
    user_email: email,
  });

  if (error) throw error;
  return (data || []).length;
}

async function getAlertCount(email) {
  const { count, error } = await supabase
    .from("alert_send_log")
    .select("*", { count: "exact", head: true })
    .ilike("email", email);

  if (error) throw error;
  return count || 0;
}

async function getRecipients() {
  let query = supabase
    .from("user_preferences")
    .select("*")
    .is("no_matches_email_sent_at", null);

  if (TEST_EMAIL) {
    console.log(`TEST MODE: only checking ${TEST_EMAIL}`);
    query = query.ilike("email", TEST_EMAIL);
  } else {
    query = query.lte(
  "created_at",
  new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
);
}   

  const { data, error } = await query;

  if (error) throw error;

  const recipients = [];

  for (const user of data || []) {
    const matchCount = await getMatchCount(user.email);
    const alertCount = await getAlertCount(user.email);

    console.log(`${user.email}: matches=${matchCount}, alerts=${alertCount}`);

    if (matchCount === 0 && alertCount === 0) {
      recipients.push(user);
    }
  }

  return recipients;
}

async function main() {
  const recipients = await getRecipients();

  console.log(`No-matches email recipients: ${recipients.length}`);

  for (const user of recipients) {
    console.log(`Sending no-matches email to ${user.email}`);

    await sendEmail(user);

    const { error } = await supabase
      .from("user_preferences")
      .update({ no_matches_email_sent_at: new Date().toISOString() })
      .eq("id", user.id);

    if (error) throw error;

    console.log(`Marked no-matches email sent for ${user.email}`);
  }

  console.log("No-matches emails complete");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
