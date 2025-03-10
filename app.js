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
    db.all('SELECT * FROM items ORDER BY name', [], (err, items) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database error');
        }
        res.render('items/index', { items });
    });
});

app.get('/items/new', (req, res) => {
    res.render('items/new');
});

app.post('/items', (req, res) => {
    const { url, name, target_price, image_url } = req.body;
    db.run(
        'INSERT INTO items (url, name, target_price, image_url) VALUES (?, ?, ?, ?)',
        [url, name, target_price, image_url],
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
        res.render('items/edit', { item });
    });
});

app.post('/items/:id', (req, res) => {
    const id = req.params.id;
    const { url, name, target_price, image_url, enabled } = req.body;
    db.run(
        'UPDATE items SET url = ?, name = ?, target_price = ?, image_url = ?, enabled = ? WHERE id = ?',
        [url, name, target_price, image_url, enabled ? 1 : 0, id],
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

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
}); 