const EventEmitter = require("events");
const puppeteer = require("puppeteer");

/**
 * CaptchaHarvester — Pre-solves CAPTCHA tokens in background browser windows
 * and banks them for instant injection during checkout.
 *
 * How it works:
 *   1. Opens N harvester browser windows pointing at a CAPTCHA-bearing page
 *   2. Each window continuously solves CAPTCHAs (reCAPTCHA v2, hCaptcha)
 *   3. Solved tokens are stored in a token bank with timestamps
 *   4. When checkout needs a token, it grabs one from the bank (0ms vs 15-30s)
 *   5. Tokens expire after ~110s (reCAPTCHA) or ~110s (hCaptcha), so we track age
 *
 * Token types supported:
 *   - reCAPTCHA v2 (checkbox + invisible)
 *   - hCaptcha
 */

const TOKEN_MAX_AGE_MS = 100000; // 100s — tokens expire at ~120s, use before 110s
const MAX_BANK_SIZE = 20;
const MAX_WINDOWS = 10;

class CaptchaHarvester extends EventEmitter {
  constructor() {
    super();
    this.tokenBank = []; // { token, type, sitekey, timestamp }
    this.browsers = [];
    this.pages = [];
    this.running = false;
    this.solveCount = 0;
    this.harvestInterval = null;
    this.windowStatus = []; // per-window status: { state, lastSolve, solveCount }
  }

  log(message, type = "info") {
    const entry = { timestamp: new Date().toISOString(), type, message: `[HARVESTER] ${message}` };
    console.log(`[HARVESTER][${type.toUpperCase()}] ${message}`);
    this.emit("log", entry);
  }

