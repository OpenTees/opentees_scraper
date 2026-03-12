const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const OUTPUT_DIR = path.join(process.cwd(), "scraper-output");

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function monthNameToNumber(monthName) {
  const months = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
  };

  return months[String(monthName || "").toLowerCase()] || null;
}

function extractSlotDateFromBody(bodyText) {
  const match = bodyText.match(
    /\b(?:Mon|Tue|Tues|Wed|Thu|Thur|Fri|Sat|Sun),?\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\b/i,
  );

  if (!match) {
    return null;
  }

  const day = String(match[1]).padStart(2, "0");
  const month = monthNameToNumber(match[2]);
  const year = new Date().getUTCFullYear();

  if (!month) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

function normalisePrice(priceText) {
  const cleaned = String(priceText || "").replace(/[^\d.]/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function buildExternalId(courseSlug, slotDate, slotTime, price) {
  return `ig-${courseSlug}-${slotDate}-${slotTime}-${price ?? "na"}`;
}

async function run() {
  ensureOutputDir();

  const importSecret = process.env.MANUAL_IMPORT_SECRET;

  if (!importSecret) {
    throw new Error("Missing MANUAL_IMPORT_SECRET");
  }

  const targetUrl = "https://members.manningsheath.com/visitorbooking/";
  const courseName = "Mannings Heath Golf Club";
  const providerCourseId = "intelligent-golf-mannings-heath";
  const courseSlug = "mannings-heath";

  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  console.log("Opening:", targetUrl);

  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  // Give the page time to render properly
  await page.waitForTimeout(3000);

  // Try to accept cookies if the banner appears
  await page.click("text=ACCEPT COOKIES").catch(() => {});
  await page.click("text=Accept Cookies").catch(() => {});
  await page.click("text=Accept cookies").catch(() => {});

  // Give the page more time after cookie interaction
  await page.waitForTimeout(8000);

  const title = await page.title();
  const finalUrl = page.url();

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const bodyPreview = bodyText.replace(/\s+/g, " ").trim().slice(0, 3000);
  const slotDate = extractSlotDateFromBody(bodyText);

  if (!slotDate) {
    await page.screenshot({
      path: path.join(OUTPUT_DIR, "manningsheath-visitorbooking.png"),
      fullPage: true,
    });

    fs.writeFileSync(
      path.join(OUTPUT_DIR, "page-info.json"),
      JSON.stringify(
        {
          targetUrl,
          finalUrl,
          title,
          bodyPreview,
          extractedCount: 0,
          note: "Could not detect slot date from page body",
        },
        null,
        2,
      ),
    );

    console.log("No slot date detected from page body. Exiting cleanly.");
    await browser.close();
    process.exit(0);
  }

  const linkHandles = await page.locator("a").elementHandles();
  const extractedRows = [];

  for (const linkHandle of linkHandles) {
    const text = (await linkHandle.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const href = await linkHandle.getAttribute("href").catch(() => null);

    const match = text.match(/(\d{1,2}:\d{2})\s*£\s*([0-9]+(?:\.[0-9]{2})?)/i);

    if (!match) {
      continue;
    }

    const slotTime = match[1];
    const price = normalisePrice(match[2]);

    const bookingUrl = href
      ? new URL(href, finalUrl).toString()
      : finalUrl;

    extractedRows.push({
      external_id: buildExternalId(courseSlug, slotDate, slotTime, price),
      provider_course_id: providerCourseId,
      course_name: courseName,
      slot_date: slotDate,
      slot_time: slotTime,
      price,
      players: 4,
      booking_url: bookingUrl,
      raw_payload: {
        source: "intelligent_golf",
        club: courseName,
        target_url: targetUrl,
        final_url: finalUrl,
        title,
        link_text: text,
      },
    });
  }

  const dedupedRows = Array.from(
    new Map(extractedRows.map((row) => [row.external_id, row])).values(),
  );

  const pageInfo = {
    targetUrl,
    finalUrl,
    title,
    slotDate,
    extractedCount: dedupedRows.length,
    extractedPreview: dedupedRows.slice(0, 10),
    bodyPreview,
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "page-info.json"),
    JSON.stringify(pageInfo, null, 2),
  );

  await page.screenshot({
    path: path.join(OUTPUT_DIR, "manningsheath-visitorbooking.png"),
    fullPage: true,
  });

  console.log("PAGE INFO:");
  console.log(JSON.stringify(pageInfo, null, 2));

  // If there are no tee times, don't fail the workflow
  if (dedupedRows.length === 0) {
    console.log("No tee times found on the page. Exiting successfully.");
    await browser.close();
    process.exit(0);
  }

  const payload = {
    source_key: "manual_import",
    rows: dedupedRows,
  };

  const response = await fetch(
    "https://edkpdujmnwbiwowfwvpr.supabase.co/functions/v1/ingest-tee-times",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-import-secret": importSecret,
      },
      body: JSON.stringify(payload),
    },
  );

  const responseText = await response.text();

  console.log("IMPORT STATUS:", response.status);
  console.log("IMPORT RESPONSE:", responseText);

  if (!response.ok) {
    throw new Error(`Import failed: ${response.status} ${responseText}`);
  }

  await browser.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
