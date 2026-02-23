const { HttpEngine } = require("./http-engine");
const { FastCheckout } = require("./fast-checkout");
const fetch = require("node-fetch");

/**
 * SelfTest — Built-in diagnostic suite that verifies every subsystem works.
 * Run before a drop to catch config errors, broken connections, or missing deps.
 */
class SelfTest {
  constructor() {
    this.results = [];
    this.startTime = null;
  }

  _add(name, status, detail, ms) {
    this.results.push({ name, status, detail, ms: ms || 0 });
  }

  async runAll(config = {}) {
    this.results = [];
    this.startTime = Date.now();
    const { storeUrl, proxyList, paymentDetails } = config;

    await this.testHttpEngine();
    await this.testCookieJar();
    await this.testTlsFingerprint();
    if (storeUrl) await this.testStoreReachability(storeUrl);
    if (storeUrl) await this.testH2Connection(storeUrl);
    if (storeUrl) await this.testDirectCheckoutLink(storeUrl);
    if (storeUrl) await this.testCartApi(storeUrl);
    if (paymentDetails?.cardNumber) await this.testPaymentTokenization(paymentDetails);
    if (proxyList?.length) await this.testProxies(proxyList);
    await this.testDependencies();

    const passed = this.results.filter(r => r.status === "pass").length;
    const failed = this.results.filter(r => r.status === "fail").length;
    const warned = this.results.filter(r => r.status === "warn").length;
    const totalMs = Date.now() - this.startTime;

    return {
      passed, failed, warned,
      total: this.results.length,
      totalMs,
      results: this.results,
      allPassed: failed === 0,
    };
  }

  // ─── Test 1: HttpEngine creates and works ───
  async testHttpEngine() {
    const t = Date.now();
    try {
      const engine = new HttpEngine();
      if (!engine) throw new Error("HttpEngine constructor returned null");
      this._add("HTTP Engine", "pass", "HttpEngine initialized successfully", Date.now() - t);
      await engine.destroy();
    } catch (err) {
      this._add("HTTP Engine", "fail", `HttpEngine failed: ${err.message}`, Date.now() - t);
    }
  }

  // ─── Test 2: CookieJar works correctly ───
  async testCookieJar() {
    const t = Date.now();
    try {
      const fc = new FastCheckout();
      fc.jar.update("https://example.com/page", ["session=abc123; Path=/", "cart=xyz; Path=/"]);
      const cookies = fc.jar.get("https://example.com/other");
      if (!cookies.includes("session=abc123")) throw new Error("Cookie not stored");
      if (!cookies.includes("cart=xyz")) throw new Error("Second cookie not stored");
      fc.jar.clear();
      const after = fc.jar.get("https://example.com/other");
      if (after !== "") throw new Error("Clear did not work");
      this._add("Cookie Jar", "pass", "Domain-scoped cookies work correctly", Date.now() - t);
    } catch (err) {
      this._add("Cookie Jar", "fail", err.message, Date.now() - t);
    }
  }

  // ─── Test 3: TLS fingerprint matches Chrome ───
  async testTlsFingerprint() {
    const t = Date.now();
    try {
      const { CHROME_CIPHERS } = require("./http-engine");
      if (!CHROME_CIPHERS) throw new Error("CHROME_CIPHERS not exported");
      if (!CHROME_CIPHERS.includes("TLS_AES_128_GCM_SHA256")) throw new Error("Missing TLS 1.3 cipher");
      if (!CHROME_CIPHERS.includes("ECDHE-ECDSA-AES128-GCM-SHA256")) throw new Error("Missing ECDHE cipher");
      const cipherCount = CHROME_CIPHERS.split(":").length;
      if (cipherCount < 10) throw new Error(`Only ${cipherCount} ciphers, need 10+`);
      this._add("TLS Fingerprint", "pass", `${cipherCount} Chrome cipher suites configured`, Date.now() - t);
    } catch (err) {
      this._add("TLS Fingerprint", "fail", err.message, Date.now() - t);
    }
  }

  // ─── Test 4: Store is reachable ───
  async testStoreReachability(storeUrl) {
    const t = Date.now();
    try {
      const base = new URL(storeUrl).origin;
      const res = await fetch(base, { timeout: 10000, redirect: "follow" });
      if (res.ok || res.status === 301 || res.status === 302) {
        this._add("Store Reachable", "pass", `${base} responded ${res.status} in ${Date.now() - t}ms`, Date.now() - t);
      } else {
        this._add("Store Reachable", "warn", `${base} returned ${res.status}`, Date.now() - t);
      }
    } catch (err) {
      this._add("Store Reachable", "fail", `Cannot reach store: ${err.message}`, Date.now() - t);
    }
  }

