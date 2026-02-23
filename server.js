require("dotenv").config();
const express = require("express");
const path = require("path");
const { CartBot, browserPool } = require("./bot");
const { FastCheckout } = require("./fast-checkout");
const { StockMonitor } = require("./stock-monitor");
const { ProfileManager } = require("./profiles");
const { TaskRunner } = require("./task-runner");
const { CaptchaHarvester } = require("./captcha-harvester");
const { PokemonCenterModule } = require("./site-modules/pokemon-center");
const { SmartProxyManager } = require("./http-engine");
const { SelfTest } = require("./self-test");
const { UserManager } = require("./user-manager");
const { FleetRunner } = require("./fleet-runner");

let activeMonitor = null;
let activeTaskRunner = null;
let activeHarvester = null;
let activeFleet = null;
let sessionKeeper = null; // Always-on session refresh loop
const profileManager = new ProfileManager();
const userManager = new UserManager();

// ─── Auto-Proxy Generation from IPRoyal .env credentials ───
function generateProxyList(count) {
  const host = process.env.IPROYAL_HOST;
  const port = process.env.IPROYAL_PORT;
  const user = process.env.IPROYAL_USER;
  const passTemplate = process.env.IPROYAL_PASS;
  if (!host || !port || !user || !passTemplate) return [];
  const proxies = [];
  for (let i = 1; i <= count; i++) {
    const sessionId = `bot${i}_${Date.now().toString(36)}`;
    const pass = passTemplate.replace("{SESSION}", sessionId);
    proxies.push(`${host}:${port}:${user}:${pass}`);
  }
  return proxies;
}

function hasProxyConfig() {
  return !!(process.env.IPROYAL_HOST && process.env.IPROYAL_PORT && process.env.IPROYAL_USER && process.env.IPROYAL_PASS);
}

// Extract proxy country code from IPRoyal password template (e.g. country-gb → GB)
function getProxyCountry() {
  const pass = process.env.IPROYAL_PASS || '';
  const match = pass.match(/country-([a-z]{2})/i);
  return match ? match[1].toUpperCase() : null;
}

// Country name → ISO code for geo-match validation
const GEO_MAP = {
  'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB', 'england': 'GB', 'gb': 'GB',
  'united states': 'US', 'usa': 'US', 'us': 'US', 'america': 'US',
  'canada': 'CA', 'australia': 'AU', 'ireland': 'IE', 'germany': 'DE',
  'france': 'FR', 'japan': 'JP', 'netherlands': 'NL', 'new zealand': 'NZ',
};
function normalizeGeoCountry(c) {
  if (!c) return null;
  const lower = c.trim().toLowerCase();
  return GEO_MAP[lower] || (c.length === 2 ? c.toUpperCase() : null);
}

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let activeBotInstance = null;

// ─── SSE: Server-Sent Events for live log streaming ───
const sseClients = new Set();

