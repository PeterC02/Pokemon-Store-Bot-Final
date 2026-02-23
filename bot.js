const puppeteer = require("puppeteer");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const EventEmitter = require("events");
const { ProxyManager } = require("./proxy-manager");
const { CaptchaSolver } = require("./captcha-solver");

const SCREENSHOTS_DIR = path.join(__dirname, "public", "screenshots");
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ─── Browser Pool: Pre-warm and reuse browser instances ───
class BrowserPool {
  constructor() {
    this.idle = [];
    this.maxIdle = 2;
  }

  async acquire(headless = false, proxyArg = null) {
    // Don't reuse pooled browsers when a proxy is specified
    if (!proxyArg && this.idle.length > 0) {
      const browser = this.idle.pop();
      try {
        if (browser.isConnected()) return browser;
      } catch (_) {}
    }
    const args = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--no-default-browser-check",
    ];
    if (proxyArg) args.push(`--proxy-server=${proxyArg}`);
    const launchOpts = {
      headless: headless ? "new" : false,
      defaultViewport: { width: 1280, height: 900 },
      args,
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    return puppeteer.launch(launchOpts);
  }

  async release(browser) {
    if (this.idle.length < this.maxIdle && browser.isConnected()) {
      const pages = await browser.pages();
      for (const p of pages) await p.close().catch(() => {});
      this.idle.push(browser);
    } else {
      await browser.close().catch(() => {});
    }
  }

  async warmUp(headless = false) {
    if (this.idle.length < this.maxIdle) {
      const b = await this.acquire(headless);
      this.idle.push(b);
    }
  }

  async shutdown() {
    for (const b of this.idle) await b.close().catch(() => {});
    this.idle = [];
  }
}

const browserPool = new BrowserPool();

