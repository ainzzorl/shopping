const puppeteer = require("puppeteer");
const { extractPrice } = require("../workers/scraper");

// Set test environment
process.env.NODE_ENV = "test";

describe("Price Extraction Tests", () => {
  let browser;
  let page;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: "new",
      product: "chrome",
      executablePath: process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0"
    );
  });

  afterEach(async () => {
    await page.close();
  });

  test("should extract price from og:price:amount meta tag", async () => {
    await page.setContent(`
      <html>
        <head>
          <meta property="og:price:amount" content="99.99">
        </head>
        <body>
          <div class="price">$129.99</div>
        </body>
      </html>
    `);

    const price = await extractPrice(page);
    expect(price).toBe(99.99);
  });

  test("should ignore commas in og:price:amount meta tag", async () => {
    await page.setContent(`
      <html>
        <head>
          <meta property="og:price:amount" content="99,999.99">
        </head>
        <body>
          <div class="price">$129.99</div>
        </body>
      </html>
    `);

    const price = await extractPrice(page);
    expect(price).toBe(99999.99);
  });

  test("should extract price from data-price attribute", async () => {
    await page.setContent(`
      <html>
        <body>
          <div data-price="149.99">$149.99</div>
        </body>
      </html>
    `);

    const price = await extractPrice(page);
    expect(price).toBe(149.99);
  });

  test('should extract price from class containing "price"', async () => {
    await page.setContent(`
      <html>
        <body>
          <div class="product-price">$199.99</div>
        </body>
      </html>
    `);

    const price = await extractPrice(page);
    expect(price).toBe(199.99);
  });

  test("should handle prices with commas", async () => {
    await page.setContent(`
      <html>
        <body>
          <div class="price">$1,299.99</div>
        </body>
      </html>
    `);

    const price = await extractPrice(page);
    expect(price).toBe(1299.99);
  });

  test("should return null when no price is found", async () => {
    await page.setContent(`
      <html>
        <body>
          <div>No price here</div>
        </body>
      </html>
    `);

    const price = await extractPrice(page);
    expect(price).toBeNull();
  });
});
