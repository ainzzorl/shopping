const puppeteer = require("puppeteer");
const cron = require("node-cron");
const path = require("path");
const fs = require("fs").promises;
const db = require("../models/database");
const { sendPriceAlert } = require("../services/notificationService");

// Create results directory if it doesn't exist
const RESULTS_DIR = path.join(__dirname, "../results");
fs.mkdir(RESULTS_DIR, { recursive: true }).catch(console.error);

// Time intervals
const CHECK_INTERVAL = 30 * 1000; // 30 seconds
const SCHEDULE_INTERVAL = 5 * 60 * 1000; // 5 minutes
const SCRAPE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Track currently processing tasks to prevent duplicates
const processingTasks = new Set();

async function getPendingTasks() {
  return new Promise((resolve, reject) => {
    // Create a placeholder for task IDs that are currently being processed
    const processingTaskIds = Array.from(processingTasks);
    const placeholders = processingTaskIds.map(() => "?").join(",");

    let query = `
            SELECT st.*, i.enabled 
            FROM scraping_tasks st
            JOIN items i ON st.item_id = i.id
            WHERE st.execution_time IS NULL 
            AND i.enabled = 1
            AND strftime('%s', st.scheduled_time) <= strftime('%s', datetime('now', 'localtime'))`;

    // Exclude tasks that are currently being processed
    if (processingTaskIds.length > 0) {
      query += ` AND st.id NOT IN (${placeholders})`;
    }

    query += ` ORDER BY st.scheduled_time ASC LIMIT 5`;

    const params = processingTaskIds;
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function updateTaskStatus(
  taskId,
  success,
  screenshotPath = null,
  htmlPath = null
) {
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE scraping_tasks SET execution_time = datetime('now', 'localtime'), success = ?, screenshot_path = ?, html_path = ? WHERE id = ?",
      [success ? 1 : 0, screenshotPath, htmlPath, taskId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

async function createNextTask(itemId, url) {
  // Schedule next task for 24 hours later with random jitter of ±1 hour
  const jitter = (Math.random() - 0.5) * (1 * 60 * 60 * 1000); // ±1 hour in milliseconds
  const date = new Date(Date.now() + SCRAPE_INTERVAL + jitter);

  // Format in local time using ISO format that SQLite expects (YYYY-MM-DD HH:mm:ss)
  const nextScheduledTime = date.toLocaleString("sv-SE"); // Swedish locale gives us exactly the format we need

  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO scraping_tasks (item_id, url, scheduled_time) VALUES (?, ?, ?)",
      [itemId, url, nextScheduledTime],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

async function saveDataPoint(itemId, price) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO item_datapoints (item_id, price) VALUES (?, ?)",
      [itemId, price],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

async function checkPriceDrops() {
  try {
    // Get all items with their latest prices that are below target price
    // Only include items that haven't had a notification in the last 7 days
    const query = `
            WITH LatestPrices AS (
                SELECT 
                    item_id,
                    price,
                    timestamp,
                    ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY timestamp DESC) as rn
                FROM item_datapoints
            ),
            RecentNotifications AS (
                SELECT DISTINCT item_id, price
                FROM notifications 
                WHERE sent_at >= datetime('now', '-7 days')
            )
            SELECT 
                i.*,
                lp.price as current_price,
                lp.timestamp as price_timestamp
            FROM items i
            JOIN LatestPrices lp ON i.id = lp.item_id
            LEFT JOIN RecentNotifications rn ON i.id = rn.item_id 
                AND lp.price = rn.price
            WHERE lp.rn = 1
            AND lp.price <= i.target_price
            AND i.enabled = 1
            AND i.enable_notifications = 1
            AND rn.item_id IS NULL`;

    const items = await new Promise((resolve, reject) => {
      db.all(query, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    console.log(`Found ${items.length} items with price drops`);

    for (const item of items) {
      try {
        await sendPriceAlert(item, item.current_price);
      } catch (error) {
        console.error(`Error sending price alert for item ${item.id}:`, error);
      }
    }
  } catch (error) {
    console.error("Error checking price drops:", error);
  }
}

async function extractPrice(page) {
  // First try the og:price:amount meta tag
  // Try various meta tags that could contain the price
  const metaSelectors = [
    'meta[property="og:price:amount"]',
    'meta[itemprop="lowPrice"]',
    'meta[itemprop="price"]',
    'meta[property="product:price:amount"]',
  ];

  for (const selector of metaSelectors) {
    const priceMetaTag = await page.$(selector);
    if (priceMetaTag) {
      const price = parseFloat(
        await priceMetaTag.evaluate((el) =>
          el
            .getAttribute("content")
            .replace(/[^\d,.]/g, "")
            .replace(/,/g, "")
        )
      );
      if (!isNaN(price)) {
        return price;
      }
    }
  }

  // Fallback to common price selectors if meta tag is not found
  const selectors = [
    ".gl-price-item--sale", // Adidas
    ".product-price__highlight", // Banana Republic
    "[class='current-sale-price']", // Banana Republic
    "formatted-price-detail", // Massimo Dutti
    '[data-tau-price="new"]', // John Varvatos
    '[data-selector="price-only"]', // Etsy
    "[class*='summary_salePrice']", // Bonobos
    "[class*='price__number price__number--sale']", // Rebel Cheese
    "[data-price]",
    '[class*="promoPrice"]',
    '[class*="price"]',
    '[id*="price"]',
    ".price",
    "#price",
  ];

  for (const selector of selectors) {
    const element = await page.$(selector);
    if (element) {
      const text = await element.evaluate((el) => el.textContent);
      const match = text.match(/[\d,.]+/);
      if (match) {
        return parseFloat(match[0].replace(/,/g, ""));
      }
    }
  }
  return null;
}

async function scrapePrice(url) {
  let browser = null;
  let page = null;

  try {
    browser = await puppeteer.launch({
      headless: "false",
      product: "chrome",
      executablePath:
        process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "/usr/bin/chromium-browser",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--window-size=1920,1080",
      ],
      defaultViewport: {
        width: 1920,
        height: 1080,
      },
    });

    // Track browser for cleanup
    activeBrowsers.add(browser);

    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0";

    page = await browser.newPage();
    page.setUserAgent(ua);

    // Set a timeout for the entire operation
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Scraping operation timed out")),
        60000
      ); // 60 seconds
    });

    const scrapingPromise = (async () => {
      await page.goto(url, { timeout: 30000 });

      // Take a screenshot
      const screenshot = await page.screenshot();

      // Get the page HTML
      const html = await page.content();

      // Extract price using the new extractPrice function
      const price = await extractPrice(page);

      return { price, screenshot, html };
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
        console.warn("Error closing page:", closeError);
      }
    }

    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.warn("Error closing browser:", closeError);
        // Force kill browser process if normal close fails
        try {
          if (browser.process()) {
            browser.process().kill("SIGKILL");
          }
        } catch (killError) {
          console.warn("Error force killing browser process:", killError);
        }
      }
    }
  }
}

async function processTask(task) {
  if (processingTasks.has(task.id)) {
    console.log(`Task ${task.id} is already being processed`);
    return;
  }

  console.log(`Processing task ${task.id} for item ${task.item_id}`);
  console.log("All processing tasks:", processingTasks);

  // Add task to processing set to prevent duplicates
  processingTasks.add(task.id);

  try {
    // Perform the scraping
    const { price, screenshot, html } = await scrapePrice(task.url);

    // Save the screenshot
    const screenshotPath = path.join(
      RESULTS_DIR,
      `task_${task.id}_${Date.now()}.png`
    );
    await fs.writeFile(screenshotPath, screenshot);

    // Save the HTML
    const htmlPath = path.join(
      RESULTS_DIR,
      `task_${task.id}_${Date.now()}.html`
    );
    await fs.writeFile(htmlPath, html);

    if (!price) {
      throw new Error("Could not extract price");
    }

    // Save the price datapoint
    await saveDataPoint(task.item_id, price);

    // Update task status with separate paths
    await updateTaskStatus(task.id, true, screenshotPath, htmlPath);

    console.log(`Successfully processed task ${task.id}`);
  } catch (error) {
    console.error(`Error processing task ${task.id}:`, error);
    await updateTaskStatus(task.id, false);
  } finally {
    // Always remove task from processing set when done
    processingTasks.delete(task.id);
  }
}

async function scheduleNewTasks() {
  return new Promise((resolve, reject) => {
    // Find active items that don't have any pending tasks
    const query = `
            SELECT i.id, i.url 
            FROM items i 
            LEFT JOIN scraping_tasks st ON i.id = st.item_id 
            AND st.execution_time IS NULL 
            WHERE i.enabled = 1 
            AND st.id IS NULL`;

    db.all(query, [], async (err, items) => {
      if (err) {
        reject(err);
        return;
      }

      console.log(`Found ${items.length} items needing new tasks`);

      for (const item of items) {
        try {
          await createNextTask(item.id, item.url);
          console.log(`Scheduled new task for item ${item.id}`);
        } catch (error) {
          console.error(`Error scheduling task for item ${item.id}:`, error);
        }
      }
      resolve();
    });
  });
}

async function checkPendingTasks() {
  try {
    const tasks = await getPendingTasks();
    console.log(`Found ${tasks.length} pending tasks`);

    for (const task of tasks) {
      await processTask(task);
    }
  } catch (error) {
    console.error("Error checking pending tasks:", error);
  }
}

// Track active browsers for cleanup
const activeBrowsers = new Set();

// Process cleanup handlers
function cleanupBrowsers() {
  console.log("Cleaning up browser processes...");
  for (const browser of activeBrowsers) {
    try {
      if (browser && browser.process()) {
        browser.process().kill("SIGKILL");
      }
    } catch (error) {
      console.warn("Error killing browser process:", error);
    }
  }
  activeBrowsers.clear();
}

// Register cleanup handlers
process.on("SIGINT", () => {
  console.log("Received SIGINT, cleaning up...");
  cleanupBrowsers();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, cleaning up...");
  cleanupBrowsers();
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  cleanupBrowsers();
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection at:", promise, "reason:", reason);
  cleanupBrowsers();
  process.exit(1);
});

// Only start recurring tasks if this is the main module and not in test environment
if (require.main === module && process.env.NODE_ENV !== "test") {
  // Run the task checker every 30 seconds
  setInterval(checkPendingTasks, CHECK_INTERVAL);

  // Run the task scheduler every 5 minutes
  setInterval(scheduleNewTasks, SCHEDULE_INTERVAL);

  // Run the price drop checker every 30 seconds
  setInterval(checkPriceDrops, CHECK_INTERVAL);

  // Run all immediately on startup
  checkPendingTasks();
  scheduleNewTasks();
  checkPriceDrops();

  console.log(
    "Scraper worker started. Checking for tasks and price drops every 30 seconds and scheduling new tasks every 5 minutes..."
  );
}

// Export functions for testing
module.exports = {
  extractPrice,
  scrapePrice,
  checkPriceDrops,
  checkPendingTasks,
  scheduleNewTasks,
  processTask,
  createNextTask,
  updateTaskStatus,
  getPendingTasks,
  saveDataPoint,
};