app.get("/api/logs/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("data: {\"type\":\"connected\"}\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

function broadcastLog(entry) {
  const data = JSON.stringify(entry);
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

function broadcastEvent(event, payload) {
  const data = JSON.stringify({ type: event, ...payload });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// ─── POST /api/run — Start the bot (non-blocking, streams logs via SSE) ───
app.post("/api/run", async (req, res) => {
  const {
    url, itemName, headless, clickItemFirst,
    fullCheckout, checkoutDetails, paymentDetails,
    dryRun, confirmationEmail, smtpConfig, selectors,
    proxyList, proxyStrategy,
    captchaProvider, captchaApiKey,
    captchaApiKey2c, captchaApiKeyAc, captchaApiKeyCs,
  } = req.body;

  if (!url || !itemName) {
    return res.status(400).json({ error: "Both 'url' and 'itemName' are required." });
  }

  // Close any previous instance
  if (activeBotInstance) {
    try { await activeBotInstance.close(); } catch (_) {}
  }

  const bot = new CartBot();
  activeBotInstance = bot;

  // Stream every log entry to SSE clients
  bot.on("log", (entry) => broadcastLog(entry));

  // Respond immediately — logs will stream via SSE
  res.json({ started: true, runId: bot.runId });

  try {
    const result = await bot.run({
      url,
      itemName,
      headless: headless ?? false,
      clickItemFirst: clickItemFirst ?? true,
      fullCheckout: fullCheckout ?? false,
      checkoutDetails: checkoutDetails ?? {},
      paymentDetails: paymentDetails ?? {},
      dryRun: dryRun ?? true,
      confirmationEmail: confirmationEmail ?? "",
      smtpConfig: smtpConfig ?? null,
      selectors: selectors ?? {},
      proxyList: proxyList ?? [],
      proxyStrategy: proxyStrategy ?? "round-robin",
      captchaProvider: captchaProvider ?? "",
      captchaApiKey: captchaApiKey ?? "",
      captchaApiKey2c: captchaApiKey2c ?? "",
      captchaApiKeyAc: captchaApiKeyAc ?? "",
      captchaApiKeyCs: captchaApiKeyCs ?? "",
    });

    broadcastEvent("complete", result);
  } catch (err) {
    broadcastEvent("complete", {
      success: false,
      error: err.message,
      logs: bot.getLogs(),
    });
  }
});

// ─── POST /api/stop — Stop the active bot ───
app.post("/api/stop", async (req, res) => {
  if (activeBotInstance) {
    try {
      await activeBotInstance.close();
      activeBotInstance = null;
      broadcastEvent("complete", { success: false, stopped: true });
      res.json({ message: "Bot stopped." });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } else {
    res.json({ message: "No active bot to stop." });
  }
});

// ─── POST /api/run-fast — Direct API checkout (multi-task concurrent) ───
app.post("/api/run-fast", async (req, res) => {
  const {
    storeUrl, productUrl, itemName, variantId,
    checkoutDetails, paymentDetails,
    dryRun, confirmationEmail, smtpConfig,
    proxyList, taskCount,
  } = req.body;

  if (!storeUrl && !productUrl) {
    return res.status(400).json({ error: "Store URL or Product URL is required." });
  }

  const numTasks = Math.min(Math.max(parseInt(taskCount) || 1, 1), 50);
  const proxies = (proxyList || []).filter(Boolean);

  if (numTasks > 1) {
    // Multi-task mode
    activeTaskRunner = new TaskRunner();
    activeTaskRunner.on("log", (entry) => broadcastLog(entry));

    res.json({ started: true, mode: "multi-task", taskCount: numTasks });

    try {
      const result = await activeTaskRunner.runMulti({
        storeUrl: storeUrl || "",
        productUrl: productUrl || "",
        itemName: itemName || "",
        variantId: variantId || "",
        checkoutDetails: checkoutDetails ?? {},
        paymentDetails: paymentDetails ?? {},
        dryRun: dryRun ?? true,
        confirmationEmail: confirmationEmail ?? "",
        smtpConfig: smtpConfig ?? null,
      }, numTasks, proxies);

      broadcastEvent("complete", result);
    } catch (err) {
      broadcastEvent("complete", { success: false, error: err.message });
    }
    activeTaskRunner = null;
  } else {
    // Single task mode
    const fast = new FastCheckout();
    fast.on("log", (entry) => broadcastLog(entry));

    res.json({ started: true, runId: fast.runId, mode: "fast" });

    try {
      const result = await fast.run({
        storeUrl: storeUrl || "",
        productUrl: productUrl || "",
        itemName: itemName || "",
        variantId: variantId || "",
        checkoutDetails: checkoutDetails ?? {},
        paymentDetails: paymentDetails ?? {},
        dryRun: dryRun ?? true,
        confirmationEmail: confirmationEmail ?? "",
        smtpConfig: smtpConfig ?? null,
      });

      broadcastEvent("complete", result);
    } catch (err) {
      broadcastEvent("complete", { success: false, error: err.message, logs: fast.getLogs() });
    }
  }
});

// ─── POST /api/pre-warm — Pre-warm checkout sessions before drop ───
app.post("/api/pre-warm", async (req, res) => {
  const { storeUrl, productUrl, taskCount, proxyList } = req.body;

  if (!storeUrl && !productUrl) {
    return res.status(400).json({ error: "Store URL or Product URL is required." });
  }

  activeTaskRunner = new TaskRunner();
  activeTaskRunner.on("log", (entry) => broadcastLog(entry));

  const numTasks = Math.min(Math.max(parseInt(taskCount) || 1, 1), 50);
  const proxies = (proxyList || []).filter(Boolean);

  try {
    const result = await activeTaskRunner.preWarmAll({
      storeUrl: storeUrl || "",
      productUrl: productUrl || "",
    }, numTasks, proxies);

    res.json({ preWarmed: true, ...result });
    broadcastLog({ timestamp: new Date().toISOString(), type: "success", message: `[RUNNER] ${result.warmed}/${result.total} sessions pre-warmed. Ready for drop.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/webhook-trigger — External webhook to instantly start checkout ───
app.post("/api/webhook-trigger", async (req, res) => {
  const {
    variantId, productUrl, storeUrl, itemName,
    profileId, taskCount, proxyList,
    checkoutDetails, paymentDetails, dryRun,
  } = req.body;

  broadcastLog({ timestamp: new Date().toISOString(), type: "success", message: `[WEBHOOK] External trigger received! Variant: ${variantId || "auto"}, Item: ${itemName || "auto"}` });

  // Load profile if specified
  let profile = null;
  if (profileId) {
    profile = profileManager.getById(profileId);
    if (profile) broadcastLog({ timestamp: new Date().toISOString(), type: "info", message: `[WEBHOOK] Using profile: ${profile.name}` });
  }

  const cd = profile?.checkoutDetails || checkoutDetails || {};
  const pd = profile?.paymentDetails || paymentDetails || {};
  const proxies = (proxyList || []).filter(Boolean);
  const numTasks = Math.min(Math.max(parseInt(taskCount) || 1, 1), 50);

  // If we have pre-warmed tasks, use them
  if (activeTaskRunner && activeTaskRunner.tasks.length > 0) {
    broadcastLog({ timestamp: new Date().toISOString(), type: "info", message: `[WEBHOOK] Using ${activeTaskRunner.tasks.length} pre-warmed sessions!` });
    res.json({ triggered: true, mode: "pre-warmed", tasks: activeTaskRunner.tasks.length });

    try {
      const result = await activeTaskRunner.runPreWarmed({
        storeUrl: storeUrl || "",
        productUrl: productUrl || "",
        itemName: itemName || "",
        variantId: variantId || "",
        checkoutDetails: cd,
        paymentDetails: pd,
        dryRun: dryRun ?? true,
      });
      broadcastEvent("complete", result);
    } catch (err) {
      broadcastEvent("complete", { success: false, error: err.message });
    }
    return;
  }

  // No pre-warmed sessions — run fresh multi-task
  activeTaskRunner = new TaskRunner();
  activeTaskRunner.on("log", (entry) => broadcastLog(entry));
  res.json({ triggered: true, mode: "fresh", tasks: numTasks });

  try {
    const result = await activeTaskRunner.runMulti({
      storeUrl: storeUrl || "",
      productUrl: productUrl || "",
      itemName: itemName || "",
      variantId: variantId || "",
      checkoutDetails: cd,
      paymentDetails: pd,
      dryRun: dryRun ?? true,
    }, numTasks, proxies);
    broadcastEvent("complete", result);
  } catch (err) {
    broadcastEvent("complete", { success: false, error: err.message });
  }
  activeTaskRunner = null;
});

// ─── POST /api/monitor/start — Start stock monitor ───
app.post("/api/monitor/start", async (req, res) => {
  const {
    productUrl, storeUrl, itemName, variantId,
    pollIntervalMs, maxDurationMs,
    autoCheckout, checkoutConfig,
    discordWebhookUrl,
  } = req.body;

  if (activeMonitor && activeMonitor.running) {
    return res.status(400).json({ error: "Monitor already running. Stop it first." });
  }

  activeMonitor = new StockMonitor();
  activeMonitor.on("log", (entry) => broadcastLog(entry));

  activeMonitor.on("stock-found", async (stockResult) => {
    broadcastEvent("stock-found", stockResult);

    // Auto-trigger checkout if configured
    if (autoCheckout && checkoutConfig) {
      broadcastLog({
        timestamp: new Date().toISOString(),
        type: "success",
        message: "[MONITOR] Stock found! Auto-triggering checkout...",
      });

      // Determine which mode to use
      if (checkoutConfig.mode === "fast") {
        const taskCount = Math.min(Math.max(parseInt(checkoutConfig.taskCount) || 1, 1), 50);
        const proxies = (checkoutConfig.proxyList || []).filter(Boolean);
        const baseConfig = {
          storeUrl: checkoutConfig.storeUrl || storeUrl || "",
          productUrl: productUrl || "",
          itemName: itemName || "",
          variantId: stockResult.variantId || variantId || "",
          checkoutDetails: checkoutConfig.checkoutDetails || {},
          paymentDetails: checkoutConfig.paymentDetails || {},
          dryRun: checkoutConfig.dryRun ?? true,
          confirmationEmail: checkoutConfig.confirmationEmail || "",
          smtpConfig: checkoutConfig.smtpConfig || null,
        };

        // Use pre-warmed TaskRunner if available, otherwise fresh multi-task
        if (activeTaskRunner && activeTaskRunner.tasks.length > 0) {
          broadcastLog({ timestamp: new Date().toISOString(), type: "success", message: `[MONITOR] Using ${activeTaskRunner.tasks.length} pre-warmed sessions!` });
          try {
            const result = await activeTaskRunner.runPreWarmed(baseConfig);
            broadcastEvent("complete", result);
          } catch (err) {
            broadcastEvent("complete", { success: false, error: err.message });
          }
        } else if (taskCount > 1) {
          activeTaskRunner = new TaskRunner();
          activeTaskRunner.on("log", (entry) => broadcastLog(entry));
          broadcastLog({ timestamp: new Date().toISOString(), type: "info", message: `[MONITOR] Launching ${taskCount} concurrent checkout tasks...` });
          try {
            const result = await activeTaskRunner.runMulti(baseConfig, taskCount, proxies);
            broadcastEvent("complete", result);
          } catch (err) {
            broadcastEvent("complete", { success: false, error: err.message });
          }
          activeTaskRunner = null;
        } else {
          const fast = new FastCheckout();
          fast.on("log", (entry) => broadcastLog(entry));
          try {
            const result = await fast.run(baseConfig);
            broadcastEvent("complete", result);
          } catch (err) {
            broadcastEvent("complete", { success: false, error: err.message });
          }
        }
      } else {
        const bot = new CartBot();
        activeBotInstance = bot;
        bot.on("log", (entry) => broadcastLog(entry));
        try {
          const result = await bot.run({
            url: checkoutConfig.url || productUrl || "",
            itemName: itemName || "",
            headless: checkoutConfig.headless ?? false,
            clickItemFirst: checkoutConfig.clickItemFirst ?? true,
            fullCheckout: true,
            checkoutDetails: checkoutConfig.checkoutDetails || {},
            paymentDetails: checkoutConfig.paymentDetails || {},
            dryRun: checkoutConfig.dryRun ?? true,
            confirmationEmail: checkoutConfig.confirmationEmail || "",
            smtpConfig: checkoutConfig.smtpConfig || null,
            selectors: checkoutConfig.selectors || {},
            proxyList: checkoutConfig.proxyList || [],
            captchaProvider: checkoutConfig.captchaProvider || "",
            captchaApiKey: checkoutConfig.captchaApiKey || "",
            captchaApiKey2c: checkoutConfig.captchaApiKey2c || "",
            captchaApiKeyAc: checkoutConfig.captchaApiKeyAc || "",
            captchaApiKeyCs: checkoutConfig.captchaApiKeyCs || "",
          });
          broadcastEvent("complete", result);
        } catch (err) {
          broadcastEvent("complete", { success: false, error: err.message });
        }
      }
    }
  });

  activeMonitor.on("timeout", () => {
    broadcastEvent("monitor-timeout", {});
  });

  activeMonitor.on("stopped", () => {
    broadcastEvent("monitor-stopped", {});
  });

  res.json({ started: true });

  activeMonitor.start({
    productUrl: productUrl || "",
    storeUrl: storeUrl || "",
    itemName: itemName || "",
    variantId: variantId || "",
    pollIntervalMs: pollIntervalMs || 2000,
    maxDurationMs: maxDurationMs || 30 * 60 * 1000,
    discordWebhookUrl: discordWebhookUrl || "",
  });
});

// ─── POST /api/monitor/stop — Stop stock monitor ───
app.post("/api/monitor/stop", (req, res) => {
  if (activeMonitor && activeMonitor.running) {
    activeMonitor.stop();
    activeMonitor = null;
    res.json({ message: "Monitor stopped." });
  } else {
    res.json({ message: "No active monitor." });
  }
});

// ─── CAPTCHA Harvester ───
app.post("/api/harvester/start", async (req, res) => {
  const { siteUrl, sitekey, type, windows, apiKey2c, apiKeyAc, apiKeyCs } = req.body;

  if (activeHarvester) {
    await activeHarvester.stop();
  }

  activeHarvester = new CaptchaHarvester();
  activeHarvester.on("log", (entry) => broadcastLog(entry));
  activeHarvester.on("token-banked", (data) => {
    broadcastLog({ timestamp: new Date().toISOString(), type: "success", message: `[HARVESTER] Token bank: ${data.count} ready (${data.total} total solved)` });
  });

  // Also attach to TaskRunner if active
  if (activeTaskRunner) activeTaskRunner.captchaHarvester = activeHarvester;

  try {
    await activeHarvester.start({
      siteUrl: siteUrl || "",
      sitekey: sitekey || "",
      type: type || "recaptchav2",
      windows: parseInt(windows) || 2,
      apiKey2c: apiKey2c || "",
      apiKeyAc: apiKeyAc || "",
      apiKeyCs: apiKeyCs || "",
    });
    res.json({ started: true, windows: parseInt(windows) || 2 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/harvester/stop", async (req, res) => {
  if (activeHarvester) {
    await activeHarvester.stop();
    activeHarvester = null;
    res.json({ stopped: true });
  } else {
    res.json({ message: "No active harvester." });
  }
});

app.get("/api/harvester/status", (req, res) => {
  if (!activeHarvester) return res.json({ running: false, tokens: 0 });
  res.json(activeHarvester.getDetailedStatus());
});

// ─── GET /api/harvester/screenshots — Live screenshots from CAPTCHA windows ───
app.get("/api/harvester/screenshots", async (req, res) => {
  if (!activeHarvester || !activeHarvester.running) {
    return res.json({ screenshots: [], running: false });
  }
  try {
    const screenshots = await activeHarvester.getScreenshots();
    res.json({ screenshots, running: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Profiles CRUD ───
app.get("/api/profiles", (req, res) => {
  res.json(profileManager.getAll());
});

app.post("/api/profiles", (req, res) => {
  try {
    const profile = profileManager.add(req.body);
    res.json(profile);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/profiles/:id", (req, res) => {
  try {
    const profile = profileManager.update(req.params.id, req.body);
    res.json(profile);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete("/api/profiles/:id", (req, res) => {
  try {
    profileManager.remove(req.params.id);
    res.json({ message: "Profile deleted." });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ─── POST /api/run-pokemon-center — Pokemon Center specific checkout ───
app.post("/api/run-pokemon-center", async (req, res) => {
  const {
    productUrl, itemName, sku,
    checkoutDetails, paymentDetails,
    dryRun, email, password,
  } = req.body;

  const pc = new PokemonCenterModule();
  pc.on("log", (entry) => broadcastLog(entry));

  res.json({ started: true, mode: "pokemon-center" });

  try {
    const result = await pc.run({
      productUrl: productUrl || "",
      itemName: itemName || "",
      sku: sku || "",
      checkoutDetails: checkoutDetails || {},
      paymentDetails: paymentDetails || {},
      dryRun: dryRun ?? true,
      email: email || "",
      password: password || "",
    });
    broadcastEvent("complete", result);
  } catch (err) {
    broadcastEvent("complete", { success: false, error: err.message, logs: pc.getLogs() });
  }
});

// ─── POST /api/self-test — Run diagnostic suite ───
app.post("/api/self-test", async (req, res) => {
  const { storeUrl, proxyList, paymentDetails } = req.body;
  broadcastLog({ timestamp: new Date().toISOString(), type: "info", message: "[TEST] Running self-test suite..." });

  const tester = new SelfTest();
  try {
    const results = await tester.runAll({
      storeUrl: storeUrl || "",
      proxyList: proxyList || [],
      paymentDetails: paymentDetails || {},
    });

    for (const r of results.results) {
      const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "⚠";
      broadcastLog({
        timestamp: new Date().toISOString(),
        type: r.status === "pass" ? "success" : r.status === "fail" ? "error" : "info",
        message: `[TEST] ${icon} ${r.name}: ${r.detail} (${r.ms}ms)`,
      });
    }

    broadcastLog({
      timestamp: new Date().toISOString(),
      type: results.allPassed ? "success" : "error",
      message: `[TEST] Done: ${results.passed} passed, ${results.failed} failed, ${results.warned} warnings (${results.totalMs}ms)`,
    });

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/save-sessions — Save warmed sessions to encrypted disk ───
const SESSION_FILE = path.join(__dirname, "data", "sessions.enc");
app.post("/api/save-sessions", (req, res) => {
  try {
    if (!activeTaskRunner || !activeTaskRunner.tasks.length) {
      return res.status(400).json({ error: "No active sessions to save. Pre-warm first." });
    }
    const sessions = activeTaskRunner.tasks.map(t => t.instance.serializeSession());
    FastCheckout.saveSessions(sessions, SESSION_FILE);
    broadcastLog({ timestamp: new Date().toISOString(), type: "success", message: `[SESSION] ${sessions.length} session(s) saved to disk (AES-256 encrypted).` });
    res.json({ saved: sessions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/load-sessions — Load warmed sessions from disk ───
app.post("/api/load-sessions", (req, res) => {
  try {
    const sessions = FastCheckout.loadSessions(SESSION_FILE);
    if (!sessions || sessions.length === 0) {
      return res.status(404).json({ error: "No saved sessions found." });
    }
    // Create a TaskRunner with restored sessions
    const runner = new TaskRunner();
    runner.on("log", (entry) => broadcastLog(entry));
    runner.tasks = sessions.map((data, i) => {
      const task = new FastCheckout();
      task.on("log", (entry) => { entry.message = `[T${i + 1}] ${entry.message}`; runner.emit("log", entry); });
      const restored = task.restoreSession(data);
      return { id: i + 1, instance: task, restored };
    });
    activeTaskRunner = runner;
    const restoredCount = runner.tasks.filter(t => t.restored).length;
    broadcastLog({ timestamp: new Date().toISOString(), type: "success", message: `[SESSION] ${restoredCount}/${sessions.length} session(s) restored from disk.` });
    res.json({ loaded: restoredCount, total: sessions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/poll-variant — Poll for new variant IDs (pre-drop) ───
app.post("/api/poll-variant", async (req, res) => {
  const { storeUrl, itemName, pollIntervalMs, maxDurationMs } = req.body;
  if (!storeUrl) return res.status(400).json({ error: "storeUrl required" });

  const fc = new FastCheckout();
  fc.on("log", (entry) => broadcastLog(entry));
  res.json({ started: true, message: "Polling for new variants..." });

  try {
    const result = await fc.pollForVariant(fc.getBaseUrl(storeUrl), {
      itemName: itemName || "",
      pollIntervalMs: pollIntervalMs || 1500,
      maxDurationMs: maxDurationMs || 300000,
    });
    if (result) {
      broadcastEvent("variant-found", { variantId: result.variantId, title: result.product?.title, price: result.variant?.price });
    } else {
      broadcastEvent("variant-timeout", {});
    }
  } catch (err) {
    broadcastLog({ timestamp: new Date().toISOString(), type: "error", message: `[POLL] Error: ${err.message}` });
  }
});

// ─── POST /api/session-keeper/start — Always-on session warm loop ───
// Warms sessions immediately, then refreshes them on a schedule (default every 90 min)
// Sessions stay hot all day — no manual pre-warming needed
app.post("/api/session-keeper/start", async (req, res) => {
  const {
    storeUrl, productUrl, taskCount = 3, proxyList = [],
    paymentDetails = {}, refreshIntervalMin = 90,
  } = req.body;

  if (!storeUrl && !productUrl) return res.status(400).json({ error: "storeUrl or productUrl required" });

  // Stop existing keeper
  if (sessionKeeper) {
    clearInterval(sessionKeeper.interval);
    sessionKeeper = null;
  }

  const config = { storeUrl, productUrl, taskCount, proxyList, paymentDetails, refreshIntervalMin };
  const refreshMs = Math.max(refreshIntervalMin, 10) * 60 * 1000; // min 10 min

  async function warmSessions() {
    const ts = new Date().toISOString();
    broadcastLog({ timestamp: ts, type: "info", message: `[KEEPER] Warming ${taskCount} session(s)...` });
    try {
      const runner = new TaskRunner();
      runner.on("log", (entry) => broadcastLog(entry));
      if (activeHarvester) runner.captchaHarvester = activeHarvester;
      const result = await runner.preWarmAll({
        storeUrl: storeUrl || productUrl,
        productUrl: productUrl || storeUrl,
        paymentDetails,
      }, taskCount, proxyList);
      activeTaskRunner = runner;

      // Auto-save to disk
      try {
        const sessions = runner.tasks.map(t => t.instance.serializeSession());
        FastCheckout.saveSessions(sessions, SESSION_FILE);
      } catch (_) {}

      broadcastLog({ timestamp: new Date().toISOString(), type: "success", message: `[KEEPER] ${result.warmed}/${result.total} sessions warmed + saved. Next refresh in ${refreshIntervalMin}min.` });
      broadcastEvent("keeper-status", { warmed: result.warmed, total: result.total, nextRefresh: Date.now() + refreshMs });
    } catch (err) {
      broadcastLog({ timestamp: new Date().toISOString(), type: "error", message: `[KEEPER] Warm failed: ${err.message}` });
    }
  }

  // Warm immediately
  await warmSessions();

  // Schedule refresh loop
  const interval = setInterval(warmSessions, refreshMs);

  sessionKeeper = {
    interval,
    config,
    startedAt: Date.now(),
    refreshMs,
    warmCount: 0,
  };

  res.json({
    started: true,
    taskCount,
    refreshIntervalMin,
    message: `Sessions will stay warm. Refreshing every ${refreshIntervalMin} minutes.`,
  });
});

// ─── POST /api/session-keeper/stop ───
app.post("/api/session-keeper/stop", (req, res) => {
  if (sessionKeeper) {
    clearInterval(sessionKeeper.interval);
    sessionKeeper = null;
    broadcastLog({ timestamp: new Date().toISOString(), type: "info", message: "[KEEPER] Session keeper stopped." });
  }
  res.json({ stopped: true });
});

// ─── GET /api/session-keeper/status ───
app.get("/api/session-keeper/status", (req, res) => {
  if (!sessionKeeper) return res.json({ running: false });
  const elapsed = Date.now() - sessionKeeper.startedAt;
  const nextRefreshIn = sessionKeeper.refreshMs - (elapsed % sessionKeeper.refreshMs);
  res.json({
    running: true,
    startedAt: new Date(sessionKeeper.startedAt).toISOString(),
    refreshIntervalMin: sessionKeeper.config.refreshIntervalMin,
    taskCount: sessionKeeper.config.taskCount,
    nextRefreshInSec: Math.round(nextRefreshIn / 1000),
    activeSessions: activeTaskRunner?.tasks?.length || 0,
  });
});

// ─── GET /api/timing — Request timing analytics ───
app.get("/api/timing", (req, res) => {
  // Collect timings from active task runner instances
  const timings = [];
  if (activeTaskRunner && activeTaskRunner.tasks) {
    for (const t of activeTaskRunner.tasks) {
      if (t.instance && t.instance.httpEngine) {
        timings.push({ taskId: t.id, ...t.instance.httpEngine.getTimings() });
      }
    }
  }
  res.json({ timings, timestamp: new Date().toISOString() });
});

// ─── Fleet Users CRUD ───
app.get("/api/users", (req, res) => {
  res.json(userManager.getAll());
});

app.post("/api/users", (req, res) => {
  try {
    const user = userManager.add(req.body);
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/users/bulk", (req, res) => {
  try {
    const added = userManager.addBulk(req.body.users || []);
    res.json({ added: added.length, users: added });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/users/:id", (req, res) => {
  try {
    const user = userManager.update(req.params.id, req.body);
    res.json(user);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete("/api/users/:id", (req, res) => {
  try {
    userManager.remove(req.params.id);
    res.json({ message: "User deleted." });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete("/api/users", (req, res) => {
  userManager.removeAll();
  res.json({ message: "All users deleted." });
});

app.post("/api/users/:id/toggle", (req, res) => {
  try {
    const user = userManager.toggleEnabled(req.params.id);
    res.json(user);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ─── Fleet Launch / Stop / Status ───
app.post("/api/fleet/launch", async (req, res) => {
  const {
    userIds, storeUrl, productUrl, itemName, variantId,
    dryRun, proxyList, confirmationEmail, smtpConfig,
  } = req.body;

  if (!userIds || userIds.length === 0) {
    return res.status(400).json({ error: "Select at least one user." });
  }
  if (!storeUrl && !productUrl) {
    return res.status(400).json({ error: "Store URL or Product URL required." });
  }

  // Stop any existing fleet
  if (activeFleet && activeFleet.running) {
    activeFleet.stop();
  }

  const users = userManager.getByIds(userIds);
  if (users.length === 0) {
    return res.status(400).json({ error: "No valid users found for the given IDs." });
  }

  activeFleet = new FleetRunner();
  activeFleet.on("log", (entry) => broadcastLog(entry));
  activeFleet.on("bot-status", (status) => broadcastEvent("bot-status", status));
  activeFleet.on("fleet-complete", (result) => broadcastEvent("fleet-complete", result));
  activeFleet.on("fleet-stopped", () => broadcastEvent("fleet-stopped", {}));

  let proxies = (proxyList || []).filter(Boolean);

  // Auto-generate proxies from .env if none provided manually
  if (proxies.length === 0 && hasProxyConfig()) {
    proxies = generateProxyList(users.length);
    broadcastLog({ timestamp: new Date().toISOString(), type: "success", message: `[FLEET] Auto-generated ${proxies.length} unique proxy sessions from IPRoyal config.` });
  }

  // Geo-mismatch validation: proxy IP country vs user shipping country
  const proxyCountry = getProxyCountry();
  if (proxyCountry) {
    let mismatchCount = 0;
    for (const u of users) {
      const userCountry = normalizeGeoCountry(u.shipping?.country);
      if (userCountry && userCountry !== proxyCountry) {
        mismatchCount++;
        broadcastLog({ timestamp: new Date().toISOString(), type: "error", message: `[FLEET] GEO MISMATCH: User "${u.name}" ships to ${userCountry} but proxy IP is ${proxyCountry}. Shopify may flag this order.` });
      }
    }
    if (mismatchCount > 0) {
      broadcastLog({ timestamp: new Date().toISOString(), type: "error", message: `[FLEET] WARNING: ${mismatchCount}/${users.length} users have shipping country ≠ proxy country (${proxyCountry}). Risk of fraud flags. Change proxy region in IPRoyal or update user addresses.` });
    } else {
      broadcastLog({ timestamp: new Date().toISOString(), type: "success", message: `[FLEET] Geo-match OK: all ${users.length} users ship to ${proxyCountry}, proxy IPs are ${proxyCountry}.` });
    }
  }

  res.json({ started: true, runId: activeFleet.runId, botCount: users.length, proxiesAssigned: proxies.length });

  try {
    await activeFleet.launch({
      users,
      target: { storeUrl, productUrl, itemName, variantId },
      dryRun: dryRun ?? true,
      proxyList: proxies,
      captchaHarvester: activeHarvester || null,
      confirmationEmail: confirmationEmail || "",
      smtpConfig: smtpConfig || null,
      toCheckoutConfig: (user) => userManager.toCheckoutConfig(user),
    });
  } catch (err) {
    broadcastEvent("fleet-complete", { success: false, error: err.message });
  }
});

app.post("/api/fleet/stop", (req, res) => {
  if (activeFleet && activeFleet.running) {
    activeFleet.stop();
    res.json({ stopped: true });
  } else {
    res.json({ message: "No active fleet." });
  }
});

app.get("/api/fleet/status", (req, res) => {
  if (!activeFleet) return res.json({ running: false, totalBots: 0, statuses: [] });
  res.json(activeFleet.getStatus());
});

app.get("/api/proxy/status", (req, res) => {
  const pc = getProxyCountry();
  const regionNames = { GB: 'United Kingdom', US: 'United States', CA: 'Canada', AU: 'Australia', DE: 'Germany', FR: 'France', IE: 'Ireland', NL: 'Netherlands', JP: 'Japan', NZ: 'New Zealand' };
  res.json({
    configured: hasProxyConfig(),
    provider: hasProxyConfig() ? "IPRoyal" : null,
    host: process.env.IPROYAL_HOST || null,
    region: regionNames[pc] || pc || "Auto",
    countryCode: pc || null,
    mode: "sticky",
  });
});

// ─── Warm up browser pool on startup ───
app.listen(PORT, async () => {
  console.log(`Cart Bot server running at http://localhost:${PORT}`);
  try {
    await browserPool.warmUp(true);
    console.log("Browser pool pre-warmed.");
  } catch (err) {
    console.log("Browser pool warm-up skipped:", err.message);
  }
});

// ─── Graceful shutdown ───
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await browserPool.shutdown();
  process.exit(0);
});
