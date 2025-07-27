const { extractPrice, scrapePrice } = require("./workers/scraper");
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

async function scrapeOnePage(input) {
  try {
    console.log(`Processing: ${input}`);

    let result;
    let isUrl = false;

    // Check if input is a URL
    if (input.startsWith('http://') || input.startsWith('https://')) {
      isUrl = true;
      console.log("Detected URL, using scrapePrice function...");
      result = await scrapePrice(input);
    } else {
      // Check if the file exists
      try {
        await fs.access(input);
      } catch (error) {
        throw new Error(`File not found: ${input}`);
      }
      console.log("Detected local HTML file, using local scraping...");
      result = await scrapeLocalHtml(input);
    }

    const { price, screenshot, html } = result;

    // Create results directory if it doesn't exist
    const resultsDir = path.join(__dirname, "results");
    await fs.mkdir(resultsDir, { recursive: true });

    // Generate filename based on input type
    const timestamp = Date.now();
    const inputName = isUrl 
      ? new URL(input).hostname.replace(/[^a-zA-Z0-9]/g, '_')
      : path.basename(input, path.extname(input));

    // Save screenshot
    const screenshotPath = path.join(
      resultsDir,
      `${inputName}_${timestamp}.png`
    );
    await fs.writeFile(screenshotPath, screenshot);

    // Save processed HTML
    const processedHtmlPath = path.join(
      resultsDir,
      `${inputName}_${timestamp}.html`
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

// Get file path or URL from command line argument
const input = process.argv[2];
if (!input) {
  console.error("Please provide an HTML file path or URL as a command line argument");
  console.error("Usage: node scrape-one.js <path-to-html-file-or-url>");
  console.error("Examples:");
  console.error("  node scrape-one.js ./local-file.html");
  console.error("  node scrape-one.js https://example.com/product");
  process.exit(1);
}

scrapeOnePage(input);
