const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const OUTPUT_DIR = path.join(process.cwd(), "scraper-output");

async function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function run() {
  await ensureOutputDir();

  const targetUrl = "https://members.manningsheath.com/visitorbooking/";

  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 }
  });

  console.log("Opening:", targetUrl);

  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  await page.waitForTimeout(5000);

  const title = await page.title();
  const finalUrl = page.url();

  const h1s = await page.locator("h1").allTextContents().catch(() => []);
  const h2s = await page.locator("h2").allTextContents().catch(() => []);
  const buttons = await page.locator("button").allTextContents().catch(() => []);
  const links = await page.locator("a").allTextContents().catch(() => []);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const bodyPreview = bodyText
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);

  const pageInfo = {
    targetUrl,
    finalUrl,
    title,
    h1s: h1s.slice(0, 10),
    h2s: h2s.slice(0, 10),
    buttons: buttons.map((t) => t.trim()).filter(Boolean).slice(0, 30),
    links: links.map((t) => t.trim()).filter(Boolean).slice(0, 30),
    bodyPreview
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "page-info.json"),
    JSON.stringify(pageInfo, null, 2)
  );

  await page.screenshot({
    path: path.join(OUTPUT_DIR, "manningsheath-visitorbooking.png"),
    fullPage: true
  });

  console.log("PAGE INFO:");
  console.log(JSON.stringify(pageInfo, null, 2));

  await browser.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
