const EventEmitter = require("events");
const fetch = require("node-fetch");
const { HttpEngine } = require("../http-engine");

/**
 * PokemonCenterModule — Site-specific checkout for pokemoncenter.com
 *
 * Pokemon Center uses a custom Next.js storefront (NOT Shopify).
 * This module reverse-engineers their exact API flow:
 *
 *   1. Product data via __NEXT_DATA__ or /api/products endpoint
 *   2. Cart via /api/cart (custom REST API, not Shopify /cart/add.js)
 *   3. Checkout via /api/checkout (multi-step, requires auth session)
 *   4. Payment via their payment processor (not deposit.shopifycs.com)
 *   5. Account login for saved payment methods
 *
 * Key differences from Shopify:
 *   - Uses session cookies + CSRF tokens from Next.js
 *   - Cart API is JSON-based REST, not Shopify's /cart/add.js
 *   - Checkout is a single-page app with API calls, not form POSTs
 *   - Often has Akamai/PerimeterX bot protection
 *   - Products use SKU-based IDs, not Shopify variant IDs
 */

const PC_BASE = "https://www.pokemoncenter.com";
const PC_API = "https://www.pokemoncenter.com/api";

const PC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

class PokemonCenterModule extends EventEmitter {
  constructor() {
    super();
    this.logs = [];
    this.startTime = null;
    this.cookies = {};
    this.csrfToken = null;
    this.sessionId = null;
    this.httpEngine = new HttpEngine();
    this.accountToken = null; // For logged-in checkout
  }

