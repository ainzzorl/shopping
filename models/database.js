const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Create database connection
const db = new sqlite3.Database(path.join(__dirname, '../shopping.db'), (err) => {
    if (err) {
        console.error('Error connecting to database:', err);
    } else {
        console.log('Connected to SQLite database');
    }
});

// Initialize database tables
db.serialize(() => {
    // Create items table
    db.run(`CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        name TEXT NOT NULL,
        target_price REAL NOT NULL,
        image_url TEXT,
        enabled BOOLEAN DEFAULT 1
    )`);

    // Create item_datapoints table
    db.run(`CREATE TABLE IF NOT EXISTS item_datapoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        price REAL NOT NULL,
        FOREIGN KEY (item_id) REFERENCES items (id)
    )`);
});

module.exports = db; 