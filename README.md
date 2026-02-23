# Cart Bot — Auto Add to Cart

A browser automation system that navigates to a webpage, finds a pre-configured item by name, and automatically clicks "Add to Cart" / "Add to Basket".

## Setup

```bash
npm install
```

## Usage

```bash
npm start
```

Then open **http://localhost:3000** in your browser.

### Configuration

| Field | Description |
|---|---|
| **Target URL** | The webpage URL to navigate to (e.g. a product listing page) |
| **Item Name** | The name of the item to search for on the page |
| **Click item first** | If checked, clicks the item to go to its product page before looking for the Add to Cart button |
| **Headless mode** | If checked, runs the browser in the background (no visible window) |

### How it works

1. Launches a Chromium browser via Puppeteer
2. Navigates to the target URL
3. Searches the page for elements matching the item name (links, headings, product cards, etc.)
4. Optionally clicks the item to navigate to its detail/product page
5. Finds and clicks the "Add to Cart" / "Add to Basket" button using multiple detection strategies:
   - Text content matching (`add to cart`, `add to basket`, `add to bag`, `buy now`, etc.)
   - CSS class/ID pattern matching (`[class*="cart"]`, `[id*="addToCart"]`, etc.)
6. Reports success/failure with detailed logs

### API

- **POST /api/run** — Start the bot with `{ url, itemName, headless?, clickItemFirst? }`
- **POST /api/stop** — Stop the active browser instance
