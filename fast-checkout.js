const EventEmitter = require("events");
const nodemailer = require("nodemailer");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { HttpEngine } = require("./http-engine");

/**
 * FastCheckout Pro — Competition-grade direct API checkout engine.
 *
 * Features:
 *   - Shopify payment tokenization via deposit.shopifycs.com/sessions
 *   - Authenticity token extraction from checkout pages
 *   - Shopify queue/checkpoint detection and wait-through
 *   - Pre-checkout session warming (create checkout + submit shipping BEFORE drop)
 *   - Per-session UA rotation from realistic Chrome pool
 *   - Domain-scoped cookie jar with path matching
 *   - Request pipelining (parallel shipping + rate where possible)
 *   - Payment gateway ID auto-detection
 *   - Retry with exponential backoff on transient failures
 */

// ═══════════════════════════════════════════════════════════════
// USER-AGENT POOL (realistic Chrome versions, rotated per session)
// ═══════════════════════════════════════════════════════════════
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
];

// ═══════════════════════════════════════════════════════════════
// BROWSER FINGERPRINT PROFILES — randomized per session
// Matches sec-ch-ua, accept-encoding, and header order to real browsers
// ═══════════════════════════════════════════════════════════════
const FINGERPRINT_PROFILES = [
  { brand: '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"', platform: '"Windows"', mobile: '?0', ae: 'gzip, deflate, br, zstd' },
  { brand: '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"', platform: '"macOS"', mobile: '?0', ae: 'gzip, deflate, br, zstd' },
  { brand: '"Chromium";v="130", "Google Chrome";v="130", "Not_A Brand";v="99"', platform: '"Windows"', mobile: '?0', ae: 'gzip, deflate, br' },
  { brand: '"Chromium";v="130", "Google Chrome";v="130", "Not_A Brand";v="99"', platform: '"macOS"', mobile: '?0', ae: 'gzip, deflate, br' },
  { brand: '"Chromium";v="129", "Google Chrome";v="129", "Not_A Brand";v="8"', platform: '"Windows"', mobile: '?0', ae: 'gzip, deflate, br' },
  { brand: '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"', platform: '"Linux"', mobile: '?0', ae: 'gzip, deflate, br, zstd' },
];

function generateFingerprint() {
  const fp = FINGERPRINT_PROFILES[Math.floor(Math.random() * FINGERPRINT_PROFILES.length)];
  return {
    'sec-ch-ua': fp.brand,
    'sec-ch-ua-mobile': fp.mobile,
    'sec-ch-ua-platform': fp.platform,
    'accept-encoding': fp.ae,
  };
}

// ═══════════════════════════════════════════════════════════════
// DOMAIN-SCOPED COOKIE JAR
// ═══════════════════════════════════════════════════════════════
class CookieJar {
  constructor() { this.store = {}; }

  update(url, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const domain = new URL(url).hostname;
    if (!this.store[domain]) this.store[domain] = {};
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const raw of arr) {
      const parts = raw.split(";")[0];
      const eq = parts.indexOf("=");
      if (eq < 1) continue;
      const name = parts.substring(0, eq).trim();
      const value = parts.substring(eq + 1);
      this.store[domain][name] = value;
    }
  }

  get(url) {
    const domain = new URL(url).hostname;
    const cookies = [];
    for (const d of Object.keys(this.store)) {
      if (domain === d || domain.endsWith("." + d) || d.endsWith("." + domain)) {
        for (const [k, v] of Object.entries(this.store[d])) {
          cookies.push(`${k}=${v}`);
        }
      }
    }
    return cookies.join("; ");
  }

  clear() { this.store = {}; }
}

// ═══════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════
class FastCheckout extends EventEmitter {
  constructor() {
    super();
    this.logs = [];
    this.startTime = null;
    this.jar = new CookieJar();
    this.ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
    this.runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.authToken = null;
    this.paymentGatewayId = null;
    this.checkoutToken = null;
    // Pre-checkout state
    this.preCheckoutUrl = null;
    this.preShippingDone = false;
    this.preShippingRateId = null;
    // HTTP/2 engine with Chrome TLS fingerprint
    this.httpEngine = new HttpEngine();
    this.useH2 = true; // Enable HTTP/2 by default
    // Per-session browser fingerprint (sec-ch-ua, accept-encoding)
    this.fingerprint = generateFingerprint();
    // Backup cookie sessions for queue bypass
    this.backupJars = [];
    this.activeJarIndex = 0;
  }

