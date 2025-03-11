const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const moment = require('moment');
const expressLayouts = require('express-ejs-layouts');
const db = require('./models/database');

const app = express();
const port = 3000;

// Set up EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Set up express-ejs-layouts
app.use(expressLayouts);
app.set('layout', 'layout');

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Make moment available in all views
app.locals.moment = moment;

// Routes for items
app.get('/', (req, res) => {
    const query = `
        SELECT i.*,
               d.price as current_price,
               d.timestamp as price_timestamp,
               s.name as store_name,
               s.website as store_website
        FROM items i
        LEFT JOIN (
            SELECT item_id, price, timestamp
            FROM item_datapoints d1
            WHERE timestamp = (
                SELECT MAX(timestamp)
                FROM item_datapoints d2
                WHERE d2.item_id = d1.item_id
            )
        ) d ON i.id = d.item_id
        LEFT JOIN stores s ON i.store_id = s.id
        ORDER BY i.name
    `;

    db.all(query, [], (err, items) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database error');
        }
        res.render('items/index', { items });
    });
});

app.get('/items/new', (req, res) => {
    db.all('SELECT id, name FROM stores ORDER BY name', [], (err, stores) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database error');
        }
        res.render('items/new', { stores });
    });
});

app.post('/items', (req, res) => {
    const { url, name, target_price, image_url, store_id } = req.body;
    db.run(
        'INSERT INTO items (url, name, target_price, image_url, store_id) VALUES (?, ?, ?, ?, ?)',
        [url, name, target_price, image_url, store_id],
        function(err) {
            if (err) {
                console.error(err);
                return res.status(500).send('Error creating item');
            }
            
            // Create initial scraping task
            const itemId = this.lastID;
            const scheduledTime = new Date()
                .toISOString()
                .replace('T', ' ')
                .replace(/\.\d+Z$/, '');
            
            db.run(
                'INSERT INTO scraping_tasks (item_id, url, scheduled_time) VALUES (?, ?, ?)',
                [itemId, url, scheduledTime],
                (err) => {
                    if (err) {
                        console.error('Error creating scraping task:', err);
                        // Continue with redirect even if scraping task creation fails
                    }
                    res.redirect('/');
                }
            );
        }
    );
});

app.get('/items/:id', (req, res) => {
    const id = req.params.id;
    db.get('SELECT * FROM items WHERE id = ?', [id], (err, item) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database error');
        }
        if (!item) {
            return res.status(404).send('Item not found');
        }
        db.all('SELECT * FROM item_datapoints WHERE item_id = ? ORDER BY timestamp DESC', [id], (err, datapoints) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Database error');
            }
            res.render('items/show', { item, datapoints });
        });
    });
});

app.get('/items/:id/edit', (req, res) => {
    const id = req.params.id;
    db.get('SELECT * FROM items WHERE id = ?', [id], (err, item) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database error');
        }
        if (!item) {
            return res.status(404).send('Item not found');
        }
        db.all('SELECT id, name FROM stores ORDER BY name', [], (err, stores) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Database error');
            }
            res.render('items/edit', { item, stores });
        });
    });
});

app.post('/items/:id', (req, res) => {
    const id = req.params.id;
    const { url, name, target_price, image_url, enabled, store_id } = req.body;
    db.run(
        'UPDATE items SET url = ?, name = ?, target_price = ?, image_url = ?, enabled = ?, store_id = ? WHERE id = ?',
        [url, name, target_price, image_url, enabled ? 1 : 0, store_id, id],
        (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error updating item');
            }
            res.redirect(`/items/${id}`);
        }
    );
});

app.post('/items/:id/delete', (req, res) => {
    const id = req.params.id;
    db.run('DELETE FROM items WHERE id = ?', [id], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error deleting item');
        }
        res.redirect('/');
    });
});

// Routes for stores
app.get('/stores', (req, res) => {
    const query = `
        SELECT s.*,
               COUNT(i.id) as items_count
        FROM stores s
        LEFT JOIN items i ON s.id = i.store_id
        GROUP BY s.id
        ORDER BY s.name
    `;

    db.all(query, [], (err, stores) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database error');
        }
        res.render('stores/index', { stores });
    });
});

app.get('/stores/new', (req, res) => {
    res.render('stores/new');
});

app.post('/stores', (req, res) => {
    const { name, website } = req.body;
    db.run(
        'INSERT INTO stores (name, website) VALUES (?, ?)',
        [name, website],
        (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error creating store');
            }
            res.redirect('/stores');
        }
    );
});

app.get('/stores/:id/edit', (req, res) => {
    const id = req.params.id;
    db.get('SELECT * FROM stores WHERE id = ?', [id], (err, store) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database error');
        }
        if (!store) {
            return res.status(404).send('Store not found');
        }
        res.render('stores/edit', { store });
    });
});

app.post('/stores/:id', (req, res) => {
    const id = req.params.id;
    const { name, website } = req.body;
    db.run(
        'UPDATE stores SET name = ?, website = ? WHERE id = ?',
        [name, website, id],
        (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error updating store');
            }
            res.redirect('/stores');
        }
    );
});

app.post('/stores/:id/delete', (req, res) => {
    const id = req.params.id;
    db.run('DELETE FROM stores WHERE id = ?', [id], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error deleting store');
        }
        res.redirect('/stores');
    });
});

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
}); 