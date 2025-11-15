const { extractPrice, scrapePrice } = require("./workers/scraper");
const path = require("path");
const fs = require("fs").promises;

// Reuse the scrapePrice function from workers/scraper.js
// This avoids code duplication and ensures consistent behavior
async function scrapeUrl(url) {
  console.log(`Navigating to: ${url}`);
  console.log('Note: If your regular Chromium browser is open, please close it first.\n');
  
  if (process.env.PROXY_SERVER) {
    console.log(`Using proxy: ${process.env.PROXY_SERVER}\n`);
  }
  
  return await scrapePrice(url);
}

async function scrapeLocalHtml(htmlPath) {
  // Use basic puppeteer for local HTML files (no CAPTCHA concerns)
  const puppeteer = require("puppeteer");
  let browser = null;
  let page = null;
  
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    page = await browser.newPage();

    // Set a timeout for the entire operation
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Scraping operation timed out')), 60000); // 60 seconds
    });
    
    const scrapingPromise = (async () => {
      // Read and load the HTML file
      const html = await fs.readFile(htmlPath, "utf-8");
      await page.setContent(html);

      // Take a screenshot
      const screenshot = await page.screenshot();

      // Get the page HTML
      const pageHtml = await page.content();

      // Extract price using the existing extractPrice function
      const price = await extractPrice(page);

      return { price, screenshot, html: pageHtml };
    })();
    
    const result = await Promise.race([scrapingPromise, timeoutPromise]);
    return result;
    
  } catch (error) {
    throw error;
  } finally {
    // Ensure browser is always closed, even if an error occurs
    if (page) {
      try {
        await page.close();
      } catch (closeError) {
        console.warn('Error closing page:', closeError);
      }
    }
    
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.warn('Error closing browser:', closeError);
        // Force kill browser process if normal close fails
        try {
          if (browser.process()) {
            browser.process().kill('SIGKILL');
          }
        } catch (killError) {
          console.warn('Error force killing browser process:', killError);
        }
      }
    }
  }
}

async function scrapeOnePage(input) {
  try {
    console.log(`Processing: ${input}`);

    let result;
    let isUrl = false;

    // Check if input is a URL
    if (input.startsWith("http://") || input.startsWith("https://")) {
      isUrl = true;
      console.log("Detected URL, using scrapeUrl function...");
      result = await scrapeUrl(input);
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
      ? new URL(input).hostname.replace(/[^a-zA-Z0-9]/g, "_")
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
    console.log(`Input: ${input}`);
    console.log(`Price found: ${price || "No price found"}`);
    console.log(`Screenshot saved to: ${screenshotPath}`);
    console.log(`Processed HTML saved to: ${processedHtmlPath}`);

    if (price) {
      console.log(`Price value: $${price}`);
    }
  } catch (error) {
    console.error("Error during scraping:", error);
    process.exit(1);
  }
}

// Get file path or URL from command line argument
const input = process.argv[2];
if (!input) {
  console.error(
    "Please provide an HTML file path or URL as a command line argument"
  );
  console.error("Usage: node scrape-one.js <path-to-html-file-or-url>");
  console.error("Examples:");
  console.error("  node scrape-one.js ./local-file.html");
  console.error("  node scrape-one.js https://example.com/product");
  process.exit(1);
}

scrapeOnePage(input);