  // ─── Test 5: HTTP/2 connection to store ───
  async testH2Connection(storeUrl) {
    const t = Date.now();
    try {
      const engine = new HttpEngine();
      const domain = new URL(storeUrl).hostname;
      const ok = await engine.preConnect(domain);
      if (ok) {
        this._add("HTTP/2 Connection", "pass", `H2 session to ${domain} established in ${Date.now() - t}ms`, Date.now() - t);
      } else {
        this._add("HTTP/2 Connection", "warn", `H2 not supported by ${domain}, will use HTTP/1.1`, Date.now() - t);
      }
      await engine.destroy();
    } catch (err) {
      this._add("HTTP/2 Connection", "warn", `H2 failed: ${err.message} (will use HTTP/1.1)`, Date.now() - t);
    }
  }

  // ─── Test 6: Direct checkout link format ───
  async testDirectCheckoutLink(storeUrl) {
    const t = Date.now();
    try {
      const base = new URL(storeUrl).origin;
      // Test with a dummy variant ID — we just check if the endpoint exists
      const res = await fetch(`${base}/cart/1:1`, { redirect: "manual", timeout: 8000 });
      const loc = res.headers.get("location") || "";
      if (loc.includes("checkout") || res.status === 302) {
        this._add("Direct Checkout Link", "pass", `Store supports /cart/VARIANT:QTY redirect`, Date.now() - t);
      } else if (res.status === 404 || res.status === 422) {
        this._add("Direct Checkout Link", "warn", `Store may not support direct links (${res.status}). ATC fallback will be used.`, Date.now() - t);
      } else {
        this._add("Direct Checkout Link", "warn", `Got ${res.status}, direct links may not work`, Date.now() - t);
      }
    } catch (err) {
      this._add("Direct Checkout Link", "warn", `Could not test: ${err.message}`, Date.now() - t);
    }
  }

  // ─── Test 7: Cart API works ───
  async testCartApi(storeUrl) {
    const t = Date.now();
    try {
      const base = new URL(storeUrl).origin;
      const res = await fetch(`${base}/cart.js`, { timeout: 8000, headers: { "Accept": "application/json" } });
      if (res.ok) {
        const data = await res.json();
        this._add("Cart API", "pass", `Shopify cart API works (${data.item_count || 0} items)`, Date.now() - t);
      } else {
        this._add("Cart API", "warn", `Cart API returned ${res.status} — may not be Shopify`, Date.now() - t);
      }
    } catch (err) {
      this._add("Cart API", "warn", `Cart API not available: ${err.message}`, Date.now() - t);
    }
  }

  // ─── Test 8: Payment tokenization ───
  async testPaymentTokenization(paymentDetails) {
    const t = Date.now();
    try {
      const fc = new FastCheckout();
      const token = await fc.getPaymentSessionToken(paymentDetails);
      if (token && token.length > 10) {
        this._add("Payment Tokenization", "pass", `Token obtained: ${token.substring(0, 16)}...`, Date.now() - t);
      } else {
        this._add("Payment Tokenization", "fail", "No token returned", Date.now() - t);
      }
    } catch (err) {
      this._add("Payment Tokenization", "fail", `Tokenization failed: ${err.message}`, Date.now() - t);
    }
  }

  // ─── Test 9: Proxy connectivity ───
  async testProxies(proxyList) {
    const proxies = proxyList.filter(Boolean).slice(0, 5); // Test max 5
    for (let i = 0; i < proxies.length; i++) {
      const t = Date.now();
      const proxy = proxies[i];
      try {
        const { HttpsProxyAgent } = require("https-proxy-agent");
        const agent = new HttpsProxyAgent(proxy.includes("://") ? proxy : `http://${proxy}`);
        const res = await fetch("https://httpbin.org/ip", { agent, timeout: 10000 });
        if (res.ok) {
          const data = await res.json();
          this._add(`Proxy ${i + 1}`, "pass", `${proxy.substring(0, 25)}... → IP: ${data.origin}`, Date.now() - t);
        } else {
          this._add(`Proxy ${i + 1}`, "fail", `${proxy.substring(0, 25)}... returned ${res.status}`, Date.now() - t);
        }
      } catch (err) {
        this._add(`Proxy ${i + 1}`, "fail", `${proxy.substring(0, 25)}... error: ${err.message}`, Date.now() - t);
      }
    }
  }

  // ─── Test 10: Dependencies ───
  async testDependencies() {
    const t = Date.now();
    const deps = [
      { name: "express", pkg: "express" },
      { name: "node-fetch", pkg: "node-fetch" },
      { name: "puppeteer", pkg: "puppeteer" },
      { name: "nodemailer", pkg: "nodemailer" },
      { name: "undici", pkg: "undici" },
      { name: "https-proxy-agent", pkg: "https-proxy-agent" },
    ];
    const missing = [];
    for (const dep of deps) {
      try { require(dep.pkg); } catch (_) { missing.push(dep.name); }
    }
    if (missing.length === 0) {
      this._add("Dependencies", "pass", `All ${deps.length} required packages installed`, Date.now() - t);
    } else {
      this._add("Dependencies", "fail", `Missing: ${missing.join(", ")}`, Date.now() - t);
    }
  }
}

module.exports = { SelfTest };
