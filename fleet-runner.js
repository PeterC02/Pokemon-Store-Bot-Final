const EventEmitter = require("events");
const { FastCheckout } = require("./fast-checkout");
const { AddressJigger } = require("./address-jigger");

/**
 * FleetRunner — Runs 1-50 isolated checkout bots concurrently.
 *
 * Each bot:
 *   - Has its own FastCheckout instance with unique UA + fingerprint
 *   - Uses its own user's shipping + payment details (no jigging needed)
 *   - Runs in a try/catch isolation boundary (one crash doesn't affect others)
 *   - Reports individual status via SSE events (queued, shipping, payment, done)
 *   - Gets its own proxy from the pool (round-robin)
 *   - Gets its own captcha token from the harvester
 *
 * The operator selects which users to run. Each user = 1 bot.
 * All bots launch simultaneously with minimal stagger (20ms) for max speed.
 */

const BOT_STATES = {
  QUEUED: "queued",
  STARTING: "starting",
  RESOLVING: "resolving",
  ADDING: "adding",
  CHECKOUT: "checkout",
  SHIPPING: "shipping",
  RATE: "rate",
  PAYMENT: "payment",
  PROCESSING: "processing",
  SUCCESS: "success",
  FAILED: "failed",
  STOPPED: "stopped",
};

class FleetRunner extends EventEmitter {
  constructor() {
    super();
    this.bots = new Map(); // botId -> { user, instance, state, startTime, result, logs }
    this.running = false;
    this.startTime = null;
    this.runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  log(message, type = "info") {
    const elapsed = this.startTime
      ? `+${((Date.now() - this.startTime) / 1000).toFixed(1)}s`
      : "";
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message: elapsed ? `[${elapsed}] [FLEET] ${message}` : `[FLEET] ${message}`,
    };
    console.log(`[FLEET][${type.toUpperCase()}] ${entry.message}`);
    this.emit("log", entry);
    return entry;
  }

  _updateBotState(botId, state, detail = "") {
    const bot = this.bots.get(botId);
    if (!bot) return;
    bot.state = state;
    bot.stateDetail = detail;
    bot.stateTime = Date.now();
    this.emit("bot-status", {
      botId,
      userId: bot.user.id,
      userName: bot.user.name,
      state,
      detail,
      elapsed: bot.startTime ? ((Date.now() - bot.startTime) / 1000).toFixed(1) : "0",
    });
  }

  getStatus() {
    const statuses = [];
    for (const [botId, bot] of this.bots) {
      statuses.push({
        botId,
        userId: bot.user.id,
        userName: bot.user.name,
        state: bot.state,
        stateDetail: bot.stateDetail || "",
        elapsed: bot.startTime ? ((Date.now() - bot.startTime) / 1000).toFixed(1) : "0",
        success: bot.result?.success || false,
        error: bot.result?.error || "",
      });
    }
    return {
      running: this.running,
      runId: this.runId,
      totalBots: this.bots.size,
      statuses,
      elapsed: this.startTime ? ((Date.now() - this.startTime) / 1000).toFixed(1) : "0",
    };
  }

