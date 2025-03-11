const puppeteer = require('puppeteer');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs').promises;
const db = require('../models/database');

// Create results directory if it doesn't exist
const RESULTS_DIR = path.join(__dirname, '../results');
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
            AND strftime('%s', st.scheduled_time) <= strftime('%s', 'now')
            ORDER BY st.scheduled_time ASC
            LIMIT 5`;
        
        db.all(query, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function updateTaskStatus(taskId, success, resultsPath = null) {
    return new Promise((resolve, reject) => {
        db.run(
            'UPDATE scraping_tasks SET execution_time = CURRENT_TIMESTAMP, success = ?, results_path = ? WHERE id = ?',
            [success ? 1 : 0, resultsPath, taskId],
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

async function createNextTask(itemId, url) {
    // Schedule next task for 24 hours later
    const nextScheduledTime = new Date(Date.now() + SCRAPE_INTERVAL)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, '');
    
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO scraping_tasks (item_id, url, scheduled_time) VALUES (?, ?, ?)',
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
            'INSERT INTO item_datapoints (item_id, price) VALUES (?, ?)',
            [itemId, price],
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

async function scrapePrice(url) {
    const browser = await puppeteer.launch({
        headless: 'new',
        product: 'chrome',
        executablePath: '/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        await page.goto(url, { timeout: 30000 });
        
        // Take a screenshot
        const screenshot = await page.screenshot();
        
        // Extract price using og:price:amount meta tag
        const price = await page.evaluate(() => {
            // First try the og:price:amount meta tag
            const priceMetaTag = document.querySelector('meta[property="og:price:amount"]');
            if (priceMetaTag) {
                const price = parseFloat(priceMetaTag.getAttribute('content'));
                if (!isNaN(price)) {
                    return price;
                }
            }

            // Fallback to common price selectors if meta tag is not found
            const selectors = [
                '[data-price]',
                '[class*="price"]',
                '[id*="price"]',
                'span:contains("$")',
                '.price',
                '#price'
            ];
            
            for (const selector of selectors) {
                const element = document.querySelector(selector);
                if (element) {
                    const text = element.textContent;
                    const match = text.match(/[\d,.]+/);
                    if (match) {
                        return parseFloat(match[0].replace(/,/g, ''));
                    }
                }
            }
            return null;
        });
        
        await browser.close();
        return { price, screenshot };
    } catch (error) {
        await browser.close();
        throw error;
    }
}

async function processTask(task) {
    console.log(`Processing task ${task.id} for item ${task.item_id}`);
    
    try {
        // Perform the scraping
        const { price, screenshot } = await scrapePrice(task.url);
        
        if (!price) {
            throw new Error('Could not extract price');
        }
        
        // Save the screenshot
        const screenshotPath = path.join(RESULTS_DIR, `task_${task.id}_${Date.now()}.png`);
        await fs.writeFile(screenshotPath, screenshot);
        
        // Save the price datapoint
        await saveDataPoint(task.item_id, price);
        
        // Update task status
        await updateTaskStatus(task.id, true, screenshotPath);
        
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
        console.error('Error checking pending tasks:', error);
    }
}

// Run the task checker every 30 seconds
setInterval(checkPendingTasks, CHECK_INTERVAL);

// Run the task scheduler every 5 minutes
setInterval(scheduleNewTasks, SCHEDULE_INTERVAL);

// Run both immediately on startup
checkPendingTasks();
scheduleNewTasks();

console.log('Scraper worker started. Checking for tasks every 30 seconds and scheduling new tasks every 5 minutes...'); 