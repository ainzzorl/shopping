const { extractPrice } = require("./workers/scraper");
const path = require("path");
const fs = require("fs").promises;
const puppeteer = require("puppeteer");

async function scrapeLocalHtml(htmlPath) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const ua =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0";

  try {
    const page = await browser.newPage();

    page.setUserAgent(ua);

    // Read and load the HTML file
    const html = await fs.readFile(htmlPath, "utf-8");
    await page.setContent(html);

    // Take a screenshot
    const screenshot = await page.screenshot();

    // Get the page HTML
    const pageHtml = await page.content();

    // Extract price using the existing extractPrice function
    const price = await extractPrice(page);

    await browser.close();
    return { price, screenshot, html: pageHtml };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function scrapeOnePage(inputPath) {
  try {
    console.log(`Processing file: ${inputPath}`);

    // Check if the file exists
    try {
      await fs.access(inputPath);
    } catch (error) {
      throw new Error(`File not found: ${inputPath}`);
    }

    // Use the local HTML scraping function
    const { price, screenshot, html } = await scrapeLocalHtml(inputPath);

    // Create results directory if it doesn't exist
    const resultsDir = path.join(__dirname, "results");
    await fs.mkdir(resultsDir, { recursive: true });

    // Save screenshot
    const screenshotPath = path.join(
      resultsDir,
      `single_scrape_${Date.now()}.png`
    );
    await fs.writeFile(screenshotPath, screenshot);

    // Save processed HTML
    const processedHtmlPath = path.join(
      resultsDir,
      `single_scrape_${Date.now()}.html`
    );
    await fs.writeFile(processedHtmlPath, html);

    // Print results
    console.log("\nScraping Results:");
    console.log("-----------------");
    console.log(`Price found: ${price || "No price found"}`);
    console.log(`Screenshot saved to: ${screenshotPath}`);
    console.log(`Processed HTML saved to: ${processedHtmlPath}`);
  } catch (error) {
    console.error("Error during scraping:", error);
  }
}

// Get file path from command line argument
const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Please provide an HTML file path as a command line argument");
  console.error("Usage: node scrape-one.js <path-to-html-file>");
  process.exit(1);
}

scrapeOnePage(inputPath);