  /**
   * Launch fleet checkout for selected users.
   * @param {Object} opts
   * @param {Object[]} opts.users - Array of user objects from UserManager
   * @param {Object} opts.target - { storeUrl, productUrl, itemName, variantId }
   * @param {boolean} opts.dryRun - If true, don't submit payment
   * @param {string[]} opts.proxyList - Proxies to distribute
   * @param {Object} opts.captchaHarvester - CaptchaHarvester instance
   * @param {string} opts.confirmationEmail - Email for confirmations
   * @param {Object} opts.smtpConfig - SMTP config
   * @param {Function} opts.toCheckoutConfig - UserManager.toCheckoutConfig function
   */
  async launch(opts) {
    const {
      users, target, dryRun = true,
      proxyList = [], captchaHarvester = null,
      confirmationEmail = "", smtpConfig = null,
      toCheckoutConfig,
    } = opts;

    if (!users || users.length === 0) {
      throw new Error("No users selected.");
    }
    if (users.length > 50) {
      throw new Error("Maximum 50 concurrent bots.");
    }
    if (!target?.storeUrl && !target?.productUrl) {
      throw new Error("Store URL or Product URL required.");
    }

    this.startTime = Date.now();
    this.running = true;
    this.bots.clear();
    this.runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    this.log(`Launching ${users.length} bot(s) — ${dryRun ? "DRY RUN" : "LIVE"}`);

    // Create all bot instances first (fast, no I/O)
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const botId = `bot-${i + 1}`;
      const instance = new FastCheckout();

      // Assign proxy (round-robin)
      if (proxyList.length > 0) {
        const proxy = proxyList[i % proxyList.length];
        try {
          const { HttpsProxyAgent } = require("https-proxy-agent");
          let proxyUrl;
          if (proxy.includes("://")) {
            proxyUrl = proxy; // Already a URL: http://user:pass@host:port
          } else {
            // Parse host:port:user:pass format → http://user:pass@host:port
            const parts = proxy.split(":");
            if (parts.length === 4) {
              proxyUrl = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
            } else if (parts.length === 2) {
              proxyUrl = `http://${parts[0]}:${parts[1]}`;
            } else {
              proxyUrl = `http://${proxy}`;
            }
          }
          instance.proxyAgent = new HttpsProxyAgent(proxyUrl);
          // Log proxy assignment (mask credentials)
          const masked = proxyUrl.replace(/:([^:@\/]+)@/, ':***@');
          this.log(`Bot ${i + 1} (${user.name}): proxy ${masked}`, "info");
        } catch (e) {
          this.log(`Bot ${i + 1} (${user.name}): proxy setup failed — ${e.message}`, "error");
        }
      }

      // Forward logs with bot ID + user name prefix
      instance.on("log", (entry) => {
        entry.message = `[B${i + 1}:${user.name}] ${entry.message}`;
        this.emit("log", entry);
      });

      this.bots.set(botId, {
        user,
        instance,
        state: BOT_STATES.QUEUED,
        stateDetail: "",
        startTime: null,
        result: null,
        logs: [],
      });

      this._updateBotState(botId, BOT_STATES.QUEUED, "Waiting to start");
    }

    // Launch all bots concurrently with minimal stagger (20ms)
    const botPromises = [];
    let botIndex = 0;

    for (const [botId, bot] of this.bots) {
      const idx = botIndex++;
      const staggerMs = idx * 20; // 20ms stagger — fast enough for speed, avoids burst

      const promise = this._runSingleBot(botId, bot, {
        target,
        dryRun,
        captchaHarvester,
        confirmationEmail,
        smtpConfig,
        toCheckoutConfig,
        staggerMs,
        taskIndex: idx,
      });

      botPromises.push(promise);
    }

    // Wait for ALL bots to finish (don't cancel on first success — each user is independent)
    const results = await Promise.allSettled(botPromises);

    this.running = false;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    // Tally results
    let successCount = 0;
    let failCount = 0;
    const summaries = [];

    for (const [botId, bot] of this.bots) {
      if (bot.result?.success) successCount++;
      else failCount++;
      summaries.push({
        botId,
        userId: bot.user.id,
        userName: bot.user.name,
        success: bot.result?.success || false,
        elapsed: bot.result?.elapsed || "?",
        error: bot.result?.error || "",
        step: bot.result?.step || "",
      });
    }

    this.log(`Fleet complete: ${successCount} success, ${failCount} failed (${elapsed}s total)`,
      successCount > 0 ? "success" : "error");

    this.emit("fleet-complete", {
      runId: this.runId,
      success: successCount > 0,
      successCount,
      failCount,
      total: users.length,
      elapsed,
      dryRun,
      summaries,
    });

