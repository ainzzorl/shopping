const puppeteer = require('puppeteer');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs').promises;
const db = require('../models/database');

// Create results directory if it doesn't exist
const RESULTS_DIR = path.join(__dirname, '../results');
fs.mkdir(RESULTS_DIR, { recursive: true }).catch(console.error);

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
    // Schedule next task for 1 hour later
    const nextScheduledTime = new Date(Date.now() + 60 * 60 * 1000)
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
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        
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
        
        // Create next task
        await createNextTask(task.item_id, task.url);
        
        console.log(`Successfully processed task ${task.id}`);
    } catch (error) {
        console.error(`Error processing task ${task.id}:`, error);
        await updateTaskStatus(task.id, false);
        // Still create next task even if this one failed
        await createNextTask(task.item_id, task.url);
    }
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
const INTERVAL = 30 * 1000;
setInterval(checkPendingTasks, INTERVAL);

// Also run it immediately on startup
checkPendingTasks();

console.log('Scraper worker started. Checking for tasks every 30 seconds...'); 