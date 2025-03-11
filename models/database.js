const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// Create database connection
const db = new sqlite3.Database(
  path.join(__dirname, "../shopping.db"),
  (err) => {
    if (err) {
      console.error("Error connecting to database:", err);
    } else {
      console.log("Connected to SQLite database");
    }
  }
);

// Initialize database tables
db.serialize(() => {
  // Create stores table
  db.run(`CREATE TABLE IF NOT EXISTS stores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        website TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

  // Create items table
  db.run(`CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        name TEXT NOT NULL,
        target_price REAL NOT NULL,
        image_url TEXT,
        enabled BOOLEAN DEFAULT 1,
        store_id INTEGER,
        FOREIGN KEY (store_id) REFERENCES stores (id)
    )`);

  // Create item_datapoints table
  db.run(`CREATE TABLE IF NOT EXISTS item_datapoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        price REAL NOT NULL,
        FOREIGN KEY (item_id) REFERENCES items (id)
    )`);

  // Create scraping_tasks table
  db.run(`CREATE TABLE IF NOT EXISTS scraping_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        scheduled_time DATETIME NOT NULL,
        execution_time DATETIME,
        success BOOLEAN,
        screenshot_path TEXT,
        html_path TEXT,
        FOREIGN KEY (item_id) REFERENCES items (id)
    )`);

  // Create notifications table
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        price REAL NOT NULL,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        type TEXT NOT NULL,
        FOREIGN KEY (item_id) REFERENCES items (id)
    )`);
});

module.exports = db;
