# Shopping Price Tracker

A web application for tracking product prices. You can add items you want to monitor, set target prices, and view price history.

## Features

- Add items to track with URLs, names, and target prices
- Optional image URLs for visual reference
- Enable/disable tracking for specific items
- View price history for each item
- Responsive design that works on mobile and desktop

## Prerequisites

- Node.js (v12 or higher)
- npm (comes with Node.js)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd shopping
```

2. Install dependencies:
```bash
npm install
```

3. Start the application:
```bash
npm start
```

The application will be available at http://localhost:3000

## Database

The application uses SQLite for data storage. The database file (`shopping.db`) will be created automatically when you first run the application.

## Project Structure

- `app.js` - Main application file
- `models/database.js` - Database configuration and models
- `views/` - EJS templates for the web interface
- `public/` - Static files (CSS, images, etc.)

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the ISC License. 