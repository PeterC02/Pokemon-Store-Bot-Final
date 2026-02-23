const EventEmitter = require("events");
const { FastCheckout } = require("./fast-checkout");

/**
 * TaskRunner — Multi-task concurrency engine.
 * Runs N parallel checkout tasks across different proxies and profiles.
 * First successful checkout wins; others are cancelled.
 *
 * Features:
 *   - Run 1-50 concurrent tasks
 *   - Each task gets its own FastCheckout or CartBot instance
 *   - Each task gets a unique proxy from the pool (round-robin)
 *   - Each task gets a unique UA per session
 *   - First-to-checkout wins, others abort
 *   - Pre-checkout session warming across all tasks
 *   - Staggered start (50-200ms between tasks to avoid rate-limit bursts)
 */

class TaskRunner extends EventEmitter {
  constructor() {
    super();
    this.tasks = [];
    this.running = false;
    this.winnerFound = false;
    this.startTime = null;
  }

  log(message, type = "info") {
    const elapsed = this.startTime
      ? `+${((Date.now() - this.startTime) / 1000).toFixed(1)}s`
      : "";
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message: elapsed ? `[${elapsed}] [RUNNER] ${message}` : `[RUNNER] ${message}`,
    };
    console.log(`[RUNNER][${type.toUpperCase()}] ${entry.message}`);
    this.emit("log", entry);
    return entry;
  }

  /**
   * Run multiple concurrent fast-checkout tasks.
   * @param {Object} config - Base checkout config
   * @param {number} taskCount - Number of parallel tasks (1-50)
   * @param {string[]} proxyList - List of proxies to distribute
   * @param {Object[]} profiles - Array of profile objects (optional, cycles through)
   * @returns {Object} Result from the winning task
   */
  async runMulti(config, taskCount = 1, proxyList = [], profiles = []) {
    this.startTime = Date.now();
    this.winnerFound = false;
    this.running = true;
    this.tasks = [];

    taskCount = Math.min(Math.max(taskCount, 1), 50);
    this.log(`Starting ${taskCount} concurrent task(s)...`);

    if (proxyList.length > 0) {
      this.log(`Distributing ${proxyList.length} proxies across tasks.`);
    }

    const taskPromises = [];

    for (let i = 0; i < taskCount; i++) {
      const taskId = i + 1;
      const proxy = proxyList.length > 0 ? proxyList[i % proxyList.length] : null;
      const profile = profiles.length > 0 ? profiles[i % profiles.length] : null;

      // Build per-task config with taskIndex for address jigging
      const taskConfig = { ...config, taskIndex: i };
      if (profile) {
        if (profile.checkoutDetails) taskConfig.checkoutDetails = { ...config.checkoutDetails, ...profile.checkoutDetails };
        if (profile.paymentDetails) taskConfig.paymentDetails = { ...config.paymentDetails, ...profile.paymentDetails };
      }
      // Pass captcha harvester if available
      if (this.captchaHarvester) taskConfig.captchaHarvester = this.captchaHarvester;

      const task = new FastCheckout();

      // Assign proxy agent if proxy provided
      if (proxy) {
        try {
          const { HttpsProxyAgent } = require("https-proxy-agent");
          const proxyUrl = proxy.includes("://") ? proxy : `http://${proxy}`;
          task.proxyAgent = new HttpsProxyAgent(proxyUrl);
          this.log(`Task ${taskId}: proxy ${proxy.substring(0, 30)}...`);
        } catch (e) {
          this.log(`Task ${taskId}: proxy setup failed (${e.message})`, "error");
        }
      }

      // Forward task logs with task ID prefix
      task.on("log", (entry) => {
        entry.message = `[T${taskId}] ${entry.message}`;
        this.emit("log", entry);
      });

      this.tasks.push({ id: taskId, instance: task, proxy });

      // Stagger task starts to avoid burst rate-limiting
      const staggerMs = i * (80 + Math.random() * 120);

      const taskPromise = new Promise(async (resolve) => {
        if (staggerMs > 0) await this._sleep(staggerMs);

        // Check if another task already won
        if (this.winnerFound) {
          resolve({ taskId, success: false, reason: "another-task-won" });
          return;
        }

        try {
          let result = await task.run(taskConfig);

          // Auto-retry on payment decline with next profile
          if (!result.success && result.step === "payment" && profiles.length > 1 && !this.winnerFound) {
            const nextProfile = profiles[(i + 1) % profiles.length];
            if (nextProfile?.paymentDetails) {
              this.log(`Task ${taskId}: Payment declined, retrying with next profile...`, "info");
              const retryConfig = { ...taskConfig, paymentDetails: { ...taskConfig.paymentDetails, ...nextProfile.paymentDetails }, taskIndex: i };
              result = await task.run(retryConfig);
            }
          }

          if (result.success && !result.dryRun) {
            if (!this.winnerFound) {
              this.winnerFound = true;
              this.log(`TASK ${taskId} WON! Order placed in ${result.elapsed}s`, "success");
              resolve({ taskId, ...result, winner: true });
              return;
            }
          }

          if (result.success && result.dryRun) {
            if (!this.winnerFound) {
              this.winnerFound = true;
              this.log(`Task ${taskId}: DRY RUN complete in ${result.elapsed}s`, "success");
              resolve({ taskId, ...result, winner: true });
              return;
            }
          }

          resolve({ taskId, ...result });
        } catch (err) {
          this.log(`Task ${taskId} error: ${err.message}`, "error");
          resolve({ taskId, success: false, error: err.message });
        }
      });

      taskPromises.push(taskPromise);
    }

    // Race all tasks — first success wins
    const results = await Promise.all(taskPromises);
    this.running = false;

    const winner = results.find(r => r.winner);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    if (winner) {
      this.log(`Completed: Task ${winner.taskId} won in ${elapsed}s total.`, "success");
      return {
        success: true,
        winner: winner.taskId,
        elapsed,
        mode: "multi-task",
        taskCount,
        results,
        logs: winner.logs || [],
        dryRun: winner.dryRun,
        step: "complete",
      };
    }

    this.log(`All ${taskCount} tasks failed after ${elapsed}s.`, "error");
    return {
      success: false,
      elapsed,
      mode: "multi-task",
      taskCount,
      results,
      logs: results.flatMap(r => r.logs || []),
      step: "all-failed",
    };
  }

  /**
   * Pre-warm sessions across all tasks (call before drop).
   */
  async preWarmAll(config, taskCount = 1, proxyList = []) {
    this.startTime = Date.now();
    this.log(`Pre-warming ${taskCount} sessions...`);

    const warmPromises = [];
    this.tasks = [];

    for (let i = 0; i < Math.min(taskCount, 50); i++) {
      const task = new FastCheckout();
      const proxy = proxyList.length > 0 ? proxyList[i % proxyList.length] : null;

      if (proxy) {
        try {
          const { HttpsProxyAgent } = require("https-proxy-agent");
          task.proxyAgent = new HttpsProxyAgent(proxy.includes("://") ? proxy : `http://${proxy}`);
        } catch (_) {}
      }

      task.on("log", (entry) => {
        entry.message = `[T${i + 1}] ${entry.message}`;
        this.emit("log", entry);
      });

      this.tasks.push({ id: i + 1, instance: task, proxy });
      warmPromises.push(task.preCheckout(config));
    }

    const results = await Promise.all(warmPromises);
    const successCount = results.filter(r => r.success).length;
    this.log(`Pre-warmed ${successCount}/${taskCount} sessions.`, successCount > 0 ? "success" : "error");

    return { warmed: successCount, total: taskCount };
  }

  /**
   * Run all pre-warmed tasks instantly (called when stock detected).
   */
  async runPreWarmed(config, profiles = []) {
    if (!this.tasks.length) {
      this.log("No pre-warmed tasks. Running standard multi-task.", "info");
      return this.runMulti(config, 1);
    }

    this.startTime = Date.now();
    this.winnerFound = false;
    this.running = true;
    this.log(`Launching ${this.tasks.length} pre-warmed tasks!`);

    const taskPromises = this.tasks.map((t, i) => {
      const taskConfig = { ...config, taskIndex: i };
      if (profiles.length > 0) {
        const profile = profiles[i % profiles.length];
        if (profile?.checkoutDetails) taskConfig.checkoutDetails = { ...config.checkoutDetails, ...profile.checkoutDetails };
        if (profile?.paymentDetails) taskConfig.paymentDetails = { ...config.paymentDetails, ...profile.paymentDetails };
      }
      if (this.captchaHarvester) taskConfig.captchaHarvester = this.captchaHarvester;

      return new Promise(async (resolve) => {
        // Small stagger
        if (i > 0) await this._sleep(i * 50);
        if (this.winnerFound) { resolve({ taskId: t.id, success: false, reason: "another-task-won" }); return; }

        try {
          let result = await t.instance.runFromPreCheckout(taskConfig);

          // Auto-retry on decline with next profile
          if (!result.success && result.step === "payment" && profiles.length > 1 && !this.winnerFound) {
            const nextProfile = profiles[(i + 1) % profiles.length];
            if (nextProfile?.paymentDetails) {
              this.log(`Task ${t.id}: Declined, retrying with next profile...`, "info");
              taskConfig.paymentDetails = { ...taskConfig.paymentDetails, ...nextProfile.paymentDetails };
              result = await t.instance.runFromPreCheckout(taskConfig);
            }
          }

          if (result.success && !this.winnerFound) {
            this.winnerFound = true;
            this.log(`TASK ${t.id} WON! ${result.elapsed}s`, "success");
            resolve({ taskId: t.id, ...result, winner: true });
            return;
          }
          resolve({ taskId: t.id, ...result });
        } catch (err) {
          resolve({ taskId: t.id, success: false, error: err.message });
        }
      });
    });

    const results = await Promise.all(taskPromises);
    this.running = false;

    const winner = results.find(r => r.winner);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    if (winner) {
      return { success: true, winner: winner.taskId, elapsed, mode: "pre-warmed", taskCount: this.tasks.length, results, logs: winner.logs || [], dryRun: winner.dryRun, step: "complete" };
    }

    return { success: false, elapsed, mode: "pre-warmed", taskCount: this.tasks.length, results, logs: results.flatMap(r => r.logs || []), step: "all-failed" };
  }

  stop() {
    this.winnerFound = true;
    this.running = false;
    this.log("All tasks stopped.");
    this.emit("stopped");
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { TaskRunner };
