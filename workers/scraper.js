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

async function getPendingTasks() {
  return new Promise((resolve, reject) => {
    const query = `
            SELECT st.*, i.enabled 
            FROM scraping_tasks st
            JOIN items i ON st.item_id = i.id
            WHERE st.execution_time IS NULL 
            AND i.enabled = 1
            AND strftime('%s', st.scheduled_time) <= strftime('%s', datetime('now', 'localtime'))
            ORDER BY st.scheduled_time ASC
            LIMIT 5`;

    db.all(query, [], (err, rows) => {
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
  const nextScheduledTime = new Date(Date.now() + SCRAPE_INTERVAL + jitter)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

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
        await priceMetaTag.evaluate((el) => el.getAttribute("content"))
      );
      if (!isNaN(price)) {
        return price;
      }
    }
  }

  // Fallback to common price selectors if meta tag is not found
  const selectors = [
    ".gl-price-item--sale", // Adidas
    "[data-price]",
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
  const browser = await puppeteer.launch({
    headless: "new",
    product: "chrome",
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const ua =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0";

  try {
    const page = await browser.newPage();
    page.setUserAgent(ua);
    await page.goto(url, { timeout: 30000 });

    // Take a screenshot
    const screenshot = await page.screenshot();

    // Get the page HTML
    const html = await page.content();

    // Extract price using the new extractPrice function
    const price = await extractPrice(page);

    await browser.close();
    return { price, screenshot, html };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function processTask(task) {
  console.log(`Processing task ${task.id} for item ${task.item_id}`);

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

// Only start recurring tasks if not in test environment
if (process.env.NODE_ENV !== "test") {
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