// ─── Main Bot ───
class CartBot extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.page = null;
    this.logs = [];
    this.startTime = null;
    this.screenshotCount = 0;
    this.runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ─── Logging with SSE emission ───
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
    console.log(`[${type.toUpperCase()}] ${entry.message}`);
    this.emit("log", entry);
    return entry;
  }

  getLogs() { return this.logs; }
  clearLogs() { this.logs = []; }

  // ─── Retry with exponential backoff ───
  async retry(fn, label, maxAttempts = 3, baseDelay = 500) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await fn();
        if (result !== false && result !== null && result !== undefined) return result;
        if (attempt < maxAttempts) {
          const wait = baseDelay * Math.pow(2, attempt - 1);
          this.log(`${label}: attempt ${attempt}/${maxAttempts} failed, retrying in ${wait}ms...`, "info");
          await this.delay(wait);
        }
      } catch (err) {
        if (attempt < maxAttempts) {
          const wait = baseDelay * Math.pow(2, attempt - 1);
          this.log(`${label}: error "${err.message}", retrying in ${wait}ms... (${attempt}/${maxAttempts})`, "error");
          await this.delay(wait);
        } else {
          this.log(`${label}: all ${maxAttempts} attempts failed.`, "error");
          return false;
        }
      }
    }
    return false;
  }

  // ─── Screenshot on failure ───
  async screenshot(label = "failure") {
    if (!this.page) return null;
    try {
      this.screenshotCount++;
      const filename = `${this.runId}_${this.screenshotCount}_${label}.png`;
      const filepath = path.join(SCREENSHOTS_DIR, filename);
      await this.page.screenshot({ path: filepath, fullPage: false });
      this.log(`Screenshot saved: ${filename}`, "info");
      return `/screenshots/${filename}`;
    } catch (err) {
      this.log(`Screenshot failed: ${err.message}`, "error");
      return null;
    }
  }

  // ─── Levenshtein fuzzy matching ───
  static levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  static similarity(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - CartBot.levenshtein(a, b) / maxLen;
  }

  // ─── Full stealth patches ───
  async applyStealthPatches() {
    await this.page.evaluateOnNewDocument(() => {
      // webdriver
      Object.defineProperty(navigator, "webdriver", { get: () => false });

      // chrome runtime
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };

      // permissions
      const origQuery = window.navigator.permissions?.query;
      if (origQuery) {
        window.navigator.permissions.query = (params) =>
          params.name === "notifications"
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(params);
      }

      // plugins
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5].map(() => ({
          name: "Chrome PDF Plugin",
          description: "Portable Document Format",
          filename: "internal-pdf-viewer",
          length: 1,
        })),
      });

      // languages
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });

      // WebGL vendor/renderer
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (param) {
        if (param === 37445) return "Intel Inc.";
        if (param === 37446) return "Intel Iris OpenGL Engine";
        return getParameter.call(this, param);
      };

      // platform
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });

      // hardwareConcurrency
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });

      // deviceMemory
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
    });
  }

  // ─── Cookie/popup auto-dismiss ───
  async dismissPopups() {
    try {
      await this.page.evaluate(() => {
        const dismissPatterns = [
          "accept all", "accept cookies", "accept", "i agree", "agree",
          "got it", "ok", "okay", "close", "dismiss", "no thanks",
          "continue", "i understand", "allow all", "allow",
          "reject all", "reject", "decline", "not now",
        ];
        const candidates = document.querySelectorAll(
          'button, a, [role="button"], [class*="cookie"] button, [class*="consent"] button, [class*="popup"] button, [class*="modal"] button, [class*="banner"] button, [id*="cookie"] button, [id*="consent"] button'
        );
        for (const pattern of dismissPatterns) {
          for (const el of candidates) {
            const text = (el.textContent || el.value || el.getAttribute("aria-label") || "").toLowerCase().trim();
            if (text === pattern || (text.length < 30 && text.includes(pattern))) {
              el.click();
              return { dismissed: true, text };
            }
          }
        }
        // Also try to remove overlay elements
        const overlays = document.querySelectorAll(
          '[class*="overlay"], [class*="modal"], [class*="popup"], [class*="cookie-banner"], [class*="consent"]'
        );
        for (const el of overlays) {
          if (el.offsetHeight > 100 && getComputedStyle(el).position === "fixed") {
            el.remove();
            return { dismissed: true, text: "removed overlay" };
          }
        }
        return { dismissed: false };
      });
    } catch (_) {}
  }

  // ─── Session persistence: save/load cookies ───
  async saveCookies(domain) {
    if (!this.page) return;
    try {
      const cookies = await this.page.cookies();
      const cookiePath = path.join(__dirname, `cookies_${domain.replace(/[^a-z0-9]/gi, "_")}.json`);
      fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
      this.log(`Saved ${cookies.length} cookies for ${domain}.`);
    } catch (err) {
      this.log(`Failed to save cookies: ${err.message}`, "error");
    }
  }

  async loadCookies(domain) {
    if (!this.page) return;
    try {
      const cookiePath = path.join(__dirname, `cookies_${domain.replace(/[^a-z0-9]/gi, "_")}.json`);
      if (fs.existsSync(cookiePath)) {
        const cookies = JSON.parse(fs.readFileSync(cookiePath, "utf-8"));
        await this.page.setCookie(...cookies);
        this.log(`Loaded ${cookies.length} saved cookies for ${domain}.`, "success");
      }
    } catch (err) {
      this.log(`Failed to load cookies: ${err.message}`, "error");
    }
  }

  // ─── Launch with pool, stealth, resource blocking, proxy, CAPTCHA ───
  async launch(headless = false, turboMode = true, proxyManager = null, captchaSolver = null) {
    this.proxyManager = proxyManager;
    this.captchaSolver = captchaSolver;
    this.activeProxy = null;

    let proxyArg = null;
    if (proxyManager && proxyManager.hasProxies) {
      this.activeProxy = proxyManager.getNext();
      proxyArg = proxyManager.toPuppeteerArg(this.activeProxy);
      this.log(`Using proxy: ${this.activeProxy.host}:${this.activeProxy.port}`);
    }

    this.log("Acquiring browser...");
    this.browser = await browserPool.acquire(headless, proxyArg);
    this.page = await this.browser.newPage();

    // Authenticate with proxy if credentials provided
    if (this.activeProxy) {
      const auth = proxyManager.getAuth(this.activeProxy);
      if (auth) {
        await this.page.authenticate(auth);
        this.log("Proxy authentication set.");
      }
    }

    await this.applyStealthPatches();

    await this.page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    );

    if (turboMode) {
      await this.page.setRequestInterception(true);
      this.page.on("request", (req) => {
        const type = req.resourceType();
        if (["image", "font", "media"].includes(type)) {
          req.abort();
        } else {
          req.continue();
        }
      });
      this.log("Turbo mode ON — blocking images/fonts/media.");
    }

    if (captchaSolver && captchaSolver.isConfigured) {
      this.log(`CAPTCHA solver ready (${captchaSolver.provider}).`);
    }

    this.log("Browser ready.");
  }

  async close() {
    if (this.browser) {
      await browserPool.release(this.browser);
      this.browser = null;
      this.page = null;
      this.log("Browser released to pool.");
    }
  }

  // ─── Mid-flow CAPTCHA check (reusable at any step) ───
  async checkForCaptcha(stepLabel = "") {
    if (!this.captchaSolver || !this.captchaSolver.isConfigured || !this.page) return false;
    try {
      const solved = await this.captchaSolver.detectAndSolve(this.page);
      if (solved) {
        this.log(`CAPTCHA solved${stepLabel ? " at " + stepLabel : ""}.`, "success");
        await this.delay(500);
        return true;
      }
    } catch (_) {}
    return false;
  }

  // ─── Smart navigation with CAPTCHA detection ───
  async navigateTo(url) {
    if (!this.page) throw new Error("Browser not launched.");
    this.log(`Navigating to: ${url}`);
    const domain = new URL(url).hostname;
    await this.loadCookies(domain);
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    this.log(`Page loaded: ${await this.page.title()}`);
    await this.dismissPopups();

    // Auto-detect and solve CAPTCHAs
    if (this.captchaSolver && this.captchaSolver.isConfigured) {
      const solved = await this.captchaSolver.detectAndSolve(this.page);
      if (solved) {
        this.log("CAPTCHA solved, reloading page...", "success");
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await this.dismissPopups();
      }
    }

    await this.saveCookies(domain);
  }

  // ─── Smart wait: wait for actual content, not fixed delay ───
  async smartWait(selectorHint, timeout = 5000) {
    try {
      if (selectorHint) {
        await this.page.waitForSelector(selectorHint, { timeout });
        return;
      }
      // Wait for DOM to stabilize (no new nodes for 300ms)
      await this.page.waitForFunction(() => {
        return new Promise((resolve) => {
          let last = document.body.innerHTML.length;
          const check = () => {
            const now = document.body.innerHTML.length;
            if (now === last) resolve(true);
            else { last = now; setTimeout(check, 300); }
          };
          setTimeout(check, 300);
        });
      }, { timeout });
    } catch (_) {}
  }

  // ─── Generic button finder (used by addToCart, checkout, guest, submit, continue) ───
  async findAndClickButton(patterns, selectorOverride, label) {
    // If user provided a custom selector, use it first
    if (selectorOverride) {
      this.log(`Using custom selector for ${label}: ${selectorOverride}`);
      try {
        await this.page.waitForSelector(selectorOverride, { timeout: 5000 });
        await this.page.click(selectorOverride);
        this.log(`Clicked custom selector for ${label}.`, "success");
        return true;
      } catch (err) {
        this.log(`Custom selector failed: ${err.message}, falling back to auto-detect.`, "error");
      }
    }

    const found = await this.page.evaluate((patterns) => {
      const candidates = document.querySelectorAll(
        'button, a, input[type="submit"], input[type="button"], [role="button"], [class*="btn"], [class*="Btn"]'
      );
      for (const pattern of patterns) {
        for (const el of candidates) {
          const text = (el.textContent || el.value || el.getAttribute("aria-label") || "").toLowerCase().trim();
          if (text.includes(pattern)) {
            el.scrollIntoView({ block: "center" });
            el.click();
            return { found: true, text: text.substring(0, 80) };
          }
        }
      }
      return { found: false };
    }, patterns);

    if (found.found) {
      this.log(`Clicked ${label}: "${found.text}"`, "success");
      return true;
    }
    return false;
  }

  // ─── Find item with fuzzy matching ───
  async findItem(itemName) {
    this.log(`Searching for item: "${itemName}"`);

    await this.smartWait(null, 4000);

    const candidates = await this.page.evaluate(() => {
      const selectors = ["a", "h1", "h2", "h3", "h4", "h5", "h6", "span", "div", "p", "li", "button"];
      const results = [];
      const seen = new Set();
      for (const sel of selectors) {
        const elements = document.querySelectorAll(sel);
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i];
          const text = (el.textContent || "").trim();
          if (!text || text.length > 200 || text.length < 3) continue;
          if (seen.has(text)) continue;
          seen.add(text);
          results.push({ selector: sel, index: i, text });
        }
      }
      return results;
    });

    const lowerName = itemName.toLowerCase().trim();
    let bestMatch = null;
    let bestScore = 0;
    let exactFound = false;

    for (const c of candidates) {
      const lowerText = c.text.toLowerCase().trim();

      if (lowerText === lowerName) {
        bestMatch = c; bestScore = 1; exactFound = true; break;
      }

      if (lowerText.includes(lowerName)) {
        const score = 0.95 - (lowerText.length - lowerName.length) * 0.001;
        if (score > bestScore) { bestScore = score; bestMatch = c; }
        continue;
      }

      const sim = CartBot.similarity(lowerName, lowerText);
      if (sim > bestScore && sim >= 0.4) { bestScore = sim; bestMatch = c; }

      const words = lowerText.split(/\s+/);
      const nameWords = lowerName.split(/\s+/).length;
      for (let w = 0; w <= words.length - nameWords; w++) {
        const window = words.slice(w, w + nameWords).join(" ");
        const wSim = CartBot.similarity(lowerName, window);
        if (wSim > bestScore && wSim >= 0.5) { bestScore = wSim; bestMatch = c; }
      }
    }

    if (!bestMatch || bestScore < 0.4) {
      this.log(`Item "${itemName}" not found (best: ${(bestScore * 100).toFixed(0)}%).`, "error");
      return null;
    }

    const handle = await this.page.evaluateHandle(
      (sel, idx) => document.querySelectorAll(sel)[idx],
      bestMatch.selector, bestMatch.index
    );

    const element = handle.asElement();
    if (element) {
      const matchType = exactFound ? "exact" : bestScore >= 0.9 ? "contains" : "fuzzy";
      this.log(`Found ${matchType} match (${(bestScore * 100).toFixed(0)}%): "${bestMatch.text.substring(0, 80)}"`, "success");
      return element;
    }

    this.log(`Item "${itemName}" — element handle lost.`, "error");
    return null;
  }

  async clickItem(element) {
    this.log("Clicking on item...");
    try {
      await element.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const clickTarget = await element.evaluate((el) => {
        const link = el.closest("a") || el.querySelector("a");
        if (link) { link.click(); return "link"; }
        el.click();
        return "element";
      });
      this.log(`Clicked ${clickTarget}.`);
      await this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
      await this.dismissPopups();
      await this.checkForCaptcha("product page");
      this.log(`Now on: ${await this.page.title()}`);
    } catch (err) {
      this.log(`Error clicking item: ${err.message}`, "error");
    }
  }

  async addToCart(selectorOverride) {
    this.log("Looking for Add to Cart button...");
    const patterns = [
      "add to cart", "add to basket", "add to bag", "add item",
      "buy now", "add", "purchase", "order now",
    ];

    const result = await this.findAndClickButton(patterns, selectorOverride, "Add to Cart");
    if (result) {
      await this.smartWait(null, 2000);
      await this.checkForCaptcha("after add-to-cart");
      return true;
    }

    // Fallback: class/id patterns
    const classFallback = await this.page.evaluate(() => {
      const classPatterns = [
        '[class*="add-to-cart"]', '[class*="addToCart"]', '[class*="add_to_cart"]',
        '[data-action="add-to-cart"]', '[id*="add-to-cart"]', '[id*="addToCart"]',
        '[class*="cart"]', '[class*="basket"]', '[class*="buy"]',
      ];
      for (const selector of classPatterns) {
        const els = document.querySelectorAll(selector);
        for (const el of els) {
          if (["BUTTON", "A", "INPUT"].includes(el.tagName)) {
            el.scrollIntoView({ block: "center" });
            el.click();
            return { found: true, text: (el.textContent || "").substring(0, 80) };
          }
        }
      }
      return { found: false };
    });

    if (classFallback.found) {
      this.log(`Clicked Add to Cart (class fallback): "${classFallback.text}"`, "success");
      await this.smartWait(null, 2000);
      return true;
    }

    this.log("Could not find Add to Cart button.", "error");
    return false;
  }

  async proceedToCheckout(selectorOverride) {
    this.log("Looking for Checkout button...");
    const patterns = [
      "proceed to checkout", "go to checkout", "checkout", "check out",
      "secure checkout", "continue to checkout",
      "view cart & check out", "view bag", "view cart",
    ];
    const result = await this.findAndClickButton(patterns, selectorOverride, "Checkout");
    if (result) {
      await this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      await this.dismissPopups();
      await this.checkForCaptcha("checkout page");
      this.log(`Now on: ${await this.page.title()}`);
      return true;
    }
    this.log("Could not find Checkout button.", "error");
    return false;
  }

  async chooseGuestCheckout(selectorOverride) {
    this.log("Looking for Guest Checkout option...");
    await this.smartWait(null, 2000);

    const guestPatterns = [
      "guest checkout", "checkout as guest", "continue as guest",
      "guest", "no account", "skip sign in",
      "continue without account", "don't have an account",
    ];

    // Try custom selector or auto-detect
    let found = await this.findAndClickButton(guestPatterns, selectorOverride, "Guest Checkout");

    if (!found) {
      // Try radio buttons
      found = await this.page.evaluate((patterns) => {
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const radio of radios) {
          const label = radio.closest("label") || document.querySelector(`label[for="${radio.id}"]`);
          if (label) {
            const lt = label.textContent.toLowerCase();
            for (const p of patterns) {
              if (lt.includes(p)) { radio.click(); return true; }
            }
          }
        }
        return false;
      }, guestPatterns);
    }

    if (found) {
      this.log("Guest checkout selected.", "success");
      // Click continue/next if present
      await this.delay(400);
      await this.page.evaluate(() => {
        const btns = document.querySelectorAll('button, input[type="submit"], a[role="button"]');
        for (const btn of btns) {
          const t = (btn.textContent || btn.value || "").toLowerCase().trim();
          if (t === "continue" || t === "next" || t === "proceed") { btn.click(); return; }
        }
      });
      await this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
      await this.checkForCaptcha("after guest checkout");
      return true;
    }

    this.log("No guest checkout option found (may not be required).", "info");
    return true;
  }

  // ─── Parallel form filling: single evaluate call fills ALL fields at once ───
  async fillAllFields(fieldMap, data, label) {
    this.log(`Filling ${label}...`);
    await this.smartWait("input, select", 3000);

    const entries = [];
    for (const field of fieldMap) {
      const value = data[field.key];
      if (value) entries.push({ ids: field.ids, value, label: field.label });
    }

    if (entries.length === 0) return 0;

    const result = await this.page.evaluate((entries) => {
      const filled = [];
      const failed = [];

      for (const entry of entries) {
        let done = false;

        // Strategy 1: by attribute
        for (const id of entry.ids) {
          if (done) break;
          const selectors = [
            `input[name="${id}"]`, `input[id="${id}"]`,
            `input[autocomplete="${id}"]`,
            `input[placeholder*="${id}" i]`, `input[aria-label*="${id}" i]`,
            `select[name="${id}"]`, `select[id="${id}"]`,
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
              el.scrollIntoView({ block: "center" });
              el.focus();
              if (el.tagName === "SELECT") {
                for (const opt of el.querySelectorAll("option")) {
                  if (opt.textContent.toLowerCase().includes(entry.value.toLowerCase()) ||
                      opt.value.toLowerCase() === entry.value.toLowerCase()) {
                    el.value = opt.value;
                    el.dispatchEvent(new Event("change", { bubbles: true }));
                    done = true; break;
                  }
                }
              } else {
                el.value = "";
                el.value = entry.value;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                el.dispatchEvent(new Event("blur", { bubbles: true }));
                done = true;
              }
              if (done) break;
            }
          }
        }

        // Strategy 2: by label text
        if (!done) {
          const labels = document.querySelectorAll("label");
          for (const id of entry.ids) {
            if (done) break;
            for (const label of labels) {
              if (label.textContent.toLowerCase().includes(id.toLowerCase())) {
                const input = label.querySelector("input, select") ||
                  document.getElementById(label.getAttribute("for"));
                if (input && input.offsetParent !== null) {
                  input.scrollIntoView({ block: "center" });
                  input.focus();
                  input.value = entry.value;
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                  input.dispatchEvent(new Event("change", { bubbles: true }));
                  done = true; break;
                }
              }
            }
          }
        }

        if (done) filled.push(entry.label);
        else failed.push(entry.label);
      }

      return { filled, failed };
    }, entries);

    for (const f of result.filled) this.log(`Filled ${f}`, "success");
    for (const f of result.failed) this.log(`Could not find: ${f}`, "error");
    this.log(`Filled ${result.filled.length}/${entries.length} ${label} fields.`);
    return result.filled.length;
  }

  async fillCheckoutDetails(details) {
    const fieldMap = [
      { key: "email", ids: ["email", "emailAddress", "email-address", "customer-email", "Email"], label: "Email" },
      { key: "firstName", ids: ["firstName", "first_name", "first-name", "fname", "given-name", "First Name"], label: "First Name" },
      { key: "lastName", ids: ["lastName", "last_name", "last-name", "lname", "family-name", "Last Name"], label: "Last Name" },
      { key: "address", ids: ["address", "address1", "addressLine1", "address-line1", "street-address", "street", "Address", "address-line-1"], label: "Address" },
      { key: "address2", ids: ["address2", "addressLine2", "address-line2", "apt", "suite", "address-line-2"], label: "Address 2" },
      { key: "city", ids: ["city", "locality", "address-level2", "City"], label: "City" },
      { key: "state", ids: ["state", "region", "province", "address-level1", "State"], label: "State" },
      { key: "zip", ids: ["zip", "zipCode", "zip-code", "postalCode", "postal-code", "postal_code", "Zip"], label: "ZIP Code" },
      { key: "country", ids: ["country", "country-name", "Country"], label: "Country" },
      { key: "phone", ids: ["phone", "telephone", "tel", "phoneNumber", "phone-number", "Phone"], label: "Phone" },
    ];
    return this.fillAllFields(fieldMap, details, "checkout details");
  }

  async fillPaymentDetails(payment) {
    this.log("Filling payment details...");
    await this.smartWait("input, iframe", 3000);

    // Try iframes first
    const iframeHandled = await this.fillPaymentIframes(payment);
    if (iframeHandled) return true;

    const fieldMap = [
      { key: "cardNumber", ids: ["cardNumber", "card-number", "cc-number", "card_number", "ccnumber", "number", "Card Number"], label: "Card Number" },
      { key: "cardName", ids: ["cardName", "cc-name", "card-name", "ccname", "name", "Name on Card", "Card Holder"], label: "Name on Card" },
      { key: "expiry", ids: ["expiry", "cc-exp", "expiration", "exp-date", "expiryDate", "Expiration"], label: "Expiry" },
      { key: "expiryMonth", ids: ["expiryMonth", "cc-exp-month", "exp-month", "expMonth", "card_exp_month"], label: "Exp Month" },
      { key: "expiryYear", ids: ["expiryYear", "cc-exp-year", "exp-year", "expYear", "card_exp_year"], label: "Exp Year" },
      { key: "cvv", ids: ["cvv", "cvc", "cc-csc", "securityCode", "security-code", "card-cvc", "CVV"], label: "CVV" },
    ];
    const count = await this.fillAllFields(fieldMap, payment, "payment");
    return count > 0;
  }

  async fillPaymentIframes(payment) {
    // Detect all payment-related iframes on the page
    const allIframes = await this.page.$$('iframe');
    if (allIframes.length === 0) return false;

    // Map iframe purposes by their attributes
    const iframeMap = {
      number: { selectors: ['iframe[name*="number"]', 'iframe[name*="card-number"]', 'iframe[title*="card number"]', 'iframe[id*="number"]', 'iframe[name*="card"]', 'iframe[src*="stripe"]', 'iframe[src*="braintree"]', 'iframe[title*="card"]', 'iframe[id*="card"]', 'iframe[class*="card"]'], value: payment.cardNumber },
      name: { selectors: ['iframe[name*="name"]', 'iframe[title*="name"]', 'iframe[id*="name"]'], value: payment.cardName },
      expiry: { selectors: ['iframe[name*="expiry"]', 'iframe[name*="exp"]', 'iframe[title*="expir"]', 'iframe[id*="expiry"]', 'iframe[id*="exp"]'], value: payment.expiryMonth && payment.expiryYear ? `${payment.expiryMonth} / ${payment.expiryYear.toString().slice(-2)}` : '' },
      cvv: { selectors: ['iframe[name*="cvv"]', 'iframe[name*="cvc"]', 'iframe[name*="verification"]', 'iframe[name*="security"]', 'iframe[title*="cvv"]', 'iframe[title*="cvc"]', 'iframe[title*="security"]', 'iframe[id*="cvv"]', 'iframe[id*="cvc"]'], value: payment.cvv },
    };

    let filledAny = false;

    for (const [fieldName, config] of Object.entries(iframeMap)) {
      if (!config.value) continue;
      for (const sel of config.selectors) {
        const frameHandle = await this.page.$(sel);
        if (frameHandle) {
          try {
            const frame = await frameHandle.contentFrame();
            if (frame) {
              const input = await frame.$('input');
              if (input) {
                await input.click();
                await input.type(config.value, { delay: 30 });
                this.log(`Filled ${fieldName} in iframe`, "success");
                filledAny = true;
                break;
              }
            }
          } catch (err) {
            this.log(`Iframe ${fieldName} error: ${err.message}`, "error");
          }
        }
      }
    }

    // Fallback: if we only found a single generic card iframe, try filling all inputs sequentially
    if (!filledAny) {
      const genericSelectors = [
        'iframe[name*="card"]', 'iframe[src*="stripe"]', 'iframe[src*="braintree"]',
        'iframe[title*="card"]', 'iframe[id*="card"]', 'iframe[class*="card"]',
      ];
      for (const sel of genericSelectors) {
        const frameHandle = await this.page.$(sel);
        if (frameHandle) {
          this.log(`Found generic payment iframe: ${sel}`);
          try {
            const frame = await frameHandle.contentFrame();
            if (frame) {
              const inputs = await frame.$$('input');
              const values = [payment.cardNumber, payment.expiryMonth && payment.expiryYear ? `${payment.expiryMonth}${payment.expiryYear.toString().slice(-2)}` : '', payment.cvv].filter(Boolean);
              for (let i = 0; i < Math.min(inputs.length, values.length); i++) {
                await inputs[i].click();
                await inputs[i].type(values[i], { delay: 30 });
              }
              if (inputs.length > 0) {
                this.log(`Filled ${Math.min(inputs.length, values.length)} field(s) in generic iframe`, "success");
                filledAny = true;
              }
              break;
            }
          } catch (err) {
            this.log(`Generic iframe error: ${err.message}`, "error");
          }
        }
      }
    }

    return filledAny;
  }

  async submitOrder(dryRun = true, selectorOverride) {
    // Check for CAPTCHA before attempting payment submission
    await this.checkForCaptcha("pre-payment");
    this.log(dryRun ? "[DRY RUN] Looking for Place Order button..." : "Submitting order...");

    const submitPatterns = [
      "place order", "place my order", "pay now", "submit order",
      "complete order", "complete purchase", "confirm order",
      "buy now", "pay", "finish",
    ];

    if (selectorOverride) {
      this.log(`Using custom selector for Submit: ${selectorOverride}`);
      try {
        await this.page.waitForSelector(selectorOverride, { timeout: 5000 });
        if (!dryRun) {
          await this.page.click(selectorOverride);
          this.log("Clicked custom submit selector.", "success");
          await this.delay(3000);
        } else {
          this.log("[DRY RUN] Found custom submit selector — NOT clicked.", "success");
        }
        return true;
      } catch (err) {
        this.log(`Custom selector failed: ${err.message}`, "error");
      }
    }

    const found = await this.page.evaluate(
      (patterns, dry) => {
        const candidates = document.querySelectorAll(
          'button, input[type="submit"], a[role="button"], [class*="place-order"], [class*="submit-order"], [id*="place-order"]'
        );
        for (const pattern of patterns) {
          for (const el of candidates) {
            const text = (el.textContent || el.value || el.getAttribute("aria-label") || "").toLowerCase().trim();
            if (text.includes(pattern)) {
              el.scrollIntoView({ block: "center" });
              if (!dry) el.click();
              return { found: true, text: text.substring(0, 80), clicked: !dry };
            }
          }
        }
        return { found: false };
      },
      submitPatterns, dryRun
    );

    if (found.found) {
      if (dryRun) {
        this.log(`[DRY RUN] Found: "${found.text}" — NOT clicked.`, "success");
      } else {
        this.log(`Clicked submit: "${found.text}"`, "success");
        await this.delay(3000);
      }
      return true;
    }

    this.log("Could not find Place Order / Pay button.", "error");
    return false;
  }

  async clickContinue(selectorOverride) {
    this.log("Looking for Continue / Next button...");
    const patterns = [
      "continue", "next", "proceed",
      "continue to payment", "continue to shipping", "save and continue",
    ];
    const result = await this.findAndClickButton(patterns, selectorOverride, "Continue");
    if (result) {
      await this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
      await this.checkForCaptcha("after continue");
      return true;
    }
    this.log("No Continue/Next button found.", "info");
    return false;
  }

  // ─── Email confirmation ───
  async sendConfirmationEmail(config) {
    const { confirmationEmail, smtpConfig, itemName, url } = config;
    if (!confirmationEmail) return;

    this.log(`Sending confirmation email to ${confirmationEmail}...`);

    try {
      let transporter;
      if (smtpConfig && smtpConfig.host) {
        transporter = nodemailer.createTransport({
          host: smtpConfig.host,
          port: smtpConfig.port || 587,
          secure: smtpConfig.secure || false,
          auth: { user: smtpConfig.user, pass: smtpConfig.pass },
        });
      } else {
        const testAccount = await nodemailer.createTestAccount();
        transporter = nodemailer.createTransport({
          host: "smtp.ethereal.email", port: 587, secure: false,
          auth: { user: testAccount.user, pass: testAccount.pass },
        });
        this.log("Using Ethereal test SMTP.", "info");
      }

      const elapsed = this.startTime ? ((Date.now() - this.startTime) / 1000).toFixed(1) : "?";
      const logSummary = this.logs.map((l) => `[${l.type.toUpperCase()}] ${l.message}`).join("\n");

      const info = await transporter.sendMail({
        from: '"Cart Bot" <cartbot@automated.local>',
        to: confirmationEmail,
        subject: `Purchase Confirmation: ${itemName}`,
        text: `Cart Bot — Purchase Confirmation\n================================\n\nItem: ${itemName}\nSite: ${url}\nTime: ${new Date().toISOString()}\nDuration: ${elapsed}s\n\n--- Bot Log ---\n${logSummary}`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;"><h2 style="color:#6c5ce7;">Cart Bot — Purchase Confirmation</h2><table style="width:100%;border-collapse:collapse;"><tr><td style="padding:8px;font-weight:bold;">Item</td><td style="padding:8px;">${itemName}</td></tr><tr><td style="padding:8px;font-weight:bold;">Site</td><td style="padding:8px;"><a href="${url}">${url}</a></td></tr><tr><td style="padding:8px;font-weight:bold;">Completed</td><td style="padding:8px;">${new Date().toLocaleString()}</td></tr><tr><td style="padding:8px;font-weight:bold;">Duration</td><td style="padding:8px;">${elapsed}s</td></tr></table><h3 style="margin-top:24px;">Bot Log</h3><pre style="background:#1a1d27;color:#e4e6f0;padding:16px;border-radius:8px;font-size:12px;overflow-x:auto;">${logSummary}</pre></div>`,
      });

      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) this.log(`Email preview: ${previewUrl}`, "success");
      else this.log(`Confirmation sent to ${confirmationEmail}`, "success");
    } catch (err) {
      this.log(`Failed to send email: ${err.message}`, "error");
    }
  }

  // ─── Main run: all steps with retry + screenshot on failure ───
  async run(config) {
    const {
      url, itemName,
      headless = false, clickItemFirst = true,
      fullCheckout = false, checkoutDetails = {}, paymentDetails = {},
      dryRun = true, confirmationEmail = "", smtpConfig = null,
      selectors = {},
      proxyList = [], proxyStrategy = "round-robin",
      captchaProvider = "", captchaApiKey = "",
      captchaApiKey2c = "", captchaApiKeyAc = "", captchaApiKeyCs = "",
    } = config;

    this.startTime = Date.now();
    const screenshots = [];

    try {
      this.clearLogs();
      this.log("Starting bot...");

      const proxyManager = new ProxyManager(proxyList, proxyStrategy);
      if (proxyManager.hasProxies) {
        this.log(`Loaded ${proxyManager.count} proxies (${proxyStrategy}).`);
      }

      const captchaSolver = new CaptchaSolver({
        provider: captchaProvider,
        apiKey: captchaApiKey,
        apiKey2c: captchaApiKey2c,
        apiKeyAc: captchaApiKeyAc,
        apiKeyCs: captchaApiKeyCs,
        logFn: (msg, type) => this.log(msg, type),
      });

      await this.launch(headless, true, proxyManager, captchaSolver);
      await this.navigateTo(url);

      // Step 1: Find item (with retry)
      const itemElement = await this.retry(
        () => this.findItem(itemName),
        "Find item", 3, 800
      );
      if (!itemElement) {
        const ss = await this.screenshot("find-item-failed");
        if (ss) screenshots.push(ss);
        return { success: false, step: "find-item", screenshots, logs: this.getLogs() };
      }

      // Step 2: Click item
      if (clickItemFirst) {
        await this.clickItem(itemElement);
      }

      // Step 3: Add to cart (with retry)
      const added = await this.retry(
        () => this.addToCart(selectors.addToCart),
        "Add to Cart", 3, 600
      );
      if (!added) {
        const ss = await this.screenshot("add-to-cart-failed");
        if (ss) screenshots.push(ss);
        return { success: false, step: "add-to-cart", screenshots, logs: this.getLogs() };
      }
      this.log("Item added to cart!", "success");

      if (!fullCheckout) {
        this.log("Stopping after Add to Cart (full checkout not enabled).");
        return { success: true, step: "add-to-cart", logs: this.getLogs() };
      }

      // Step 4: Checkout (with retry)
      const checkedOut = await this.retry(
        () => this.proceedToCheckout(selectors.checkout),
        "Checkout", 3, 800
      );
      if (!checkedOut) {
        const ss = await this.screenshot("checkout-failed");
        if (ss) screenshots.push(ss);
        return { success: false, step: "checkout", screenshots, logs: this.getLogs() };
      }

      // Step 5: Guest checkout
      await this.chooseGuestCheckout(selectors.guestCheckout);

      // Step 6: Fill details (with retry)
      if (Object.keys(checkoutDetails).length > 0) {
        await this.retry(
          () => this.fillCheckoutDetails(checkoutDetails),
          "Fill checkout details", 2, 500
        );
        await this.clickContinue(selectors.continue);
      }

      // Step 7: Fill payment (with retry)
      if (Object.keys(paymentDetails).length > 0) {
        await this.retry(
          () => this.fillPaymentDetails(paymentDetails),
          "Fill payment", 2, 500
        );
      }

      // Step 8: Submit
      const submitted = await this.retry(
        () => this.submitOrder(dryRun, selectors.submit),
        "Submit order", 2, 1000
      );
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

      if (submitted) {
        const msg = dryRun
          ? `DRY RUN complete in ${elapsed}s — order NOT placed.`
          : `Order submitted in ${elapsed}s!`;
        this.log(msg, "success");

        // Save cookies after successful checkout
        try {
          const domain = new URL(url).hostname;
          await this.saveCookies(domain);
        } catch (_) {}

        // Step 9: Email
        if (!dryRun && confirmationEmail) {
          await this.sendConfirmationEmail({ confirmationEmail, smtpConfig, itemName, url });
        } else if (dryRun && confirmationEmail) {
          this.log("Skipping confirmation email (dry run).", "info");
        }

        return { success: true, step: "complete", dryRun, elapsed, screenshots, logs: this.getLogs() };
      }

      const ss = await this.screenshot("submit-failed");
      if (ss) screenshots.push(ss);
      return { success: false, step: "submit", screenshots, logs: this.getLogs() };
    } catch (err) {
      this.log(`Fatal error: ${err.message}`, "error");
      const ss = await this.screenshot("fatal-error");
      if (ss) screenshots.push(ss);
      return { success: false, screenshots, logs: this.getLogs() };
    }
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { CartBot, browserPool };