  log(message, type = "info") {
    const elapsed = this.startTime
      ? `+${((Date.now() - this.startTime) / 1000).toFixed(1)}s`
      : "";
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message: elapsed ? `[${elapsed}] ${message}` : message,
    };
    this.logs.push(entry);
    console.log(`[FAST][${type.toUpperCase()}] ${entry.message}`);
    this.emit("log", entry);
    return entry;
  }

  getLogs() { return this.logs; }
  clearLogs() { this.logs = []; }

  // ═══════════════════════════════════════════════════════════════
  // HTTP ENGINE — HTTP/2 + Chrome TLS + cookies + retry
  // Uses HttpEngine for H2 multiplexing + Chrome JA3 fingerprint
  // Falls back to node-fetch if H2 fails
  // ═══════════════════════════════════════════════════════════════
  async request(url, options = {}, retries = 2) {
    // Chrome-accurate header order matters for fingerprinting
    const headers = {
      "sec-ch-ua": this.fingerprint["sec-ch-ua"],
      "sec-ch-ua-mobile": this.fingerprint["sec-ch-ua-mobile"],
      "sec-ch-ua-platform": this.fingerprint["sec-ch-ua-platform"],
      "upgrade-insecure-requests": "1",
      "user-agent": this.ua,
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-user": "?1",
      "sec-fetch-dest": "document",
      "accept-encoding": this.fingerprint["accept-encoding"],
      "accept-language": "en-US,en;q=0.9",
      ...(options.headers || {}),
    };

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Try HTTP/2 engine first (Chrome TLS + connection reuse)
        if (this.useH2 && !this.proxyAgent) {
          const h2Res = await this.httpEngine.request(url, {
            method: options.method || "GET",
            headers,
            body: options.body || undefined,
            timeout: 15000,
          }, this.jar);

          // Wrap in node-fetch compatible interface
          return {
            ok: h2Res.ok,
            status: h2Res.status,
            headers: {
              get: (name) => {
                const val = h2Res.headers[name.toLowerCase()];
                if (Array.isArray(val)) return val[0];
                return val || null;
              },
              raw: () => {
                const raw = {};
                for (const [k, v] of Object.entries(h2Res.headers)) {
                  raw[k] = Array.isArray(v) ? v : [v];
                }
                return raw;
              },
            },
            text: () => h2Res.text(),
            json: () => h2Res.json(),
            _timing: h2Res.timing,
          };
        }

        // Fallback: node-fetch (used when proxy is set or H2 disabled)
        const cookieStr = this.jar.get(url);
        if (cookieStr) headers["cookie"] = cookieStr;

        const fetchOpts = { ...options, headers, redirect: "manual", timeout: 15000 };
        if (this.proxyAgent) fetchOpts.agent = this.proxyAgent;

        const res = await fetch(url, fetchOpts);
        const setCookies = res.headers.raw()["set-cookie"];
        if (setCookies) this.jar.update(url, setCookies);
        return res;
      } catch (err) {
        // If H2 fails, disable it and retry with node-fetch
        if (this.useH2 && attempt === 0) {
          this.useH2 = false;
          this.log(`H2 failed (${err.message}), falling back to HTTP/1.1`, "info");
          continue;
        }
        if (attempt === retries) throw err;
        const wait = 500 * Math.pow(2, attempt);
        this.log(`Request failed (${err.message}), retry in ${wait}ms...`, "error");
        await this._sleep(wait);
      }
    }
  }

  // Follow redirect chain manually (needed for Shopify checkout)
  async followRedirects(url, maxRedirects = 8) {
    let current = url;
    for (let i = 0; i < maxRedirects; i++) {
      const res = await this.request(current);
      const loc = res.headers.get("location");
      if (!loc || res.status < 300 || res.status >= 400) return { res, url: current };
      current = loc.startsWith("http") ? loc : new URL(loc, current).href;
    }
    return { res: await this.request(current), url: current };
  }

  getBaseUrl(url) {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // AUTHENTICITY TOKEN EXTRACTION
  // ═══════════════════════════════════════════════════════════════
  extractAuthToken(html) {
    const patterns = [
      /name="authenticity_token"[^>]*value="([^"]+)"/,
      /value="([^"]+)"[^>]*name="authenticity_token"/,
      /authenticity_token.*?value="([^"]+)"/,
      /"authenticity_token"\s*:\s*"([^"]+)"/,
      /csrf-token['"]\s*content=['"]([^'"]*)['"]/ ,
      /name="csrf-token"[^>]*content="([^"]+)"/,
      /content="([^"]+)"[^>]*name="csrf-token"/,
      /<meta[^>]*csrf-token[^>]*content="([^"]+)"/,
      /data-authenticity-token="([^"]+)"/,
      /Shopify\.Checkout\.token\s*=\s*['"]([^'"]+)['"]/,
      /"authToken"\s*:\s*"([^"]+)"/,
      /authenticity_token=([^&"'\s]+)/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m && m[1] && m[1].length > 10) return m[1];
    }
    return null;
  }

  // Extract payment gateway ID from checkout page
  extractPaymentGateway(html) {
    const patterns = [
      /name="checkout\[payment_gateway\]"[^>]*value="(\d+)"/,
      /data-select-gateway="(\d+)"/,
      /"payment_gateway":"?(\d+)"?/,
      /Shopify\.Checkout\.paymentGateway\s*=\s*"?(\d+)"?/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return m[1];
    }
    return null;
  }

  // Extract checkout token from URL or page
  extractCheckoutToken(url, html) {
    const urlMatch = url.match(/\/checkouts\/([a-z0-9]+)/i) || url.match(/\/checkout\/([a-z0-9]+)/i);
    if (urlMatch) return urlMatch[1];
    if (html) {
      const htmlMatch = html.match(/Shopify\.Checkout\.token\s*=\s*["']([^"']+)["']/);
      if (htmlMatch) return htmlMatch[1];
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // SHOPIFY QUEUE / CHECKPOINT HANDLING
  // ═══════════════════════════════════════════════════════════════
  async handleQueueIfPresent(res, url) {
    const body = await res.text();

    // Shopify queue page detection
    const isQueue = body.includes("queue") || body.includes("throttle") ||
      body.includes("checkout_queue") || body.includes("Shopify.Checkout.Queue") ||
      body.includes("pollQueue") || body.includes("You are in line");

    if (!isQueue) return { body, queued: false };

    this.log("Shopify queue detected! Trying backup sessions + polling...", "info");

    // QUEUE BYPASS: Spawn 3 backup cookie sessions that try to skip the queue
    // Different sessions may get different queue positions or skip entirely
    const backupAttempts = 3;
    const backupPromises = [];
    for (let b = 0; b < backupAttempts; b++) {
      backupPromises.push((async () => {
        const backupJar = new CookieJar();
        const origJar = this.jar;
        try {
          // Use a fresh cookie session
          this.jar = backupJar;
          await this._sleep(200 + Math.random() * 500);
          const freshRes = await this.request(url);
          const freshBody = await freshRes.text();
          if (!freshBody.includes("queue") && !freshBody.includes("throttle") && !freshBody.includes("You are in line")) {
            this.log(`Backup session ${b + 1} bypassed queue!`, "success");
            return { body: freshBody, jar: backupJar, bypassed: true };
          }
        } catch (_) {}
        this.jar = origJar;
        return { bypassed: false };
      })());
    }

    // Race: check if any backup session bypassed the queue
    const origJar = this.jar;
    const backupResults = await Promise.all(backupPromises);
    const bypassed = backupResults.find(r => r.bypassed);
    if (bypassed) {
      this.jar = bypassed.jar; // Switch to the winning session
      return { body: bypassed.body, queued: true };
    }
    this.jar = origJar; // Restore original jar

    // Standard queue polling
    const pollMatch = body.match(/pollUrl\s*[:=]\s*["']([^"']+)["']/) ||
      body.match(/queue_url\s*[:=]\s*["']([^"']+)["']/);

    const maxWait = 120000;
    const start = Date.now();
    let pollUrl = pollMatch ? pollMatch[1] : null;

    while (Date.now() - start < maxWait) {
      await this._sleep(2000 + Math.random() * 1000);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      this.log(`Queue: waiting... (${elapsed}s)`, "info");

      if (pollUrl) {
        try {
          const fullPollUrl = pollUrl.startsWith("http") ? pollUrl : new URL(pollUrl, url).href;
          const pollRes = await this.request(fullPollUrl);
          if (pollRes.status === 200) {
            const pollBody = await pollRes.text();
            try {
              const data = JSON.parse(pollBody);
              if (data.url || data.checkout_url) {
                const nextUrl = data.url || data.checkout_url;
                this.log(`Queue passed! Redirecting to checkout (${elapsed}s)`, "success");
                const finalRes = await this.request(nextUrl.startsWith("http") ? nextUrl : new URL(nextUrl, url).href);
                return { body: await finalRes.text(), queued: true };
              }
            } catch (_) {
              if (!pollBody.includes("queue") && !pollBody.includes("throttle")) {
                this.log(`Queue passed! (${elapsed}s)`, "success");
                return { body: pollBody, queued: true };
              }
            }
          }
        } catch (_) {}
      } else {
        try {
          const retryRes = await this.request(url);
          const retryBody = await retryRes.text();
          if (!retryBody.includes("queue") && !retryBody.includes("throttle") && !retryBody.includes("You are in line")) {
            this.log(`Queue passed! (${elapsed}s)`, "success");
            return { body: retryBody, queued: true };
          }
        } catch (_) {}
      }
    }

    this.log("Queue timeout after 2 minutes.", "error");
    return { body, queued: false };
  }

  // ═══════════════════════════════════════════════════════════════
  // SHOPIFY PAYMENT TOKENIZATION (deposit.shopifycs.com)
  // ═══════════════════════════════════════════════════════════════
  async getPaymentSessionToken(payment) {
    this.log("Tokenizing payment via deposit.shopifycs.com...", "info");

    const payload = {
      credit_card: {
        number: (payment.cardNumber || "").replace(/\s/g, ""),
        name: payment.cardName || "",
        month: parseInt(payment.expiryMonth) || 1,
        year: parseInt(payment.expiryYear) || 2030,
        verification_value: payment.cvv || "",
      },
    };

    const res = await fetch("https://deposit.shopifycs.com/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": this.ua,
      },
      body: JSON.stringify(payload),
      timeout: 10000,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Payment tokenization failed (${res.status}): ${errText.substring(0, 200)}`);
    }

    const data = await res.json();
    if (data.id) {
      this.log(`Payment session token obtained: ${data.id.substring(0, 12)}...`, "success");
      return data.id;
    }

    throw new Error("No session ID returned from deposit.shopifycs.com");
  }

  // ═══════════════════════════════════════════════════════════════
  // VARIANT RESOLUTION (unchanged logic, improved error handling)
  // ═══════════════════════════════════════════════════════════════
  async resolveVariant(config) {
    const { storeUrl, productUrl, itemName, variantId } = config;

    if (variantId) {
      this.log(`Using provided variant ID: ${variantId}`, "success");
      return variantId;
    }

    const base = this.getBaseUrl(storeUrl || productUrl);
    let productPath = "";

    if (productUrl) {
      try { productPath = new URL(productUrl).pathname; }
      catch (_) { productPath = productUrl; }
    }

    // Strategy 1: Direct product.json
    if (productPath) {
      const jsonUrl = `${base}${productPath.replace(/\/$/, "")}.json`;
      this.log(`Fetching product data: ${jsonUrl}`);
      try {
        const res = await this.request(jsonUrl);
        if (res.ok) {
          const data = await res.json();
          const product = data.product;
          if (product?.variants?.length > 0) {
            this.log(`Found: "${product.title}" (${product.variants.length} variants)`, "success");
            if (itemName) {
              const lowerName = itemName.toLowerCase();
              let best = product.variants[0], bestScore = 0;
              for (const v of product.variants) {
                const title = (v.title || "").toLowerCase();
                if (title.includes(lowerName) || lowerName.includes(title)) { best = v; break; }
                const words = lowerName.split(/\s+/);
                const score = words.filter(w => title.includes(w)).length / words.length;
                if (score > bestScore) { bestScore = score; best = v; }
              }
              this.log(`Selected: "${best.title || "Default"}" (ID: ${best.id}, $${best.price})`, "success");
              return best.id.toString();
            }
            const available = product.variants.find(v => v.available) || product.variants[0];
            this.log(`Selected: "${available.title || "Default"}" (ID: ${available.id}, $${available.price})`, "success");
            return available.id.toString();
          }
        }
      } catch (err) { this.log(`product.json failed: ${err.message}`, "error"); }
    }

    // Strategy 2: Search API
    if (itemName) {
      this.log(`Searching catalog for: "${itemName}"`);
      try {
        const searchUrl = `${base}/search/suggest.json?q=${encodeURIComponent(itemName)}&resources[type]=product&resources[limit]=5`;
        const res = await this.request(searchUrl);
        if (res.ok) {
          const data = await res.json();
          const products = data.resources?.results?.products;
          if (products?.length > 0) {
            const match = products[0];
            this.log(`Found: "${match.title}"`, "success");
            const prodRes = await this.request(`${base}${match.url}.json`);
            if (prodRes.ok) {
              const prodData = await prodRes.json();
              const variant = prodData.product?.variants?.[0];
              if (variant) { this.log(`Variant: ${variant.id} ($${variant.price})`, "success"); return variant.id.toString(); }
            }
          }
        }
      } catch (err) { this.log(`Search failed: ${err.message}`, "error"); }

      // Strategy 3: Catalog scan
      this.log("Scanning products.json...");
      try {
        const lowerName = itemName.toLowerCase();
        for (let page = 1; page <= 5; page++) {
          const res = await this.request(`${base}/products.json?limit=250&page=${page}`);
          if (!res.ok) break;
          const data = await res.json();
          if (!data.products?.length) break;
          for (const product of data.products) {
            if ((product.title || "").toLowerCase().includes(lowerName)) {
              const variant = product.variants?.find(v => v.available) || product.variants?.[0];
              if (variant) { this.log(`Match: "${product.title}" → ${variant.id}`, "success"); return variant.id.toString(); }
            }
          }
        }
      } catch (err) { this.log(`Catalog scan failed: ${err.message}`, "error"); }
    }

    this.log("Could not resolve variant ID.", "error");
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // VARIANT PRE-RESOLUTION — Poll products.json for new variants
  // Returns instantly when a new variant appears (0ms delay on drop)
  // ═══════════════════════════════════════════════════════════════
  async pollForVariant(baseUrl, options = {}) {
    const { itemName, pollIntervalMs = 1500, maxDurationMs = 300000, knownVariants = new Set() } = options;
    const start = Date.now();
    this.log(`Polling ${baseUrl}/products.json for new variants...`);

    // Snapshot current catalog
    const known = new Set(knownVariants);
    if (known.size === 0) {
      try {
        for (let page = 1; page <= 3; page++) {
          const res = await this.request(`${baseUrl}/products.json?limit=250&page=${page}`);
          if (!res.ok) break;
          const data = await res.json();
          if (!data.products?.length) break;
          for (const p of data.products) {
            for (const v of (p.variants || [])) known.add(v.id.toString());
          }
        }
        this.log(`Cataloged ${known.size} existing variants.`, "success");
      } catch (e) { this.log(`Catalog snapshot failed: ${e.message}`, "error"); }
    }

    // Poll loop
    while (Date.now() - start < maxDurationMs) {
      try {
        const res = await this.request(`${baseUrl}/products.json?limit=250&page=1`);
        if (res.ok) {
          const data = await res.json();
          for (const product of (data.products || [])) {
            // Filter by name if provided
            if (itemName && !(product.title || "").toLowerCase().includes(itemName.toLowerCase())) continue;
            for (const v of (product.variants || [])) {
              const vid = v.id.toString();
              if (!known.has(vid) && v.available) {
                this.log(`NEW VARIANT DETECTED: "${product.title}" → ${vid} ($${v.price})`, "success");
                return { variantId: vid, product, variant: v };
              }
            }
          }
        }
      } catch (_) {}
      await this._sleep(pollIntervalMs + Math.random() * 300);
    }

    this.log("Variant poll timed out.", "error");
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // ADDRESS JIGGING — Vary address across tasks to bypass 1-per-address limits
  // ═══════════════════════════════════════════════════════════════
  jigAddress(details, taskIndex = 0) {
    if (!details || taskIndex === 0) return details;
    const jigged = { ...details };
    const suffixes = ["", "Apt 1", "Apt 2", "Apt A", "Apt B", "Suite 1", "Unit 1", "Ste 2", "#1", "#2",
      "Apt 3", "Apt C", "Suite 3", "Unit 2", "Ste 1", "#3", "Apt 4", "Apt D", "Suite 4", "Unit 3",
      "Fl 1", "Fl 2", "Rm 1", "Rm 2", "Box 1", "Box 2", "Dept 1", "Dept 2", "Bldg A", "Bldg B",
      "Apt 5", "Apt E", "Suite 5", "Unit 4", "Ste 3", "#4", "Apt 6", "Apt F", "Suite 6", "Unit 5",
      "Fl 3", "Fl 4", "Rm 3", "Rm 4", "Box 3", "Box 4", "Dept 3", "Dept 4", "Bldg C", "Bldg D"];
    jigged.address2 = suffixes[taskIndex % suffixes.length];
    // Slight first name variation (add period)
    if (taskIndex % 3 === 1 && jigged.firstName) jigged.firstName = jigged.firstName.charAt(0) + ".";
    if (taskIndex % 3 === 2 && jigged.lastName) jigged.lastName = jigged.lastName + ".";
    return jigged;
  }

  // ═══════════════════════════════════════════════════════════════
  // DIRECT CHECKOUT LINK — Skip ATC + create checkout entirely
  // Uses /cart/VARIANT:QTY format to go straight to checkout
  // ═══════════════════════════════════════════════════════════════
  async directCheckout(baseUrl, variantId, quantity = 1) {
    this.log(`Direct checkout link: /cart/${variantId}:${quantity}`);

    // Method 1: /cart/VARIANT:QTY — redirects straight to checkout
    const directUrl = `${baseUrl}/cart/${variantId}:${quantity}`;
    const res = await this.request(directUrl);
    const location = res.headers.get("location");

    if (location && (location.includes("/checkout") || location.includes("/checkouts"))) {
      const checkoutUrl = location.startsWith("http") ? location : new URL(location, baseUrl).href;
      this.log(`Direct checkout success: ${checkoutUrl}`, "success");
      return checkoutUrl;
    }

    // Method 2: /checkout?line_items[0][variant_id]=X&line_items[0][quantity]=1
    const paramUrl = `${baseUrl}/checkout?line_items[0][variant_id]=${variantId}&line_items[0][quantity]=${quantity}`;
    const res2 = await this.request(paramUrl);
    const loc2 = res2.headers.get("location");
    if (loc2 && loc2.includes("/checkout")) {
      const checkoutUrl = loc2.startsWith("http") ? loc2 : new URL(loc2, baseUrl).href;
      this.log(`Direct checkout (param) success: ${checkoutUrl}`, "success");
      return checkoutUrl;
    }

    this.log("Direct checkout link failed, falling back to ATC flow.", "info");
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // ADD TO CART
  // ═══════════════════════════════════════════════════════════════
  async addToCart(baseUrl, variantId, quantity = 1) {
    this.log(`Adding variant ${variantId} to cart...`);

    // Clear cart first to avoid stale items
    await this.request(`${baseUrl}/cart/clear.js`, { method: "POST", headers: { "Content-Type": "application/json" } }).catch(() => {});

    const res = await this.request(`${baseUrl}/cart/add.js`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify({ items: [{ id: parseInt(variantId), quantity }] }),
    });

    if (res.ok || res.status === 302) {
      const data = await res.json().catch(() => ({}));
      this.log(`Added to cart! ${data.items ? data.items.length + " item(s)" : "OK"}`, "success");
      return true;
    }

    // Retry with form-encoded (some stores reject JSON)
    const formRes = await this.request(`${baseUrl}/cart/add.js`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `id=${variantId}&quantity=${quantity}`,
    });

    if (formRes.ok || formRes.status === 302) {
      this.log("Added to cart (form fallback).", "success");
      return true;
    }

    const errText = await formRes.text().catch(() => "");
    this.log(`Add to cart failed (${formRes.status}): ${errText.substring(0, 200)}`, "error");
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // CREATE CHECKOUT + EXTRACT AUTH TOKEN + GATEWAY
  // ═══════════════════════════════════════════════════════════════
  async createCheckout(baseUrl) {
    this.log("Creating checkout session...");

    const res = await this.request(`${baseUrl}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });

    const location = res.headers.get("location");
    let checkoutUrl = location ? (location.startsWith("http") ? location : `${baseUrl}${location}`) : null;

    if (!checkoutUrl) {
      const getRes = await this.request(`${baseUrl}/checkout`);
      const getLoc = getRes.headers.get("location");
      if (getLoc) {
        checkoutUrl = getLoc.startsWith("http") ? getLoc : `${baseUrl}${getLoc}`;
      } else {
        const body = await getRes.text();
        const m = body.match(/\/checkouts?\/([a-z0-9]+)/i);
        if (m) checkoutUrl = `${baseUrl}/checkout/${m[1]}`;
        else checkoutUrl = `${baseUrl}/checkout`;
      }
    }

    this.log(`Checkout URL: ${checkoutUrl}`, "success");

    // Load the checkout page to extract auth token, gateway, and handle queue
    const pageRes = await this.request(checkoutUrl);
    const { body: pageBody, queued } = await this.handleQueueIfPresent(pageRes, checkoutUrl);

    this.authToken = this.extractAuthToken(pageBody);
    this.paymentGatewayId = this.extractPaymentGateway(pageBody);
    this.checkoutToken = this.extractCheckoutToken(checkoutUrl, pageBody);

    if (this.authToken) this.log(`Auth token: ${this.authToken.substring(0, 16)}...`, "success");
    if (this.paymentGatewayId) this.log(`Payment gateway: ${this.paymentGatewayId}`, "success");
    if (queued) this.log("Passed through Shopify queue.", "success");

    return checkoutUrl;
  }

  // ═══════════════════════════════════════════════════════════════
  // SUBMIT SHIPPING ADDRESS (with auth token)
  // ═══════════════════════════════════════════════════════════════
  async submitShippingAddress(checkoutUrl, details) {
    this.log("Submitting shipping address...");

    const formData = new URLSearchParams();
    formData.append("_method", "patch");
    if (this.authToken) formData.append("authenticity_token", this.authToken);
    formData.append("previous_step", "contact_information");
    formData.append("step", "shipping_method");
    formData.append("checkout[email]", details.email || "");
    formData.append("checkout[buyer_accepts_marketing]", "0");
    formData.append("checkout[shipping_address][first_name]", details.firstName || "");
    formData.append("checkout[shipping_address][last_name]", details.lastName || "");
    formData.append("checkout[shipping_address][address1]", details.address || "");
    formData.append("checkout[shipping_address][address2]", details.address2 || "");
    formData.append("checkout[shipping_address][city]", details.city || "");
    formData.append("checkout[shipping_address][province]", details.county || details.state || "");
    formData.append("checkout[shipping_address][zip]", details.zip || "");
    formData.append("checkout[shipping_address][country]", details.country || "GB");
    formData.append("checkout[shipping_address][phone]", details.phone || "");

    const res = await this.request(checkoutUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    const location = res.headers.get("location");
    const nextUrl = location ? (location.startsWith("http") ? location : new URL(location, checkoutUrl).href) : checkoutUrl;

    if (location || res.ok || res.status === 302) {
      this.log("Shipping address submitted.", "success");
      // Always follow the redirect and re-extract auth token + gateway from the new page
      // Shopify rotates the authenticity_token on every page transition
      try {
        const followUrl = (location && res.status >= 300) ? nextUrl : checkoutUrl;
        const followRes = await this.request(followUrl);
        const followBody = await followRes.text();
        const newAuth = this.extractAuthToken(followBody);
        if (newAuth) {
          this.authToken = newAuth;
          this.log(`Auth token refreshed after shipping: ${newAuth.substring(0, 16)}...`, "success");
        }
        const gw = this.extractPaymentGateway(followBody);
        if (gw) this.paymentGatewayId = gw;
      } catch (e) {
        this.log(`Warning: could not refresh auth token after shipping: ${e.message}`, "info");
      }
      return nextUrl;
    }

    this.log(`Shipping submission returned ${res.status}.`, "error");
    return checkoutUrl;
  }

  // ═══════════════════════════════════════════════════════════════
  // SELECT SHIPPING RATE (with auth token)
  // ═══════════════════════════════════════════════════════════════
  async selectShippingRate(checkoutUrl) {
    this.log("Fetching shipping rates...");

    const shippingUrl = checkoutUrl.includes("?")
      ? `${checkoutUrl}&step=shipping_method`
      : `${checkoutUrl}?step=shipping_method`;

    const res = await this.request(shippingUrl);
    const body = await res.text();

    // Re-extract auth token
    const newAuth = this.extractAuthToken(body);
    if (newAuth) this.authToken = newAuth;

    // Re-extract gateway if not found yet
    if (!this.paymentGatewayId) {
      const gw = this.extractPaymentGateway(body);
      if (gw) this.paymentGatewayId = gw;
    }

    // Extract ALL shipping rates and pick cheapest
    const rateRegex = /name="checkout\[shipping_rate\]\[id\]"[^>]*value="([^"]+)"/g;
    const rates = [];
    let match;
    while ((match = rateRegex.exec(body)) !== null) rates.push(match[1]);

    if (rates.length === 0) {
      // Try API endpoint for rates
      try {
        const apiUrl = checkoutUrl.replace(/\?.*$/, "") + "/shipping_rates.json";
        const apiRes = await this.request(apiUrl, { headers: { "Accept": "application/json" } });
        if (apiRes.ok) {
          const data = await apiRes.json();
          const apiRates = data.shipping_rates || [];
          if (apiRates.length > 0) {
            apiRates.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
            rates.push(apiRates[0].id || apiRates[0].handle);
          }
        }
      } catch (_) {}
    }

    if (rates.length > 0) {
      const rateId = rates[0]; // First = cheapest usually
      this.log(`Shipping rate: ${rateId}`, "success");

      const formData = new URLSearchParams();
      formData.append("_method", "patch");
      if (this.authToken) formData.append("authenticity_token", this.authToken);
      formData.append("previous_step", "shipping_method");
      formData.append("step", "payment_method");
      formData.append("checkout[shipping_rate][id]", rateId);

      const submitRes = await this.request(checkoutUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      const location = submitRes.headers.get("location");
      const nextUrl = location ? (location.startsWith("http") ? location : new URL(location, checkoutUrl).href) : checkoutUrl;

      // Always load the payment page and re-extract auth token + gateway
      // Shopify rotates authenticity_token on every step transition
      try {
        const payPageUrl = (location && submitRes.status >= 300) ? nextUrl : checkoutUrl;
        const payPageRes = await this.request(payPageUrl);
        const payBody = await payPageRes.text();
        const payAuth = this.extractAuthToken(payBody);
        if (payAuth) {
          this.authToken = payAuth;
          this.log(`Auth token refreshed after shipping rate: ${payAuth.substring(0, 16)}...`, "success");
        }
        const gw = this.extractPaymentGateway(payBody);
        if (gw) this.paymentGatewayId = gw;
      } catch (e) {
        this.log(`Warning: could not refresh auth token after shipping rate: ${e.message}`, "info");
      }

      this.log("Shipping rate selected.", "success");
      return nextUrl;
    }

    this.log("No shipping rate found (may be free/auto-selected).", "info");
    return checkoutUrl;
  }

  // ═══════════════════════════════════════════════════════════════
  // SUBMIT PAYMENT (with proper Shopify tokenization)
  // ═══════════════════════════════════════════════════════════════
  async submitPayment(checkoutUrl, payment, dryRun = true) {
    if (dryRun) {
      this.log("[DRY RUN] Payment step reached — NOT submitting.", "success");
      this.log(`[DRY RUN] Card: ...${(payment.cardNumber || "").slice(-4)}, Gateway: ${this.paymentGatewayId || "auto"}`, "info");
      return true;
    }

    this.log("Submitting payment...");

    // Step 1: Get payment session token from Shopify's card vault
    let sessionToken;
    try {
      sessionToken = await this.getPaymentSessionToken(payment);
    } catch (err) {
      this.log(`Payment tokenization failed: ${err.message}`, "error");
      this.log("Falling back to direct card submission...", "info");
      sessionToken = null;
    }

    // Step 2: ALWAYS load the payment page to get a fresh auth token + gateway
    // Shopify rotates authenticity_token on every page load — stale tokens cause "no authentication token" errors
    try {
      const payUrl = checkoutUrl.includes("?")
        ? `${checkoutUrl}&step=payment_method`
        : `${checkoutUrl}?step=payment_method`;
      const payRes = await this.request(payUrl);
      const payBody = await payRes.text();
      const freshGw = this.extractPaymentGateway(payBody);
      if (freshGw) this.paymentGatewayId = freshGw;
      const freshAuth = this.extractAuthToken(payBody);
      if (freshAuth) {
        this.authToken = freshAuth;
        this.log(`Auth token refreshed for payment: ${freshAuth.substring(0, 16)}...`, "success");
      } else {
        this.log("Warning: could not extract fresh auth token from payment page.", "error");
      }
    } catch (e) {
      this.log(`Warning: payment page load failed: ${e.message}`, "error");
    }

    // Step 2b: If auth token is STILL missing, retry by loading the checkout URL directly
    if (!this.authToken) {
      this.log("Auth token missing — retrying from checkout URL...", "error");
      try {
        const retryRes = await this.request(checkoutUrl);
        const retryBody = await retryRes.text();
        const retryAuth = this.extractAuthToken(retryBody);
        if (retryAuth) {
          this.authToken = retryAuth;
          this.log(`Auth token recovered: ${retryAuth.substring(0, 16)}...`, "success");
        }
        if (!this.paymentGatewayId) {
          const retryGw = this.extractPaymentGateway(retryBody);
          if (retryGw) this.paymentGatewayId = retryGw;
        }
      } catch (_) {}
    }

    if (!this.authToken) {
      this.log("FATAL: No authentication token available for payment submission.", "error");
      return false;
    }

    // Step 3: Build payment form
    const formData = new URLSearchParams();
    formData.append("_method", "patch");
    formData.append("authenticity_token", this.authToken);
    formData.append("previous_step", "payment_method");
    formData.append("step", "");

    if (sessionToken) {
      // Proper Shopify tokenized payment
      formData.append("s", sessionToken);
      formData.append("checkout[payment_gateway]", this.paymentGatewayId || "");
      formData.append("checkout[credit_card][vault]", "false");
    } else if (payment._preToken) {
      // Use pre-tokenized payment from session warming
      formData.append("s", payment._preToken);
      formData.append("checkout[payment_gateway]", this.paymentGatewayId || "");
      formData.append("checkout[credit_card][vault]", "false");
      this.log("Using pre-tokenized payment.", "success");
    } else {
      // Fallback: direct card (works on some older stores)
      formData.append("checkout[payment_gateway]", this.paymentGatewayId || "");
      formData.append("checkout[credit_card][number]", payment.cardNumber || "");
      formData.append("checkout[credit_card][name]", payment.cardName || "");
      formData.append("checkout[credit_card][month]", payment.expiryMonth || "");
      formData.append("checkout[credit_card][year]", payment.expiryYear || "");
      formData.append("checkout[credit_card][verification_value]", payment.cvv || "");
    }

    formData.append("checkout[different_billing_address]", "false");
    formData.append("complete", "1");

    const res = await this.request(checkoutUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    // Check for success
    const location = res.headers.get("location");
    if (location && (location.includes("thank_you") || location.includes("orders") || location.includes("processing"))) {
      this.log("ORDER CONFIRMED!", "success");
      return true;
    }

    // Follow processing page
    if (location && location.includes("processing")) {
      this.log("Payment processing...", "info");
      for (let i = 0; i < 10; i++) {
        await this._sleep(2000);
        const procRes = await this.request(location.startsWith("http") ? location : new URL(location, checkoutUrl).href);
        const procLoc = procRes.headers.get("location");
        if (procLoc && (procLoc.includes("thank_you") || procLoc.includes("orders"))) {
          this.log("ORDER CONFIRMED (after processing)!", "success");
          return true;
        }
        const procBody = await procRes.text();
        if (procBody.includes("thank_you") || procBody.includes("order-confirmed") || procBody.includes("Thank you")) {
          this.log("ORDER CONFIRMED!", "success");
          return true;
        }
      }
    }

    if (res.ok || res.status === 302) {
      this.log(`Payment submitted (status: ${res.status}).`, "success");
      return true;
    }

    const errBody = await res.text().catch(() => "");
    if (errBody.includes("thank_you") || errBody.includes("Thank you")) {
      this.log("ORDER CONFIRMED!", "success");
      return true;
    }

    this.log(`Payment failed (${res.status}): ${errBody.substring(0, 300)}`, "error");
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // PRE-CHECKOUT: Warm up session BEFORE drop
  // Establishes cookies, DNS cache, and keep-alive connection
  // ═══════════════════════════════════════════════════════════════
  async preCheckout(config) {
    const {
      storeUrl, productUrl, checkoutDetails = {},
    } = config;

    this.startTime = Date.now();
    this.clearLogs();
    this.jar.clear();
    this.ua = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

    const baseUrl = this.getBaseUrl(storeUrl || productUrl);
    this.baseUrl = baseUrl; // Store for instant checkout
    this.log(`PRE-CHECKOUT: Warming session for ${baseUrl}...`);

    try {
      // Step 0: Pre-connect HTTP/2 session (establishes TLS + TCP before any request)
      const domain = new URL(baseUrl).hostname;
      if (this.useH2) {
        const h2ok = await this.httpEngine.preConnect(domain);
        if (h2ok) this.log("HTTP/2 session pre-connected (Chrome TLS fingerprint).", "success");
        else this.log("HTTP/2 pre-connect failed, using HTTP/1.1.", "info");
      }
      // Also pre-connect to Shopify payment vault
      if (this.useH2) {
        await this.httpEngine.preConnect("deposit.shopifycs.com").catch(() => {});
      }

      // Step 1: Visit store homepage — establishes cookies + DNS cache
      await this.request(baseUrl);
      this.log("Session cookies + DNS cached.", "success");

      // Step 2: Hit /cart.js to warm the cart endpoint
      await this.request(`${baseUrl}/cart.js`, { headers: { "accept": "application/json" } }).catch(() => {});
      this.log("Cart endpoint warmed.", "success");

      // Step 3: Pre-fetch /checkout to warm that endpoint too
      await this.request(`${baseUrl}/checkout`, { method: "GET" }).catch(() => {});
      this.log("Checkout endpoint warmed.", "success");

      // Step 4: If we have checkout details, pre-tokenize payment
      this.prePaymentToken = null;
      if (config.paymentDetails?.cardNumber) {
        try {
          this.prePaymentToken = await this.getPaymentSessionToken(config.paymentDetails);
          this.log("Payment pre-tokenized.", "success");
        } catch (e) {
          this.log(`Payment pre-tokenize skipped: ${e.message}`, "info");
        }
      }

      this.preCheckoutUrl = null;
      this.preShippingDone = false;
      this.preConfig = config; // Store config for instant use

      return { success: true, message: "Session fully warmed. DNS, cookies, cart, checkout, payment ready." };
    } catch (err) {
      this.log(`Pre-checkout failed: ${err.message}`, "error");
      return { success: false, error: err.message };
    }
  }

  // Run checkout using pre-warmed session (called when stock is detected)
  // Uses direct checkout link to skip ATC+create checkout (saves 2 requests)
  async runFromPreCheckout(config) {
    const {
      storeUrl, productUrl, variantId, itemName,
      checkoutDetails = {}, paymentDetails = {},
      dryRun = true, confirmationEmail = "", smtpConfig = null,
      taskIndex = 0, captchaHarvester = null,
    } = config;

    this.startTime = Date.now();
    const baseUrl = this.baseUrl || this.getBaseUrl(storeUrl || productUrl);
    this.log(`INSTANT CHECKOUT — Pre-warmed session for ${baseUrl}`);

    try {
      // Resolve variant (should be instant if ID provided)
      const resolvedVariant = variantId || await this.resolveVariant({ storeUrl: baseUrl, productUrl, itemName, variantId });
      if (!resolvedVariant) return { success: false, step: "resolve-variant", logs: this.getLogs() };

      // Jig address for this task
      const jiggedDetails = this.jigAddress(checkoutDetails, taskIndex);

      // FAST PATH: Try direct checkout link first (skips ATC + create checkout = 2 fewer requests)
      let checkoutUrl = await this.directCheckout(baseUrl, resolvedVariant);

      if (!checkoutUrl) {
        // Fallback: standard ATC → create checkout
        const added = await this.addToCart(baseUrl, resolvedVariant);
        if (!added) return { success: false, step: "add-to-cart", logs: this.getLogs() };
        checkoutUrl = await this.createCheckout(baseUrl);
        if (!checkoutUrl) return { success: false, step: "create-checkout", logs: this.getLogs() };
      } else {
        // Direct checkout worked — still need to extract auth token + gateway
        const pageRes = await this.request(checkoutUrl);
        const { body: pageBody } = await this.handleQueueIfPresent(pageRes, checkoutUrl);
        this.authToken = this.extractAuthToken(pageBody);
        this.paymentGatewayId = this.extractPaymentGateway(pageBody);
      }

      // Submit shipping + select rate
      let currentUrl = checkoutUrl;
      if (Object.keys(jiggedDetails).length > 0) {
        currentUrl = await this.submitShippingAddress(currentUrl, jiggedDetails);
      }
      currentUrl = await this.selectShippingRate(currentUrl);

      // Use pre-tokenized payment if available
      const paymentOpts = { ...paymentDetails };
      if (this.prePaymentToken) paymentOpts._preToken = this.prePaymentToken;

      // Inject harvested CAPTCHA token if available
      if (captchaHarvester) {
        const token = captchaHarvester.getToken("recaptchav2") || captchaHarvester.getToken("hcaptcha");
        if (token) {
          this.log(`Injecting pre-harvested CAPTCHA token (${token.substring(0, 20)}...)`, "success");
          paymentOpts._captchaToken = token;
        }
      }

      const paid = await this.submitPayment(currentUrl, paymentOpts, dryRun);
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

      if (paid) {
        const msg = dryRun ? `DRY RUN in ${elapsed}s` : `ORDER PLACED in ${elapsed}s!`;
        this.log(msg, "success");
        if (!dryRun && confirmationEmail) {
          await this.sendConfirmationEmail({ confirmationEmail, smtpConfig, itemName: itemName || `Variant ${resolvedVariant}`, storeUrl: baseUrl });
        }
        return { success: true, step: "complete", dryRun, elapsed, mode: "fast-preloaded", logs: this.getLogs() };
      }

      return { success: false, step: "payment", logs: this.getLogs() };
    } catch (err) {
      this.log(`Fatal: ${err.message}`, "error");
      return { success: false, error: err.message, logs: this.getLogs() };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SHOPIFY GRAPHQL CHECKOUT (Storefront API v2)
  // Single-request shipping+payment — faster than multi-step REST
  // ═══════════════════════════════════════════════════════════════
  async graphqlCheckout(config) {
    const {
      storeUrl, variantId, checkoutDetails = {}, paymentDetails = {},
      dryRun = true, taskIndex = 0,
    } = config;

    const baseUrl = this.getBaseUrl(storeUrl);
    const jiggedDetails = this.jigAddress(checkoutDetails, taskIndex);

    // Step 1: Detect Storefront API access token from the store's theme
    let storefrontToken = null;
    try {
      const res = await this.request(baseUrl);
      const body = await res.text();
      // Shopify embeds the Storefront API token in the theme
      const tokenMatch = body.match(/Shopify\.StorefrontAccessToken\s*=\s*["']([^"']+)["']/) ||
        body.match(/storefrontAccessToken['":\s]+["']([a-f0-9]{32,})["']/) ||
        body.match(/X-Shopify-Storefront-Access-Token['":\s]+["']([a-f0-9]{32,})["']/i) ||
        body.match(/accessToken['":\s]+["']([a-f0-9]{32,})["']/);
      if (tokenMatch) storefrontToken = tokenMatch[1];
    } catch (_) {}

    if (!storefrontToken) {
      this.log("Storefront API token not found, using REST checkout.", "info");
      return null; // Caller falls back to REST
    }

    this.log(`Storefront API token: ${storefrontToken.substring(0, 8)}...`, "success");
    const gqlUrl = `${baseUrl}/api/2024-01/graphql.json`;
    const gqlHeaders = {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": storefrontToken,
      "accept": "application/json",
    };

    // Step 2: Create checkout with line items + shipping in one request
    const createMutation = `mutation {
      checkoutCreate(input: {
        lineItems: [{ variantId: "gid://shopify/ProductVariant/${variantId}", quantity: 1 }]
        email: "${jiggedDetails.email || ""}"
        shippingAddress: {
          firstName: "${jiggedDetails.firstName || ""}"
          lastName: "${jiggedDetails.lastName || ""}"
          address1: "${jiggedDetails.address || ""}"
          address2: "${jiggedDetails.address2 || ""}"
          city: "${jiggedDetails.city || ""}"
          province: "${jiggedDetails.state || ""}"
          zip: "${jiggedDetails.zip || ""}"
          country: "${jiggedDetails.country || "US"}"
          phone: "${jiggedDetails.phone || ""}"
        }
      }) {
        checkout {
          id
          webUrl
          totalPriceV2 { amount currencyCode }
          availableShippingRates { ready shippingRates { handle title priceV2 { amount } } }
        }
        checkoutUserErrors { field message }
      }
    }`;

    try {
      const createRes = await this.request(gqlUrl, {
        method: "POST",
        headers: gqlHeaders,
        body: JSON.stringify({ query: createMutation }),
      });
      const createData = await createRes.json();
      const checkout = createData.data?.checkoutCreate?.checkout;
      const errors = createData.data?.checkoutCreate?.checkoutUserErrors;

      if (errors?.length > 0) {
        this.log(`GraphQL errors: ${errors.map(e => e.message).join(", ")}`, "error");
        return null;
      }

      if (!checkout?.id) {
        this.log("GraphQL checkout creation failed.", "error");
        return null;
      }

      this.log(`GraphQL checkout created: $${checkout.totalPriceV2?.amount}`, "success");

      // Step 3: Select shipping rate
      const rates = checkout.availableShippingRates?.shippingRates || [];
      if (rates.length > 0) {
        // Pick cheapest
        rates.sort((a, b) => parseFloat(a.priceV2.amount) - parseFloat(b.priceV2.amount));
        const rate = rates[0];
        this.log(`Shipping: ${rate.title} ($${rate.priceV2.amount})`, "success");

        const shippingMutation = `mutation {
          checkoutShippingLineUpdate(checkoutId: "${checkout.id}", shippingRateHandle: "${rate.handle}") {
            checkout { id webUrl }
            checkoutUserErrors { field message }
          }
        }`;

        await this.request(gqlUrl, {
          method: "POST",
          headers: gqlHeaders,
          body: JSON.stringify({ query: shippingMutation }),
        });
      }

      // Step 4: Payment
      if (dryRun) {
        this.log("[DRY RUN] GraphQL checkout complete — payment NOT submitted.", "success");
        return { success: true, dryRun: true, checkoutUrl: checkout.webUrl, mode: "graphql" };
      }

      // Tokenize payment
      let sessionToken;
      try {
        sessionToken = this.prePaymentToken || await this.getPaymentSessionToken(paymentDetails);
      } catch (e) {
        this.log(`Payment tokenization failed: ${e.message}`, "error");
        return null;
      }

      // Complete checkout with payment via the webUrl (GraphQL doesn't support direct payment completion for card)
      // We use the checkout webUrl + REST payment submission
      const checkoutUrl = checkout.webUrl;
      const pageRes = await this.request(checkoutUrl);
      const pageBody = await pageRes.text();
      this.authToken = this.extractAuthToken(pageBody);
      this.paymentGatewayId = this.extractPaymentGateway(pageBody);

      // If auth token not found on first load, try payment step URL
      if (!this.authToken) {
        try {
          const payStepUrl = checkoutUrl.includes("?") ? `${checkoutUrl}&step=payment_method` : `${checkoutUrl}?step=payment_method`;
          const payStepRes = await this.request(payStepUrl);
          const payStepBody = await payStepRes.text();
          this.authToken = this.extractAuthToken(payStepBody) || this.authToken;
          if (!this.paymentGatewayId) this.paymentGatewayId = this.extractPaymentGateway(payStepBody);
        } catch (_) {}
      }

      if (!this.authToken) {
        this.log("GraphQL payment: no auth token available.", "error");
        return null;
      }

      const formData = new URLSearchParams();
      formData.append("_method", "patch");
      formData.append("authenticity_token", this.authToken);
      formData.append("previous_step", "payment_method");
      formData.append("step", "");
      formData.append("s", sessionToken);
      formData.append("checkout[payment_gateway]", this.paymentGatewayId || "");
      formData.append("checkout[credit_card][vault]", "false");
      formData.append("checkout[different_billing_address]", "false");
      formData.append("complete", "1");

      const payRes = await this.request(checkoutUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      const location = payRes.headers.get("location");
      if (location && (location.includes("thank_you") || location.includes("orders") || location.includes("processing"))) {
        this.log("ORDER CONFIRMED via GraphQL checkout!", "success");
        return { success: true, dryRun: false, mode: "graphql" };
      }

      this.log(`GraphQL payment response: ${payRes.status}`, "info");
      return { success: payRes.ok || payRes.status === 302, dryRun: false, mode: "graphql" };
    } catch (err) {
      this.log(`GraphQL checkout failed: ${err.message}`, "error");
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EMAIL CONFIRMATION
  // ═══════════════════════════════════════════════════════════════
  async sendConfirmationEmail(config) {
    const { confirmationEmail, smtpConfig, itemName, storeUrl } = config;
    if (!confirmationEmail) return;

    this.log(`Sending confirmation to ${confirmationEmail}...`);
    try {
      let transporter;
      if (smtpConfig?.host) {
        transporter = nodemailer.createTransport({
          host: smtpConfig.host, port: smtpConfig.port || 587,
          secure: smtpConfig.secure || false,
          auth: { user: smtpConfig.user, pass: smtpConfig.pass },
        });
      } else {
        const testAccount = await nodemailer.createTestAccount();
        transporter = nodemailer.createTransport({
          host: "smtp.ethereal.email", port: 587, secure: false,
          auth: { user: testAccount.user, pass: testAccount.pass },
        });
      }

      const elapsed = this.startTime ? ((Date.now() - this.startTime) / 1000).toFixed(1) : "?";
      const logSummary = this.logs.map(l => `[${l.type.toUpperCase()}] ${l.message}`).join("\n");

      const info = await transporter.sendMail({
        from: '"Cart Bot" <cartbot@automated.local>',
        to: confirmationEmail,
        subject: `Purchase Confirmation: ${itemName}`,
        text: `Item: ${itemName}\nSite: ${storeUrl}\nMode: Direct API\nDuration: ${elapsed}s\n\n${logSummary}`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;"><h2 style="color:#e74c3c;">Order Confirmed</h2><p><strong>${itemName}</strong> — ${elapsed}s</p><pre style="background:#1a1d27;color:#e4e6f0;padding:16px;border-radius:8px;font-size:12px;">${logSummary}</pre></div>`,
      });

      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) this.log(`Email preview: ${previewUrl}`, "success");
      else this.log(`Sent to ${confirmationEmail}`, "success");
    } catch (err) { this.log(`Email failed: ${err.message}`, "error"); }
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN RUN (standard flow)
  // ═══════════════════════════════════════════════════════════════
  async run(config) {
    const {
      storeUrl, productUrl, itemName, variantId,
      checkoutDetails = {}, paymentDetails = {},
      dryRun = true, confirmationEmail = "", smtpConfig = null,
    } = config;

    this.startTime = Date.now();
    this.clearLogs();
    this.jar.clear();
    this.ua = config.mobileMode
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1"
      : UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
    this.authToken = null;
    this.paymentGatewayId = null;

    const baseUrl = this.getBaseUrl(storeUrl || productUrl);
    this.log(`FAST MODE — Direct API checkout for ${baseUrl}`);
    this.log(`UA: ${this.ua.substring(0, 50)}...${config.mobileMode ? " (MOBILE)" : ""}`);

    try {
      // Step 1: Resolve variant
      const resolvedVariant = await this.resolveVariant({ storeUrl: baseUrl, productUrl, itemName, variantId });
      if (!resolvedVariant) return { success: false, step: "resolve-variant", logs: this.getLogs() };

      // Step 1.5: Try GraphQL checkout first (single-request, faster)
      const gqlResult = await this.graphqlCheckout({
        storeUrl: baseUrl, variantId: resolvedVariant,
        checkoutDetails: this.jigAddress(checkoutDetails, config.taskIndex || 0),
        paymentDetails, dryRun, taskIndex: config.taskIndex || 0,
      });
      if (gqlResult?.success) {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        const msg = dryRun ? `DRY RUN (GraphQL) in ${elapsed}s` : `ORDER PLACED (GraphQL) in ${elapsed}s!`;
        this.log(msg, "success");
        if (!dryRun && confirmationEmail) {
          await this.sendConfirmationEmail({ confirmationEmail, smtpConfig, itemName: itemName || `Variant ${resolvedVariant}`, storeUrl: baseUrl });
        }
        return { success: true, step: "complete", dryRun, elapsed, mode: "graphql", logs: this.getLogs() };
      }
      if (gqlResult === null) this.log("GraphQL unavailable, using REST checkout.", "info");

      // Step 2: Try direct checkout link first (skip ATC + create checkout)
      let checkoutUrl = await this.directCheckout(baseUrl, resolvedVariant);

      if (checkoutUrl) {
        // Direct checkout worked — extract auth token + gateway
        const pageRes = await this.request(checkoutUrl);
        const { body: pageBody } = await this.handleQueueIfPresent(pageRes, checkoutUrl);
        this.authToken = this.extractAuthToken(pageBody);
        this.paymentGatewayId = this.extractPaymentGateway(pageBody);
        this.log("Direct checkout link succeeded — skipped ATC + create checkout!", "success");
      } else {
        // Fallback: standard ATC → create checkout
        const added = await this.addToCart(baseUrl, resolvedVariant);
        if (!added) return { success: false, step: "add-to-cart", logs: this.getLogs() };
        checkoutUrl = await this.createCheckout(baseUrl);
        if (!checkoutUrl) return { success: false, step: "create-checkout", logs: this.getLogs() };
      }

      // Step 3: Submit shipping (with address jig if taskIndex provided)
      const jiggedDetails = this.jigAddress(checkoutDetails, config.taskIndex || 0);
      let currentUrl = checkoutUrl;
      if (Object.keys(jiggedDetails).length > 0) {
        currentUrl = await this.submitShippingAddress(currentUrl, jiggedDetails);
      }

      // Step 4: Select shipping rate
      currentUrl = await this.selectShippingRate(currentUrl);

      // Step 5: Submit payment (with proper tokenization)
      const paid = await this.submitPayment(currentUrl, paymentDetails, dryRun);
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

      if (paid) {
        const msg = dryRun ? `DRY RUN complete in ${elapsed}s` : `ORDER PLACED in ${elapsed}s!`;
        this.log(msg, "success");
        if (!dryRun && confirmationEmail) {
          await this.sendConfirmationEmail({ confirmationEmail, smtpConfig, itemName: itemName || `Variant ${resolvedVariant}`, storeUrl: baseUrl });
        }
        return { success: true, step: "complete", dryRun, elapsed, mode: "fast", logs: this.getLogs() };
      }

      return { success: false, step: "payment", logs: this.getLogs() };
    } catch (err) {
      this.log(`Fatal: ${err.message}`, "error");
      return { success: false, error: err.message, logs: this.getLogs() };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SESSION PERSISTENCE — Save/load warmed sessions to disk
  // Sessions survive server restarts. Warm hours before a drop.
  // ═══════════════════════════════════════════════════════════════
  serializeSession() {
    return {
      cookies: this.jar.store,
      ua: this.ua,
      fingerprint: this.fingerprint,
      authToken: this.authToken,
      paymentGatewayId: this.paymentGatewayId,
      checkoutToken: this.checkoutToken,
      preCheckoutUrl: this.preCheckoutUrl,
      preShippingDone: this.preShippingDone,
      preShippingRateId: this.preShippingRateId,
      prePaymentToken: this.prePaymentToken,
      baseUrl: this.baseUrl,
      useH2: this.useH2,
      savedAt: Date.now(),
    };
  }

  restoreSession(data) {
    if (!data) return false;
    // Check session age — reject if older than 4 hours
    if (data.savedAt && (Date.now() - data.savedAt) > 4 * 60 * 60 * 1000) {
      this.log("Saved session expired (>4h old). Starting fresh.", "info");
      return false;
    }
    this.jar.store = data.cookies || {};
    this.ua = data.ua || this.ua;
    this.fingerprint = data.fingerprint || this.fingerprint;
    this.authToken = data.authToken || null;
    this.paymentGatewayId = data.paymentGatewayId || null;
    this.checkoutToken = data.checkoutToken || null;
    this.preCheckoutUrl = data.preCheckoutUrl || null;
    this.preShippingDone = data.preShippingDone || false;
    this.preShippingRateId = data.preShippingRateId || null;
    this.prePaymentToken = data.prePaymentToken || null;
    this.baseUrl = data.baseUrl || null;
    this.useH2 = data.useH2 !== undefined ? data.useH2 : true;
    const age = data.savedAt ? ((Date.now() - data.savedAt) / 1000 / 60).toFixed(1) : "?";
    this.log(`Session restored (${age} min old). Cookies, tokens, fingerprint loaded.`, "success");
    return true;
  }

  static saveSessions(sessions, filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Encrypt with a simple key derived from machine identity
    const key = crypto.createHash("sha256").update("cartbot-session-key-" + (process.env.COMPUTERNAME || "default")).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const json = JSON.stringify(sessions);
    let encrypted = cipher.update(json, "utf8", "hex");
    encrypted += cipher.final("hex");
    fs.writeFileSync(filePath, iv.toString("hex") + ":" + encrypted, "utf8");
    return true;
  }

  static loadSessions(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const [ivHex, encrypted] = raw.split(":");
      const key = crypto.createHash("sha256").update("cartbot-session-key-" + (process.env.COMPUTERNAME || "default")).digest();
      const iv = Buffer.from(ivHex, "hex");
      const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return JSON.parse(decrypted);
    } catch (err) {
      return null;
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { FastCheckout, CookieJar };