    return {
      success: successCount > 0,
      successCount,
      failCount,
      total: users.length,
      elapsed,
      dryRun,
      summaries,
    };
  }

  /**
   * Run a single bot in full isolation. Errors here NEVER propagate to other bots.
   */
  async _runSingleBot(botId, bot, opts) {
    const {
      target, dryRun, captchaHarvester,
      confirmationEmail, smtpConfig, toCheckoutConfig,
      staggerMs, taskIndex,
    } = opts;

    // Stagger start
    if (staggerMs > 0) {
      await new Promise((r) => setTimeout(r, staggerMs));
    }

    // Check if fleet was stopped during stagger
    if (!this.running) {
      this._updateBotState(botId, BOT_STATES.STOPPED, "Fleet stopped");
      bot.result = { success: false, error: "Fleet stopped" };
      return;
    }

    bot.startTime = Date.now();
    this._updateBotState(botId, BOT_STATES.STARTING, "Initializing...");

    try {
      // Build config from user's details
      const userConfig = toCheckoutConfig(bot.user);

      // Apply address jigging — each bot gets a unique address variant
      const jiggedDetails = AddressJigger.jig(userConfig.checkoutDetails, taskIndex);
      if (taskIndex > 0) {
        this.log(`Bot ${botId} (${bot.user.name}): address jigged — "${jiggedDetails.address}" / "${jiggedDetails.zip}"`, "info");
      }

      const config = {
        storeUrl: target.storeUrl || "",
        productUrl: target.productUrl || "",
        itemName: target.itemName || "",
        variantId: target.variantId || "",
        checkoutDetails: jiggedDetails,
        paymentDetails: userConfig.paymentDetails,
        dryRun,
        confirmationEmail: confirmationEmail || bot.user.shipping?.email || "",
        smtpConfig,
        taskIndex: 0, // Set to 0 so fast-checkout's built-in jigAddress is a no-op (fleet-runner already jigged)
      };

      if (captchaHarvester) config.captchaHarvester = captchaHarvester;

      // Hook into the FastCheckout instance to track state changes
      const instance = bot.instance;
      const origLog = instance.log.bind(instance);
      instance.log = (message, type = "info") => {
        // Detect state from log messages
        const lm = message.toLowerCase();
        if (lm.includes("resolv") || lm.includes("variant")) {
          this._updateBotState(botId, BOT_STATES.RESOLVING, message);
        } else if (lm.includes("add") && lm.includes("cart")) {
          this._updateBotState(botId, BOT_STATES.ADDING, message);
        } else if (lm.includes("checkout") && !lm.includes("shipping") && !lm.includes("payment")) {
          this._updateBotState(botId, BOT_STATES.CHECKOUT, message);
        } else if (lm.includes("shipping address") || lm.includes("shipping info")) {
          this._updateBotState(botId, BOT_STATES.SHIPPING, message);
        } else if (lm.includes("shipping rate")) {
          this._updateBotState(botId, BOT_STATES.RATE, message);
        } else if (lm.includes("payment") || lm.includes("tokeniz")) {
          this._updateBotState(botId, BOT_STATES.PAYMENT, message);
        } else if (lm.includes("processing")) {
          this._updateBotState(botId, BOT_STATES.PROCESSING, message);
        }
        return origLog(message, type);
      };

      // Run the checkout
      const result = await instance.run(config);
      bot.result = result;

      if (result.success) {
        this._updateBotState(botId, BOT_STATES.SUCCESS,
          dryRun ? `DRY RUN in ${result.elapsed}s` : `ORDER PLACED in ${result.elapsed}s!`);
        this.log(`Bot ${botId} (${bot.user.name}): ${dryRun ? "DRY RUN" : "SUCCESS"} in ${result.elapsed}s`, "success");
      } else {
        this._updateBotState(botId, BOT_STATES.FAILED,
          result.error || `Failed at: ${result.step || "unknown"}`);
        this.log(`Bot ${botId} (${bot.user.name}): FAILED at ${result.step || "unknown"} — ${result.error || ""}`, "error");
      }
    } catch (err) {
      // ISOLATION: This catch ensures one bot's crash never affects others
      bot.result = { success: false, error: err.message, step: "fatal" };
      this._updateBotState(botId, BOT_STATES.FAILED, `CRASH: ${err.message}`);
      this.log(`Bot ${botId} (${bot.user.name}): CRASHED — ${err.message}`, "error");
    }
  }

  stop() {
    this.running = false;
    for (const [botId, bot] of this.bots) {
      // Signal the FastCheckout instance to abort at next step
      if (bot.instance) bot.instance.stopped = true;
      if (bot.state !== BOT_STATES.SUCCESS && bot.state !== BOT_STATES.FAILED) {
        this._updateBotState(botId, BOT_STATES.STOPPED, "Stopped by operator");
      }
    }
    this.log("Fleet stopped by operator.", "error");
    this.emit("fleet-stopped");
  }
}

module.exports = { FleetRunner, BOT_STATES };