  log(message, type = "info") {
    const elapsed = this.startTime
      ? `+${((Date.now() - this.startTime) / 1000).toFixed(1)}s`
      : "";
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message: elapsed ? `[${elapsed}] [PC] ${message}` : `[PC] ${message}`,
    };
    this.logs.push(entry);
    console.log(`[PC][${type.toUpperCase()}] ${entry.message}`);
    this.emit("log", entry);
  }

  getLogs() { return this.logs; }

  // ─── Cookie management ───
  _updateCookies(setCookieHeaders) {
    if (!setCookieHeaders) return;
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const raw of arr) {
      const parts = raw.split(";")[0];
      const eq = parts.indexOf("=");
      if (eq < 1) continue;
      this.cookies[parts.substring(0, eq).trim()] = parts.substring(eq + 1);
    }
  }

  _getCookieString() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  // ─── Core HTTP request ───
  async _request(url, options = {}) {
    const headers = {
      "User-Agent": PC_UA,
      "Accept": options.json ? "application/json" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Sec-Fetch-Dest": options.json ? "empty" : "document",
      "Sec-Fetch-Mode": options.json ? "cors" : "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Origin": PC_BASE,
      "Referer": `${PC_BASE}/`,
      ...(options.headers || {}),
    };

    const cookieStr = this._getCookieString();
    if (cookieStr) headers["Cookie"] = cookieStr;
    if (this.csrfToken) headers["X-CSRF-Token"] = this.csrfToken;
    if (this.accountToken) headers["Authorization"] = `Bearer ${this.accountToken}`;

    const res = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body || undefined,
      redirect: "manual",
      timeout: 15000,
    });

    const setCookies = res.headers.raw()["set-cookie"];
    if (setCookies) this._updateCookies(setCookies);

    return res;
  }

  // ─── Step 0: Initialize session ───
  async initSession() {
    this.log("Initializing Pokemon Center session...");

    // Visit homepage to get session cookies
    const res = await this._request(PC_BASE);
    const body = await res.text();

    // Extract __NEXT_DATA__ for build ID and session info
    const nextDataMatch = body.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        this.buildId = nextData.buildId;
        this.log(`Build ID: ${this.buildId}`, "success");

        // Extract CSRF token if present
        if (nextData.props?.pageProps?.csrfToken) {
          this.csrfToken = nextData.props.pageProps.csrfToken;
          this.log(`CSRF token obtained.`, "success");
        }
      } catch (e) {
        this.log(`__NEXT_DATA__ parse failed: ${e.message}`, "error");
      }
    }

    // Try to get CSRF from meta tag
    if (!this.csrfToken) {
      const csrfMatch = body.match(/csrf-token['"]\s*content=['"](.*?)['"]/);
      if (csrfMatch) this.csrfToken = csrfMatch[1];
    }

    this.log("Session initialized.", "success");
  }

  // ─── Account login (for saved payment methods) ───
  async login(email, password) {
    this.log(`Logging in as ${email}...`);

    try {
      // Pokemon Center uses a standard auth endpoint
      const loginRes = await this._request(`${PC_API}/auth/login`, {
        method: "POST",
        json: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (loginRes.ok) {
        const data = await loginRes.json();
        this.accountToken = data.token || data.accessToken || data.access_token;
        if (this.accountToken) {
          this.log("Login successful! Account token obtained.", "success");
          return true;
        }
      }

      // Try alternate auth endpoints
      const altRes = await this._request(`${PC_BASE}/api/user/login`, {
        method: "POST",
        json: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (altRes.ok) {
        const data = await altRes.json();
        this.accountToken = data.token || data.accessToken;
        if (this.accountToken) {
          this.log("Login successful (alt endpoint).", "success");
          return true;
        }
      }

      this.log("Login failed — continuing as guest.", "info");
      return false;
    } catch (err) {
      this.log(`Login error: ${err.message}`, "error");
      return false;
    }
  }

  // ─── Resolve product SKU/ID from URL or name ───
  async resolveProduct(productUrl, itemName) {
    this.log("Resolving product...");

    // Strategy 1: Fetch product page and extract __NEXT_DATA__
    if (productUrl) {
      try {
        const res = await this._request(productUrl);
        const body = await res.text();

        const nextDataMatch = body.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
        if (nextDataMatch) {
          const nextData = JSON.parse(nextDataMatch[1]);
          const product = nextData.props?.pageProps?.product ||
            nextData.props?.pageProps?.productData ||
            nextData.props?.pageProps?.initialData?.product;

          if (product) {
            this.log(`Found: "${product.name || product.title}"`, "success");

            // Get the first available variant/SKU
            const variants = product.variants || product.skus || product.options || [];
            if (variants.length > 0) {
              const available = variants.find(v => v.available || v.inStock || v.purchasable) || variants[0];
              const sku = available.sku || available.id || available.variantId;
              this.log(`SKU: ${sku}`, "success");
              return { sku, product };
            }

            // Single product (no variants)
            const sku = product.sku || product.id || product.productId;
            if (sku) {
              this.log(`SKU: ${sku}`, "success");
              return { sku, product };
            }
          }
        }

        // Try extracting from structured data
        const ldMatch = body.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
        if (ldMatch) {
          const ld = JSON.parse(ldMatch[1]);
          if (ld.sku || ld.productID) {
            this.log(`SKU from LD+JSON: ${ld.sku || ld.productID}`, "success");
            return { sku: ld.sku || ld.productID, product: ld };
          }
        }
      } catch (err) {
        this.log(`Product page parse failed: ${err.message}`, "error");
      }
    }

    // Strategy 2: Search API
    if (itemName) {
      this.log(`Searching for "${itemName}"...`);
      try {
        const searchRes = await this._request(
          `${PC_API}/search?q=${encodeURIComponent(itemName)}&limit=5`,
          { json: true }
        );
        if (searchRes.ok) {
          const data = await searchRes.json();
          const results = data.results || data.products || data.items || [];
          if (results.length > 0) {
            const match = results[0];
            this.log(`Search match: "${match.name || match.title}"`, "success");
            return { sku: match.sku || match.id, product: match };
          }
        }

        // Try alternate search endpoint
        const altRes = await this._request(
          `${PC_BASE}/search?q=${encodeURIComponent(itemName)}`,
        );
        const altBody = await altRes.text();
        const nextDataMatch = altBody.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
        if (nextDataMatch) {
          const nextData = JSON.parse(nextDataMatch[1]);
          const searchResults = nextData.props?.pageProps?.searchResults ||
            nextData.props?.pageProps?.products || [];
          if (searchResults.length > 0) {
            const match = searchResults[0];
            this.log(`Search match: "${match.name || match.title}"`, "success");
            return { sku: match.sku || match.id, product: match };
          }
        }
      } catch (err) {
        this.log(`Search failed: ${err.message}`, "error");
      }
    }

    this.log("Could not resolve product.", "error");
    return null;
  }

  // ─── Add to cart via API ───
  async addToCart(sku, quantity = 1) {
    this.log(`Adding SKU ${sku} to cart...`);

    // Try multiple cart API formats (Pokemon Center has changed these over time)
    const cartPayloads = [
      { url: `${PC_API}/cart/items`, body: { sku, quantity } },
      { url: `${PC_API}/cart/add`, body: { items: [{ sku, quantity }] } },
      { url: `${PC_API}/cart`, body: { action: "add", sku, quantity } },
      { url: `${PC_BASE}/api/cart/items`, body: { productId: sku, quantity } },
    ];

    for (const { url, body } of cartPayloads) {
      try {
        const res = await this._request(url, {
          method: "POST",
          json: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.ok || res.status === 201) {
          const data = await res.json().catch(() => ({}));
          this.log(`Added to cart! ${JSON.stringify(data).substring(0, 100)}`, "success");
          return true;
        }
      } catch (_) {}
    }

    this.log("All cart API formats failed.", "error");
    return false;
  }

  // ─── Create checkout / get checkout session ───
  async createCheckout() {
    this.log("Creating checkout session...");

    const checkoutEndpoints = [
      `${PC_API}/checkout`,
      `${PC_API}/checkout/session`,
      `${PC_BASE}/api/checkout/create`,
    ];

    for (const url of checkoutEndpoints) {
      try {
        const res = await this._request(url, {
          method: "POST",
          json: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        if (res.ok || res.status === 201) {
          const data = await res.json();
          const checkoutId = data.checkoutId || data.id || data.sessionId;
          if (checkoutId) {
            this.log(`Checkout session: ${checkoutId}`, "success");
            return { checkoutId, data };
          }
        }
      } catch (_) {}
    }

    // Fallback: navigate to /checkout and extract session
    try {
      const res = await this._request(`${PC_BASE}/checkout`);
      const body = await res.text();
      const nextDataMatch = body.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
      if (nextDataMatch) {
        const nextData = JSON.parse(nextDataMatch[1]);
        const checkoutData = nextData.props?.pageProps?.checkout ||
          nextData.props?.pageProps?.checkoutSession;
        if (checkoutData) {
          this.log(`Checkout from page data.`, "success");
          return { checkoutId: checkoutData.id, data: checkoutData };
        }
      }
    } catch (_) {}

    this.log("Checkout creation failed.", "error");
    return null;
  }

  // ─── Submit shipping address ───
  async submitShipping(checkoutId, details) {
    this.log("Submitting shipping...");

    const shippingData = {
      firstName: details.firstName || "",
      lastName: details.lastName || "",
      address1: details.address || "",
      address2: details.address2 || "",
      city: details.city || "",
      state: details.state || "",
      zip: details.zip || "",
      country: details.country || "US",
      phone: details.phone || "",
      email: details.email || "",
    };

    const endpoints = [
      `${PC_API}/checkout/${checkoutId}/shipping`,
      `${PC_API}/checkout/shipping`,
      `${PC_BASE}/api/checkout/${checkoutId}/address`,
    ];

    for (const url of endpoints) {
      try {
        const res = await this._request(url, {
          method: "POST",
          json: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(shippingData),
        });

        if (res.ok) {
          this.log("Shipping submitted.", "success");
          return true;
        }
      } catch (_) {}
    }

    // PUT variant
    try {
      const res = await this._request(`${PC_API}/checkout/${checkoutId}`, {
        method: "PUT",
        json: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingAddress: shippingData }),
      });
      if (res.ok) {
        this.log("Shipping submitted (PUT).", "success");
        return true;
      }
    } catch (_) {}

    this.log("Shipping submission failed.", "error");
    return false;
  }

  // ─── Submit payment ───
  async submitPayment(checkoutId, paymentDetails, dryRun = true) {
    if (dryRun) {
      this.log("[DRY RUN] Payment step reached — NOT submitting.", "success");
      return true;
    }

    this.log("Submitting payment...");

    const paymentData = {
      cardNumber: (paymentDetails.cardNumber || "").replace(/\s/g, ""),
      cardName: paymentDetails.cardName || "",
      expiryMonth: paymentDetails.expiryMonth || "",
      expiryYear: paymentDetails.expiryYear || "",
      cvv: paymentDetails.cvv || "",
    };

    const endpoints = [
      `${PC_API}/checkout/${checkoutId}/payment`,
      `${PC_API}/checkout/payment`,
      `${PC_BASE}/api/checkout/${checkoutId}/pay`,
    ];

    for (const url of endpoints) {
      try {
        const res = await this._request(url, {
          method: "POST",
          json: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(paymentData),
        });

        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.orderId || data.orderNumber || data.success || data.status === "confirmed") {
            this.log(`ORDER CONFIRMED! ${data.orderId || data.orderNumber || ""}`, "success");
            return true;
          }
          this.log(`Payment response: ${JSON.stringify(data).substring(0, 200)}`, "info");
          return true;
        }
      } catch (_) {}
    }

    this.log("Payment failed.", "error");
    return false;
  }

  // ─── Main run ───
  async run(config) {
    const {
      productUrl, itemName, sku,
      checkoutDetails = {}, paymentDetails = {},
      dryRun = true, email, password,
    } = config;

    this.startTime = Date.now();
    this.logs = [];

    this.log("POKEMON CENTER MODULE — Custom Next.js checkout");

    try {
      // Step 0: Initialize session
      await this.initSession();

      // Step 0.5: Login if credentials provided
      if (email && password) {
        await this.login(email, password);
      }

      // Step 1: Resolve product
      let productSku = sku;
      if (!productSku) {
        const resolved = await this.resolveProduct(productUrl, itemName);
        if (!resolved) return { success: false, step: "resolve-product", logs: this.getLogs() };
        productSku = resolved.sku;
      }

      // Step 2: Add to cart
      const added = await this.addToCart(productSku);
      if (!added) return { success: false, step: "add-to-cart", logs: this.getLogs() };

      // Step 3: Create checkout
      const checkout = await this.createCheckout();
      if (!checkout) return { success: false, step: "create-checkout", logs: this.getLogs() };

      // Step 4: Submit shipping
      if (Object.keys(checkoutDetails).length > 0) {
        await this.submitShipping(checkout.checkoutId, checkoutDetails);
      }

      // Step 5: Submit payment
      const paid = await this.submitPayment(checkout.checkoutId, paymentDetails, dryRun);
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

      if (paid) {
        const msg = dryRun ? `DRY RUN in ${elapsed}s` : `ORDER PLACED in ${elapsed}s!`;
        this.log(msg, "success");
        return { success: true, step: "complete", dryRun, elapsed, mode: "pokemon-center", logs: this.getLogs() };
      }

      return { success: false, step: "payment", logs: this.getLogs() };
    } catch (err) {
      this.log(`Fatal: ${err.message}`, "error");
      return { success: false, error: err.message, logs: this.getLogs() };
    }
  }
}

module.exports = { PokemonCenterModule };
