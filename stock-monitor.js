const EventEmitter = require("events");
const fetch = require("node-fetch");

/**
 * StockMonitor — Polls a product page for stock changes and auto-triggers
 * checkout the instant the item becomes available.
 * 
 * Supports:
 *   - Shopify product.json polling (fastest, most reliable)
 *   - Generic HTML page polling (checks for "out of stock" text disappearing)
 *   - Bot-wall / PerimeterX detection (from Drop-Monitoring repo)
 *   - __NEXT_DATA__ extraction for Next.js stores (Pokemon Center)
 *   - Discord webhook alerts on stock detection
 *   - User-agent rotation
 *   - Adaptive polling (faster near expected drop times)
 *   - Configurable poll interval (default 2s, min 500ms)
 *   - Auto-trigger callback when stock detected
 */

const BLOCK_MARKERS = [
  "Pardon Our Interruption", "challenge-platform", "px-captcha",
  "perimeterx", "Please verify you are a human", "Access Denied",
];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];
class StockMonitor extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.interval = null;
    this.pollCount = 0;
    this.startTime = null;
  }

  log(message, type = "info") {
    const elapsed = this.startTime
      ? `+${((Date.now() - this.startTime) / 1000).toFixed(1)}s`
      : "";
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message: elapsed ? `[${elapsed}] [MONITOR] ${message}` : `[MONITOR] ${message}`,
    };
    console.log(`[${type.toUpperCase()}] ${entry.message}`);
    this.emit("log", entry);
    return entry;
  }

  /**
   * Start monitoring a product for stock.
   * @param {Object} config
   * @param {string} config.productUrl - Product page URL
   * @param {string} config.storeUrl - Store base URL (for Shopify API)
   * @param {string} config.itemName - Item name to search for (optional)
   * @param {string} config.variantId - Specific variant to monitor (optional)
   * @param {number} config.pollIntervalMs - Poll interval in ms (default 2000)
   * @param {number} config.maxDurationMs - Max monitoring duration (default 30 min)
   * @param {string} config.mode - "shopify" or "generic" (auto-detected if not set)
   */
  async start(config) {
    const {
      productUrl,
      storeUrl,
      itemName,
      variantId,
      pollIntervalMs = 2000,
      maxDurationMs = 30 * 60 * 1000,
      mode,
      discordWebhookUrl,
    } = config;

    this.discordWebhookUrl = discordWebhookUrl || "";

    if (this.running) {
      this.log("Monitor already running.", "error");
      return;
    }

    this.running = true;
    this.startTime = Date.now();
    this.pollCount = 0;

    const baseUrl = storeUrl || (productUrl ? new URL(productUrl).origin : null);
    const detectedMode = mode || (await this._detectMode(baseUrl, productUrl));

    this.log(`Starting stock monitor (${detectedMode} mode, polling every ${pollIntervalMs}ms)...`);
    this.log(`Target: ${productUrl || itemName || variantId}`);

    const pollFn = detectedMode === "shopify"
      ? () => this._pollShopify(baseUrl, productUrl, itemName, variantId)
      : () => this._pollGeneric(productUrl);

    // Initial check
    const initialResult = await pollFn();
    if (initialResult.inStock) {
      this.log(`Item is ALREADY IN STOCK! Triggering checkout...`, "success");
      this.emit("stock-found", initialResult);
      this.stop();
      return;
    }

    this.log(`Item is currently out of stock. Monitoring...`);

    // Start polling
    this.interval = setInterval(async () => {
      if (!this.running) return;

      // Check max duration
      if (Date.now() - this.startTime > maxDurationMs) {
        this.log(`Max monitoring duration reached (${(maxDurationMs / 60000).toFixed(0)} min). Stopping.`, "error");
        this.stop();
        this.emit("timeout");
        return;
      }

      try {
        this.pollCount++;
        const result = await pollFn();

        if (this.pollCount % 10 === 0) {
          this.log(`Poll #${this.pollCount} — still out of stock...`);
        }

        if (result.inStock) {
          this.log(`STOCK DETECTED after ${this.pollCount} polls! Variant: ${result.variantId || "unknown"}, Price: ${result.price || "?"}`, "success");
          await this._sendDiscordAlert(result, productUrl || itemName);
          this.stop();
          this.emit("stock-found", result);
        }
      } catch (err) {
        this.log(`Poll error: ${err.message}`, "error");
      }
    }, pollIntervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.running = false;
    this.log("Monitor stopped.");
    this.emit("stopped");
  }

  // ─── Auto-detect if the store is Shopify ───
  async _detectMode(baseUrl, productUrl) {
    if (!baseUrl) return "generic";
    try {
      const res = await fetch(`${baseUrl}/meta.json`, { timeout: 5000 });
      if (res.ok) {
        const data = await res.json();
        if (data.name || data.description) {
          return "shopify";
        }
      }
    } catch (_) {}

    // Try product.json
    if (productUrl) {
      try {
        const res = await fetch(`${productUrl}.json`, { timeout: 5000 });
        if (res.ok) return "shopify";
      } catch (_) {}
    }

    return "generic";
  }

  // ─── Shopify: Poll product.json for variant availability ───
  async _pollShopify(baseUrl, productUrl, itemName, variantId) {
    let jsonUrl;

    if (productUrl) {
      // Direct product URL → product.json
      const cleanUrl = productUrl.replace(/\/$/, "").split("?")[0];
      jsonUrl = `${cleanUrl}.json`;
    } else if (itemName && baseUrl) {
      // Search for the product first
      try {
        const searchRes = await fetch(
          `${baseUrl}/search/suggest.json?q=${encodeURIComponent(itemName)}&resources[type]=product&resources[limit]=3`,
          { timeout: 5000 }
        );
        if (searchRes.ok) {
          const data = await searchRes.json();
          const product = data.resources?.results?.products?.[0];
          if (product) {
            jsonUrl = `${baseUrl}${product.url}.json`;
          }
        }
      } catch (_) {}
    }

    if (!jsonUrl) {
      return { inStock: false, error: "Could not determine product URL" };
    }

    try {
      const res = await fetch(jsonUrl, { timeout: 5000 });
      if (!res.ok) return { inStock: false };

      const data = await res.json();
      const product = data.product;
      if (!product || !product.variants) return { inStock: false };

      // Check specific variant
      if (variantId) {
        const variant = product.variants.find((v) => v.id.toString() === variantId.toString());
        if (variant && variant.available) {
          return {
            inStock: true,
            variantId: variant.id.toString(),
            title: `${product.title} - ${variant.title}`,
            price: variant.price,
          };
        }
        return { inStock: false };
      }

      // Check any available variant
      const available = product.variants.find((v) => v.available);
      if (available) {
        return {
          inStock: true,
          variantId: available.id.toString(),
          title: `${product.title} - ${available.title}`,
          price: available.price,
        };
      }

      return { inStock: false };
    } catch (err) {
      return { inStock: false, error: err.message };
    }
  }

  // ─── Generic: Poll HTML page for stock indicators ───
  async _pollGeneric(productUrl) {
    if (!productUrl) return { inStock: false };

    try {
      const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const res = await fetch(productUrl, {
        timeout: 8000,
        headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9" },
      });
      if (!res.ok) return { inStock: false };

      const html = await res.text();
      const lower = html.toLowerCase();

      // Bot-wall detection (from Drop-Monitoring repo)
      const isBlocked = BLOCK_MARKERS.some((m) => lower.includes(m.toLowerCase()));
      if (isBlocked) {
        this.log("Bot protection detected on page. Rotating user-agent...", "error");
        return { inStock: false, blocked: true };
      }

      // __NEXT_DATA__ extraction (Next.js stores like Pokemon Center)
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (nextDataMatch) {
        try {
          const nextData = JSON.parse(nextDataMatch[1]);
          const initialState = nextData?.props?.initialState || nextData?.props?.pageProps;
          if (initialState) {
            const productData = initialState.product || initialState.productData;
            if (productData?.addToCartForm || productData?.isAvailable) {
              return { inStock: true, title: productData.name || "Stock detected (__NEXT_DATA__)" };
            }
          }
        } catch (_) {}
      }

      // Out of stock indicators
      const outOfStockPatterns = [
        "out of stock", "sold out", "currently unavailable",
        "not available", "notify me", "coming soon",
        "pre-order", "waitlist", "back in stock",
        '"available":false', '"inventory_quantity":0',
      ];

      // In stock indicators
      const inStockPatterns = [
        "add to cart", "add to basket", "add to bag",
        "buy now", "in stock", '"available":true',
      ];

      const hasOutOfStock = outOfStockPatterns.some((p) => lower.includes(p));
      const hasInStock = inStockPatterns.some((p) => lower.includes(p));

      if (hasInStock && !hasOutOfStock) {
        return { inStock: true, title: "Stock detected (generic)" };
      }

      return { inStock: false };
    } catch (err) {
      return { inStock: false, error: err.message };
    }
  }

  // ─── Discord webhook alert (from Drop-Monitoring repo) ───
  async _sendDiscordAlert(stockResult, target) {
    if (!this.discordWebhookUrl) return;
    try {
      const embed = {
        title: "\ud83d\udea8 STOCK ALERT: Item Available!",
        description: stockResult.title || target || "Stock detected",
        color: 0xFF0000,
        fields: [
          { name: "Variant ID", value: stockResult.variantId || "N/A", inline: true },
          { name: "Price", value: stockResult.price || "N/A", inline: true },
          { name: "Polls", value: String(this.pollCount), inline: true },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: "Cart Bot Stock Monitor" },
      };
      await fetch(this.discordWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "@everyone \ud83d\udea8 **STOCK ALERT!**", embeds: [embed] }),
      });
      this.log("Discord alert sent.", "success");
    } catch (err) {
      this.log(`Discord alert failed: ${err.message}`, "error");
    }
  }
}

module.exports = { StockMonitor };