  /**
   * Start harvesting CAPTCHA tokens.
   * @param {Object} config
   * @param {string} config.siteUrl - URL of the page with CAPTCHA (e.g. checkout page)
   * @param {string} config.sitekey - CAPTCHA sitekey (extracted from page)
   * @param {string} config.type - "recaptchav2" or "hcaptcha"
   * @param {number} config.windows - Number of harvester windows (1-5)
   * @param {string} config.apiKey2c - 2Captcha API key (optional, for API-assisted solving)
   * @param {string} config.apiKeyAc - Anti-Captcha API key (optional)
   * @param {string} config.apiKeyCs - CapSolver API key (optional)
   */
  async start(config) {
    const {
      siteUrl, sitekey, type = "recaptchav2",
      windows = 2,
      apiKey2c, apiKeyAc, apiKeyCs,
    } = config;

    if (this.running) {
      this.log("Already running.", "error");
      return;
    }

    this.running = true;
    this.tokenBank = [];
    this.solveCount = 0;

    const numWindows = Math.min(Math.max(windows, 1), MAX_WINDOWS);
    this.log(`Starting ${numWindows} harvester window(s) for ${type} on ${siteUrl}`);
    this.log(`Sitekey: ${sitekey || "auto-detect"}`);

    // Determine solving strategy
    const hasApiKey = !!(apiKey2c || apiKeyAc || apiKeyCs);

    for (let i = 0; i < numWindows; i++) {
      try {
        const browser = await puppeteer.launch({
          headless: false, // Must be visible for CAPTCHA interaction
          defaultViewport: { width: 400, height: 580 },
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            `--window-size=400,580`,
            `--window-position=${50 + i * 420},50`,
          ],
        });

        this.browsers.push(browser);

        const page = await browser.newPage();
        this.pages.push(page);

        // Stealth: remove webdriver flag
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, "webdriver", { get: () => false });
          delete navigator.__proto__.webdriver;
        });

        if (hasApiKey) {
          // API-assisted harvesting: load a minimal page with the CAPTCHA widget
          await this._setupApiHarvesterPage(page, i, { siteUrl, sitekey, type, apiKey2c, apiKeyAc, apiKeyCs });
        } else {
          // Manual harvesting: navigate to the actual site and let user solve
          await this._setupManualHarvesterPage(page, i, { siteUrl, sitekey, type });
        }

        this.windowStatus.push({ state: "ready", lastSolve: null, solveCount: 0, windowIdx: i });
        this.log(`Window ${i + 1} ready.`, "success");
      } catch (err) {
        this.windowStatus.push({ state: "error", lastSolve: null, solveCount: 0, windowIdx: i });
        this.log(`Window ${i + 1} failed: ${err.message}`, "error");
      }
    }

    // Prune expired tokens periodically
    this.harvestInterval = setInterval(() => this._pruneExpired(), 10000);

    this.log(`Harvester running with ${this.browsers.length} window(s). Tokens will appear in bank as solved.`, "success");
  }

  /**
   * API-assisted harvester: loads a minimal CAPTCHA page and auto-solves via API
   */
  async _setupApiHarvesterPage(page, windowIdx, config) {
    const { siteUrl, sitekey, type, apiKey2c, apiKeyAc, apiKeyCs } = config;

    // Build a minimal HTML page that loads the CAPTCHA widget
    const captchaHtml = type === "hcaptcha"
      ? this._buildHcaptchaPage(sitekey, siteUrl)
      : this._buildRecaptchaPage(sitekey, siteUrl);

    await page.setContent(captchaHtml);
    await page.waitForTimeout(2000);

    // Start continuous solving loop
    this._apiSolveLoop(page, windowIdx, { siteUrl, sitekey, type, apiKey2c, apiKeyAc, apiKeyCs });
  }

  /**
   * Continuous API solve loop for one window
   */
  async _apiSolveLoop(page, windowIdx, config) {
    const { siteUrl, sitekey, type, apiKey2c, apiKeyAc, apiKeyCs } = config;
    const fetch = require("node-fetch");

    while (this.running) {
      if (this.tokenBank.length >= MAX_BANK_SIZE) {
        await this._sleep(5000);
        continue;
      }

      try {
        let token = null;

        // Try each provider in order
        if (apiKey2c) {
          token = await this._solve2Captcha(apiKey2c, sitekey, siteUrl, type);
        }
        if (!token && apiKeyAc) {
          token = await this._solveAntiCaptcha(apiKeyAc, sitekey, siteUrl, type);
        }
        if (!token && apiKeyCs) {
          token = await this._solveCapSolver(apiKeyCs, sitekey, siteUrl, type);
        }

        if (token) {
          this.solveCount++;
          this.tokenBank.push({
            token,
            type,
            sitekey,
            timestamp: Date.now(),
            window: windowIdx,
          });
          if (this.windowStatus[windowIdx]) {
            this.windowStatus[windowIdx].state = "solved";
            this.windowStatus[windowIdx].lastSolve = Date.now();
            this.windowStatus[windowIdx].solveCount++;
          }
          this.log(`Token #${this.solveCount} banked (bank: ${this.tokenBank.length}/${MAX_BANK_SIZE})`, "success");
          this.emit("token-banked", { count: this.tokenBank.length, total: this.solveCount });

          // Inject token into page to show it's solved (visual feedback)
          await page.evaluate((t) => {
            const el = document.getElementById("status");
            if (el) el.textContent = `✓ Token #${t} banked`;
          }, this.solveCount).catch(() => {});
        }
      } catch (err) {
        this.log(`Window ${windowIdx + 1} solve error: ${err.message}`, "error");
        await this._sleep(3000);
      }

      // Small delay between solves
      await this._sleep(1000);
    }
  }

  /**
   * Manual harvester: navigates to the real site, user solves CAPTCHA manually
   */
  async _setupManualHarvesterPage(page, windowIdx, config) {
    const { siteUrl, sitekey, type } = config;

    // Navigate to the actual page
    try {
      await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    } catch (_) {
      // If the real page fails, use a minimal CAPTCHA page
      const html = type === "hcaptcha"
        ? this._buildHcaptchaPage(sitekey, siteUrl)
        : this._buildRecaptchaPage(sitekey, siteUrl);
      await page.setContent(html);
    }

    // Listen for CAPTCHA token responses
    await page.exposeFunction("__harvestToken", (token) => {
      if (!token || token.length < 20) return;
      this.solveCount++;
      this.tokenBank.push({ token, type, sitekey, timestamp: Date.now(), window: windowIdx });
      this.log(`Manual token #${this.solveCount} banked (bank: ${this.tokenBank.length})`, "success");
      this.emit("token-banked", { count: this.tokenBank.length, total: this.solveCount });
    });

    // Inject token capture script
    await page.evaluate((captchaType) => {
      // Poll for solved tokens
      setInterval(() => {
        try {
          if (captchaType === "recaptchav2" && typeof grecaptcha !== "undefined") {
            const token = grecaptcha.getResponse();
            if (token && token.length > 20) {
              window.__harvestToken(token);
              grecaptcha.reset(); // Reset for next solve
            }
          }
          if (captchaType === "hcaptcha" && typeof hcaptcha !== "undefined") {
            const token = hcaptcha.getResponse();
            if (token && token.length > 20) {
              window.__harvestToken(token);
              hcaptcha.reset();
            }
          }
        } catch (_) {}
      }, 1000);
    }, type);

    this.log(`Window ${windowIdx + 1}: Manual mode — solve CAPTCHAs in the browser window.`, "info");
  }

  // ─── 2Captcha API ───
  async _solve2Captcha(apiKey, sitekey, pageUrl, type) {
    const fetch = require("node-fetch");
    const method = type === "hcaptcha" ? "hcaptcha" : "userrecaptcha";

    const createRes = await fetch(`http://2captcha.com/in.php?key=${apiKey}&method=${method}&sitekey=${sitekey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`, { timeout: 10000 });
    const createData = await createRes.json();
    if (createData.status !== 1) throw new Error(createData.request || "2Captcha create failed");

    const taskId = createData.request;
    for (let i = 0; i < 30; i++) {
      await this._sleep(5000);
      const resultRes = await fetch(`http://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`, { timeout: 10000 });
      const resultData = await resultRes.json();
      if (resultData.status === 1) return resultData.request;
      if (resultData.request !== "CAPCHA_NOT_READY") throw new Error(resultData.request);
    }
    throw new Error("2Captcha timeout");
  }

  // ─── Anti-Captcha API ───
  async _solveAntiCaptcha(apiKey, sitekey, pageUrl, type) {
    const fetch = require("node-fetch");
    const taskType = type === "hcaptcha" ? "HCaptchaTaskProxyless" : "RecaptchaV2TaskProxyless";

    const createRes = await fetch("https://api.anti-captcha.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: { type: taskType, websiteURL: pageUrl, websiteKey: sitekey },
      }),
      timeout: 10000,
    });
    const createData = await createRes.json();
    if (createData.errorId) throw new Error(createData.errorDescription || "AC create failed");

    const taskId = createData.taskId;
    for (let i = 0; i < 30; i++) {
      await this._sleep(5000);
      const resultRes = await fetch("https://api.anti-captcha.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        timeout: 10000,
      });
      const resultData = await resultRes.json();
      if (resultData.status === "ready") return resultData.solution.gRecaptchaResponse || resultData.solution.token;
      if (resultData.errorId) throw new Error(resultData.errorDescription);
    }
    throw new Error("Anti-Captcha timeout");
  }

  // ─── CapSolver API ───
  async _solveCapSolver(apiKey, sitekey, pageUrl, type) {
    const fetch = require("node-fetch");
    const taskType = type === "hcaptcha" ? "HCaptchaTaskProxyLess" : "ReCaptchaV2TaskProxyLess";

    const createRes = await fetch("https://api.capsolver.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: { type: taskType, websiteURL: pageUrl, websiteKey: sitekey },
      }),
      timeout: 10000,
    });
    const createData = await createRes.json();
    if (createData.errorId) throw new Error(createData.errorDescription || "CS create failed");

    const taskId = createData.taskId;
    for (let i = 0; i < 30; i++) {
      await this._sleep(3000);
      const resultRes = await fetch("https://api.capsolver.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        timeout: 10000,
      });
      const resultData = await resultRes.json();
      if (resultData.status === "ready") return resultData.solution.gRecaptchaResponse || resultData.solution.token;
      if (resultData.errorId && resultData.errorId !== 0) throw new Error(resultData.errorDescription);
    }
    throw new Error("CapSolver timeout");
  }

  // ─── Build minimal reCAPTCHA page ───
  _buildRecaptchaPage(sitekey, siteUrl) {
    return `<!DOCTYPE html><html><head>
      <title>CAPTCHA Harvester</title>
      <script src="https://www.google.com/recaptcha/api.js" async defer></script>
      <style>body{font-family:sans-serif;background:#1a1d27;color:#e4e6f0;display:flex;flex-direction:column;align-items:center;padding:20px;}
      h3{margin:0 0 10px;font-size:14px;color:#888;}#status{color:#2ecc71;font-size:13px;margin-top:10px;}</style>
    </head><body>
      <h3>reCAPTCHA Harvester</h3>
      <div class="g-recaptcha" data-sitekey="${sitekey}" data-callback="onSolved"></div>
      <div id="status">Waiting for solve...</div>
      <script>
        function onSolved(token) {
          document.getElementById("status").textContent = "✓ Solved! Banking token...";
          if (window.__harvestToken) window.__harvestToken(token);
          setTimeout(() => { grecaptcha.reset(); document.getElementById("status").textContent = "Waiting for solve..."; }, 2000);
        }
      </script>
    </body></html>`;
  }

  // ─── Build minimal hCaptcha page ───
  _buildHcaptchaPage(sitekey, siteUrl) {
    return `<!DOCTYPE html><html><head>
      <title>CAPTCHA Harvester</title>
      <script src="https://js.hcaptcha.com/1/api.js" async defer></script>
      <style>body{font-family:sans-serif;background:#1a1d27;color:#e4e6f0;display:flex;flex-direction:column;align-items:center;padding:20px;}
      h3{margin:0 0 10px;font-size:14px;color:#888;}#status{color:#2ecc71;font-size:13px;margin-top:10px;}</style>
    </head><body>
      <h3>hCaptcha Harvester</h3>
      <div class="h-captcha" data-sitekey="${sitekey}" data-callback="onSolved"></div>
      <div id="status">Waiting for solve...</div>
      <script>
        function onSolved(token) {
          document.getElementById("status").textContent = "✓ Solved! Banking token...";
          if (window.__harvestToken) window.__harvestToken(token);
          setTimeout(() => { hcaptcha.reset(); document.getElementById("status").textContent = "Waiting for solve..."; }, 2000);
        }
      </script>
    </body></html>`;
  }

  /**
   * Get a fresh token from the bank. Returns null if none available.
   * Used by checkout flow to inject instantly instead of waiting for API solve.
   */
  getToken(type) {
    this._pruneExpired();
    const idx = this.tokenBank.findIndex(t => t.type === type);
    if (idx === -1) return null;
    const token = this.tokenBank.splice(idx, 1)[0];
    this.log(`Token consumed (bank: ${this.tokenBank.length} remaining, age: ${((Date.now() - token.timestamp) / 1000).toFixed(0)}s)`, "info");
    return token.token;
  }

  /** Check how many tokens are available */
  getTokenCount(type) {
    this._pruneExpired();
    return type ? this.tokenBank.filter(t => t.type === type).length : this.tokenBank.length;
  }

  /** Capture screenshots from all harvester windows for live viewing */
  async getScreenshots() {
    const screenshots = [];
    for (let i = 0; i < this.pages.length; i++) {
      try {
        const page = this.pages[i];
        if (page && !page.isClosed()) {
          const buf = await page.screenshot({ encoding: "base64", type: "jpeg", quality: 60 });
          screenshots.push({
            window: i + 1,
            image: `data:image/jpeg;base64,${buf}`,
            status: this.windowStatus[i] || { state: "unknown" },
          });
        }
      } catch (_) {
        screenshots.push({ window: i + 1, image: null, status: this.windowStatus[i] || { state: "error" } });
      }
    }
    return screenshots;
  }

  /** Get detailed status for all windows */
  getDetailedStatus() {
    this._pruneExpired();
    return {
      running: this.running,
      windows: this.pages.length,
      maxWindows: MAX_WINDOWS,
      tokens: this.tokenBank.length,
      maxTokens: MAX_BANK_SIZE,
      totalSolved: this.solveCount,
      windowStatus: this.windowStatus.map((ws, i) => ({
        window: i + 1,
        state: ws.state,
        solveCount: ws.solveCount,
        lastSolve: ws.lastSolve ? new Date(ws.lastSolve).toLocaleTimeString() : null,
        ageSec: ws.lastSolve ? Math.round((Date.now() - ws.lastSolve) / 1000) : null,
      })),
      tokenAges: this.tokenBank.map(t => Math.round((Date.now() - t.timestamp) / 1000)),
    };
  }

  _pruneExpired() {
    const now = Date.now();
    const before = this.tokenBank.length;
    this.tokenBank = this.tokenBank.filter(t => (now - t.timestamp) < TOKEN_MAX_AGE_MS);
    const pruned = before - this.tokenBank.length;
    if (pruned > 0) this.log(`Pruned ${pruned} expired token(s).`, "info");
  }

  async stop() {
    this.running = false;
    if (this.harvestInterval) { clearInterval(this.harvestInterval); this.harvestInterval = null; }
    for (const browser of this.browsers) {
      try { await browser.close(); } catch (_) {}
    }
    this.browsers = [];
    this.pages = [];
    this.log(`Stopped. ${this.solveCount} tokens solved total, ${this.tokenBank.length} in bank.`, "info");
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { CaptchaHarvester };
