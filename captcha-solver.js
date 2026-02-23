const fetch = require("node-fetch");

/**
 * CaptchaSolver Pro — Universal multi-provider CAPTCHA solving engine.
 * Ported from PeterC02/Captcha-Verification with full feature parity.
 *
 * Supports:
 *   - 3 API providers: 2Captcha, Anti-Captcha, CapSolver (with automatic fallback)
 *   - Local OCR via Tesseract.js (free, no API key needed for image CAPTCHAs)
 *   - reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, FunCaptcha/Arkose, Slider, Image
 *   - reCAPTCHA checkbox auto-click (free, no API)
 *   - Turnstile stealth auto-pass detection
 *   - Human-like mouse movement, typing, and drag for slider CAPTCHAs
 *   - Comprehensive page-level CAPTCHA detection script
 *   - Deep token injection with callback triggering
 *   - SPA mutation observer for dynamically loaded CAPTCHAs
 *   - Multi-retry with provider failover
 */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════
// 2CAPTCHA API
// ═══════════════════════════════════════════════════════════════
async function api2c(key, params, logFn, pollInterval = 3000, maxPolls = 40) {
  params.key = key; params.json = "1";
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, v);
  logFn("2Captcha: submitting...", "info");
  const sub = await fetch("https://2captcha.com/in.php", { method: "POST", body });
  const sj = await sub.json();
  if (sj.status !== 1) throw new Error("2Captcha submit: " + sj.request);
  const tid = sj.request;
  logFn(`2Captcha task: ${tid}`, "info");
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollInterval);
    if (i % 5 === 0) logFn(`2Captcha polling (${i + 1}/${maxPolls})...`, "info");
    const res = await fetch(`https://2captcha.com/res.php?key=${key}&action=get&id=${tid}&json=1`);
    const rj = await res.json();
    if (rj.status === 1) { logFn("2Captcha solved!", "success"); return rj.request; }
    if (rj.request !== "CAPCHA_NOT_READY") throw new Error("2Captcha: " + rj.request);
  }
  throw new Error("2Captcha timeout");
}

// ═══════════════════════════════════════════════════════════════
// ANTI-CAPTCHA API
// ═══════════════════════════════════════════════════════════════
async function apiAc(key, task, logFn, pollInterval = 3000, maxPolls = 40) {
  logFn(`Anti-Captcha: submitting (${task.type})...`, "info");
  const sub = await fetch("https://api.anti-captcha.com/createTask", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: key, task }),
  });
  const sj = await sub.json();
  if (sj.errorId !== 0) throw new Error("Anti-Captcha: " + sj.errorDescription);
  const tid = sj.taskId;
  logFn(`Anti-Captcha task: ${tid}`, "info");
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollInterval);
    if (i % 5 === 0) logFn(`Anti-Captcha polling (${i + 1}/${maxPolls})...`, "info");
    const res = await fetch("https://api.anti-captcha.com/getTaskResult", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: key, taskId: tid }),
    });
    const rj = await res.json();
    if (rj.errorId !== 0) throw new Error("Anti-Captcha: " + rj.errorDescription);
    if (rj.status === "ready") { logFn("Anti-Captcha solved!", "success"); return rj.solution; }
  }
  throw new Error("Anti-Captcha timeout");
}

// ═══════════════════════════════════════════════════════════════
// CAPSOLVER API
// ═══════════════════════════════════════════════════════════════
async function apiCs(key, task, logFn, maxPolls = 40) {
  logFn(`CapSolver: submitting (${task.type})...`, "info");
  const sub = await fetch("https://api.capsolver.com/createTask", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: key, task }),
  });
  const sj = await sub.json();
  if (sj.errorId && sj.errorId !== 0) throw new Error("CapSolver: " + (sj.errorDescription || sj.errorCode));
  if (sj.solution) { logFn("CapSolver solved instantly!", "success"); return sj.solution; }
  const tid = sj.taskId;
  if (!tid) throw new Error("CapSolver: no taskId returned");
  logFn(`CapSolver task: ${tid}`, "info");
  for (let i = 0; i < maxPolls; i++) {
    await sleep(3000);
    if (i % 5 === 0) logFn(`CapSolver polling (${i + 1}/${maxPolls})...`, "info");
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: key, taskId: tid }),
    });
    const rj = await res.json();
    if (rj.errorId && rj.errorId !== 0) throw new Error("CapSolver: " + (rj.errorDescription || rj.errorCode));
    if (rj.status === "ready") { logFn("CapSolver solved!", "success"); return rj.solution; }
  }
  throw new Error("CapSolver timeout");
}

// ═══════════════════════════════════════════════════════════════
// UNIVERSAL API SOLVER — tries all available providers in order
// ═══════════════════════════════════════════════════════════════
async function solveViaAPI(type, params, keys, logFn) {
  const { k2c, kAc, kCs } = keys;
  const errors = [];
  const providers = [];
  if (k2c) providers.push({ name: "2Captcha", key: k2c, p: "2c" });
  if (kAc) providers.push({ name: "Anti-Captcha", key: kAc, p: "ac" });
  if (kCs) providers.push({ name: "CapSolver", key: kCs, p: "cs" });
  if (!providers.length) throw new Error("No API keys configured.");

  for (const prov of providers) {
    try {
      logFn(`Trying ${prov.name}...`, "info");
      if (type === "image") {
        if (prov.p === "2c") return await api2c(prov.key, { method: "base64", body: params.base64 }, logFn);
        if (prov.p === "ac") { const s = await apiAc(prov.key, { type: "ImageToTextTask", body: params.base64, case: true }, logFn); return s.text; }
        if (prov.p === "cs") { const s = await apiCs(prov.key, { type: "ImageToTextTask", body: params.base64 }, logFn); return s.text; }
      } else if (type === "recaptchav2") {
        if (prov.p === "2c") return await api2c(prov.key, { method: "userrecaptcha", googlekey: params.sitekey, pageurl: params.pageurl }, logFn, 5000, 60);
        if (prov.p === "ac") { const s = await apiAc(prov.key, { type: "RecaptchaV2TaskProxyless", websiteURL: params.pageurl, websiteKey: params.sitekey }, logFn, 5000, 60); return s.gRecaptchaResponse; }
        if (prov.p === "cs") { const s = await apiCs(prov.key, { type: "ReCaptchaV2TaskProxyLess", websiteURL: params.pageurl, websiteKey: params.sitekey }, logFn, 60); return s.gRecaptchaResponse; }
      } else if (type === "recaptchav3") {
        if (prov.p === "2c") return await api2c(prov.key, { method: "userrecaptcha", googlekey: params.sitekey, pageurl: params.pageurl, version: "v3", action: "verify", min_score: "0.3" }, logFn, 5000, 60);
        if (prov.p === "ac") { const s = await apiAc(prov.key, { type: "RecaptchaV3TaskProxyless", websiteURL: params.pageurl, websiteKey: params.sitekey, minScore: 0.3, pageAction: "verify" }, logFn, 5000, 60); return s.gRecaptchaResponse; }
        if (prov.p === "cs") { const s = await apiCs(prov.key, { type: "ReCaptchaV2TaskProxyLess", websiteURL: params.pageurl, websiteKey: params.sitekey }, logFn, 60); return s.gRecaptchaResponse; }
      } else if (type === "hcaptcha") {
        if (prov.p === "2c") return await api2c(prov.key, { method: "hcaptcha", sitekey: params.sitekey, pageurl: params.pageurl }, logFn, 5000, 60);
        if (prov.p === "ac") { const s = await apiAc(prov.key, { type: "HCaptchaTaskProxyless", websiteURL: params.pageurl, websiteKey: params.sitekey }, logFn, 5000, 60); return s.gRecaptchaResponse || s.token; }
        if (prov.p === "cs") { const s = await apiCs(prov.key, { type: "HCaptchaTaskProxyless", websiteURL: params.pageurl, websiteKey: params.sitekey }, logFn, 60); return s.gRecaptchaResponse || s.token; }
      } else if (type === "turnstile") {
        if (prov.p === "2c") return await api2c(prov.key, { method: "turnstile", sitekey: params.sitekey, pageurl: params.pageurl }, logFn, 5000, 60);
        if (prov.p === "ac") { const s = await apiAc(prov.key, { type: "TurnstileTaskProxyless", websiteURL: params.pageurl, websiteKey: params.sitekey }, logFn, 5000, 60); return s.token; }
        if (prov.p === "cs") { const s = await apiCs(prov.key, { type: "AntiTurnstileTaskProxyLess", websiteURL: params.pageurl, websiteKey: params.sitekey }, logFn, 60); return s.token; }
      } else if (type === "funcaptcha") {
        if (prov.p === "2c") return await api2c(prov.key, { method: "funcaptcha", publickey: params.publickey, pageurl: params.pageurl }, logFn, 5000, 60);
        if (prov.p === "ac") { const s = await apiAc(prov.key, { type: "FunCaptchaTaskProxyless", websiteURL: params.pageurl, websitePublicKey: params.publickey }, logFn, 5000, 60); return s.token; }
        if (prov.p === "cs") { const s = await apiCs(prov.key, { type: "FunCaptchaTaskProxyLess", websiteURL: params.pageurl, websitePublicKey: params.publickey }, logFn, 60); return s.token; }
      }
    } catch (e) {
      logFn(`${prov.name} failed: ${e.message}`, "error");
      errors.push(`${prov.name}: ${e.message}`);
    }
  }
  throw new Error("All API providers failed: " + errors.join("; "));
}

// ═══════════════════════════════════════════════════════════════
// COMPREHENSIVE CAPTCHA DETECTION SCRIPT (injected into page)
// Ported from Captcha-Verification repo
// ═══════════════════════════════════════════════════════════════
const DETECT_SCRIPT = `() => {
  const R = { type: null, sitekey: null, details: {}, sliderInfo: null };
  // reCAPTCHA
  const rcD = document.querySelector('.g-recaptcha, [data-sitekey], #g-recaptcha');
  const rcI = document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"]');
  if (rcD || rcI) {
    R.type = 'recaptcha'; R.sitekey = rcD?.getAttribute('data-sitekey') || '';
    R.details.version = document.querySelector('script[src*="recaptcha/api.js?render="]') ? 'v3' : 'v2';
    const cbIframe = document.querySelector('iframe[src*="recaptcha/api2/anchor"]');
    if (cbIframe) R.details.checkboxIframe = true;
    return R;
  }
  // hCaptcha
  const hcD = document.querySelector('.h-captcha, [data-sitekey][class*="hcaptcha"]');
  const hcI = document.querySelector('iframe[src*="hcaptcha"]');
  if (hcD || hcI) {
    R.type = 'hcaptcha'; R.sitekey = hcD?.getAttribute('data-sitekey') || '';
    if (!R.sitekey && hcI) { const m = hcI.src.match(/sitekey=([^&]+)/); if (m) R.sitekey = m[1]; }
    return R;
  }
  // Turnstile
  const cfD = document.querySelector('.cf-turnstile');
  const cfI = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
  if (cfI || cfD) { R.type = 'turnstile'; R.sitekey = cfD?.getAttribute('data-sitekey') || ''; return R; }
  // FunCaptcha / Arkose Labs
  const fcI = document.querySelector('iframe[src*="funcaptcha"], iframe[src*="arkoselabs"]');
  const fcD = document.querySelector('[data-pkey], #FunCaptcha, .funcaptcha');
  if (fcI || fcD) {
    R.type = 'funcaptcha'; R.sitekey = fcD?.getAttribute('data-pkey') || '';
    if (!R.sitekey && fcI) { const m = fcI.src.match(/pk=([^&]+)/); if (m) R.sitekey = m[1]; }
    return R;
  }
  // Slider
  const slSels = ['.slider-captcha','.slide-verify','.geetest_slider','#captcha-slider','[class*="slider"][class*="captcha"]','[class*="slide"][class*="verify"]','.nc_wrapper','.nc-container','#nc_1_wrapper','[class*="puzzle"]','[class*="jigsaw"]','.geetest_widget'];
  for (const s of slSels) {
    const el = document.querySelector(s);
    if (el) {
      R.type = 'slider';
      const handle = el.querySelector('[class*="handle"], [class*="btn"], [class*="drag"], [class*="slider-icon"]') || el.querySelector('span, div[draggable]');
      const track = el.querySelector('[class*="track"], [class*="bg"], [class*="bar"]');
      R.sliderInfo = { trackWidth: track ? track.getBoundingClientRect().width : 300 };
      return R;
    }
  }
  // PerimeterX / bot wall (Pokemon Center uses this)
  const pxMarkers = ['px-captcha', 'perimeterx', 'Pardon Our Interruption', 'Please verify you are a human', 'challenge-platform', 'Access Denied'];
  const bodyText = document.body?.innerText || '';
  const bodyHtml = document.body?.innerHTML || '';
  for (const m of pxMarkers) {
    if (bodyText.includes(m) || bodyHtml.includes(m)) {
      R.type = 'botwall'; R.details.marker = m; return R;
    }
  }
  // Image CAPTCHA (generic)
  const kw = ['captcha','CAPTCHA','security','verify','code','securimage','cap_img'];
  const imgs = document.querySelectorAll('img');
  for (const img of imgs) {
    const src=(img.src||'').toLowerCase(), alt=(img.alt||'').toLowerCase(), id=(img.id||'').toLowerCase(), cls=(img.className||'').toLowerCase();
    if (kw.some(k => { const kl=k.toLowerCase(); return src.includes(kl)||alt.includes(kl)||id.includes(kl)||cls.includes(kl); })) {
      R.type = 'image'; return R;
    }
  }
  return R;
}`;

// ═══════════════════════════════════════════════════════════════
// HUMAN-LIKE INPUT HELPERS
// ═══════════════════════════════════════════════════════════════
async function humanClick(page, selector) {
  const el = await page.$(selector);
  if (!el) return false;
  const box = await el.boundingBox();
  if (!box) return false;
  const x = box.x + box.width / 2 + (Math.random() - 0.5) * 4;
  const y = box.y + box.height / 2 + (Math.random() - 0.5) * 4;
  await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 8) });
  await sleep(40 + Math.random() * 120);
  await page.mouse.click(x, y);
  return true;
}

async function humanDrag(page, startX, startY, endX, endY) {
  await page.mouse.move(startX, startY, { steps: 5 });
  await sleep(80 + Math.random() * 150);
  await page.mouse.down();
  await sleep(40 + Math.random() * 80);
  const dist = endX - startX;
  const steps = 20 + Math.floor(Math.random() * 15);
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const eased = 1 - Math.pow(1 - p, 3);
    await page.mouse.move(startX + dist * eased, startY + (Math.random() - 0.5) * 3);
    await sleep(4 + Math.random() * 12);
  }
  await page.mouse.move(endX + 2 + Math.random() * 3, endY + (Math.random() - 0.5) * 2);
  await sleep(25 + Math.random() * 40);
  await page.mouse.move(endX, endY);
  await sleep(40 + Math.random() * 80);
  await page.mouse.up();
}

// ═══════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════
class CaptchaSolver {
  constructor(config = {}) {
    this.keys = {
      k2c: config.apiKey2c || config.apiKey || "",
      kAc: config.apiKeyAc || "",
      kCs: config.apiKeyCs || "",
    };
    // Legacy: if only provider + apiKey given, map to correct key
    if (config.provider && config.apiKey && !config.apiKey2c && !config.apiKeyAc && !config.apiKeyCs) {
      if (config.provider === "2captcha") this.keys.k2c = config.apiKey;
      else if (config.provider === "anticaptcha" || config.provider === "anti-captcha") this.keys.kAc = config.apiKey;
      else if (config.provider === "capsolver") this.keys.kCs = config.apiKey;
      else if (config.provider === "capmonster") this.keys.kAc = config.apiKey; // CapMonster uses Anti-Captcha compatible API
    }
    this.timeout = config.timeout || 120000;
    this.maxRetries = config.maxRetries || 3;
    this.logFn = config.logFn || ((msg, type) => console.log(`[CAPTCHA][${type}] ${msg}`));
  }

  log(msg, type = "info") { this.logFn(msg, type); }

  get provider() {
    if (this.keys.k2c) return "2Captcha";
    if (this.keys.kAc) return "Anti-Captcha";
    if (this.keys.kCs) return "CapSolver";
    return "none";
  }

  get isConfigured() {
    return !!(this.keys.k2c || this.keys.kAc || this.keys.kCs);
  }

  get hasAPI() {
    return this.isConfigured;
  }

  // ─── Detect CAPTCHA type on a Puppeteer page ───
  async detect(page) {
    try {
      return await page.evaluate(new Function("return (" + DETECT_SCRIPT + ")()"));
    } catch (e) {
      this.log(`Detection error: ${e.message}`, "error");
      return { type: null };
    }
  }

  // ─── Setup SPA mutation observer for dynamic CAPTCHAs ───
  async setupObserver(page) {
    await page.evaluate(() => {
      if (window.__csMO) return;
      window.__csNewCaptcha = false;
      const obs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const h = (n.outerHTML || "").toLowerCase();
          if (h.includes("captcha") || h.includes("recaptcha") || h.includes("hcaptcha") || h.includes("turnstile") || h.includes("funcaptcha") || h.includes("slider") || h.includes("geetest")) {
            window.__csNewCaptcha = true;
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      window.__csMO = obs;
    }).catch(() => {});
  }

  // ─── Try reCAPTCHA checkbox click (free, no API) ───
  async tryRecaptchaCheckbox(page) {
    this.log("Attempting reCAPTCHA checkbox click...", "info");
    try {
      const frames = page.frames();
      const anchorFrame = frames.find(f => f.url().includes("recaptcha/api2/anchor") || f.url().includes("recaptcha/enterprise/anchor"));
      if (!anchorFrame) return false;
      const checkbox = await anchorFrame.$("#recaptcha-anchor");
      if (!checkbox) return false;
      const box = await checkbox.boundingBox();
      if (!box) return false;
      await page.mouse.move(box.x + box.width / 2 + (Math.random() - 0.5) * 6, box.y + box.height / 2 + (Math.random() - 0.5) * 6, { steps: 8 + Math.floor(Math.random() * 5) });
      await sleep(100 + Math.random() * 300);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      this.log("Clicked reCAPTCHA checkbox, waiting...", "info");
      await sleep(3000 + Math.random() * 2000);
      const solved = await anchorFrame.evaluate(() => {
        const anchor = document.querySelector("#recaptcha-anchor");
        return anchor && anchor.getAttribute("aria-checked") === "true";
      });
      if (solved) { this.log("reCAPTCHA checkbox passed! No challenge needed.", "success"); return true; }
      const challengeFrame = frames.find(f => f.url().includes("recaptcha/api2/bframe") || f.url().includes("recaptcha/enterprise/bframe"));
      if (challengeFrame) this.log("Image challenge appeared — needs API.", "info");
      return false;
    } catch (e) {
      this.log(`Checkbox click error: ${e.message}`, "error");
      return false;
    }
  }

  // ─── Check Turnstile stealth auto-pass ───
  async checkTurnstileAutoPass(page) {
    this.log("Checking Turnstile auto-pass...", "info");
    await sleep(3000);
    const autoPass = await page.evaluate(() => {
      const resp = document.querySelector('[name="cf-turnstile-response"]');
      return resp && resp.value && resp.value.length > 10;
    });
    if (autoPass) { this.log("Turnstile auto-passed via stealth!", "success"); return true; }
    return false;
  }

  // ─── Inject solved token into page ───
  async injectToken(page, token, type) {
    this.log(`Injecting ${type} token...`, "info");
    await page.evaluate((tok, cType) => {
      if (cType === "recaptcha") {
        document.querySelectorAll('[name="g-recaptcha-response"], #g-recaptcha-response').forEach(el => { el.value = tok; el.style.display = "block"; });
        try {
          if (window.___grecaptcha_cfg?.clients) {
            for (const k in window.___grecaptcha_cfg.clients) {
              const find = (obj, depth) => { if (depth > 5) return null; for (const p in obj) { if (typeof obj[p] === "function" && p.length < 30) return obj[p]; if (typeof obj[p] === "object" && obj[p] && !Array.isArray(obj[p])) { const f = find(obj[p], depth + 1); if (f) return f; } } return null; };
              const cb = find(window.___grecaptcha_cfg.clients[k], 0);
              if (cb) cb(tok);
            }
          }
        } catch (e) {}
        try { if (window.captchaCallback) window.captchaCallback(tok); } catch (e) {}
        try { if (window.onRecaptchaSuccess) window.onRecaptchaSuccess(tok); } catch (e) {}
      } else if (cType === "hcaptcha") {
        document.querySelectorAll('[name="h-captcha-response"], [name="g-recaptcha-response"]').forEach(el => { el.value = tok; });
        try { if (window.hcaptcha) window.hcaptcha.execute(); } catch (e) {}
      } else if (cType === "turnstile") {
        document.querySelectorAll('[name="cf-turnstile-response"], [name="turnstile-response"]').forEach(el => { el.value = tok; });
        try { const cb = document.querySelector(".cf-turnstile")?.getAttribute("data-callback"); if (cb && window[cb]) window[cb](tok); } catch (e) {}
      } else if (cType === "funcaptcha") {
        document.querySelectorAll('[name="fc-token"], [name="FunCaptcha"]').forEach(el => { el.value = tok; });
      }
    }, token, type);
    this.log("Token injected.", "success");
  }

  // ─── Solve slider CAPTCHA with human-like drag ───
  async solveSlider(page, sliderInfo) {
    this.log("Solving slider CAPTCHA...", "info");
    const sliderSels = ['.slider-captcha [class*="handle"]', '.slide-verify [class*="handle"]', '.geetest_slider [class*="btn"]', '#captcha-slider [class*="handle"]', '[class*="slider"][class*="captcha"] [class*="handle"]', '[class*="slide"][class*="verify"] [class*="handle"]'];
    let handle = null;
    for (const sel of sliderSels) {
      handle = await page.$(sel);
      if (handle) break;
    }
    if (!handle) { this.log("No slider handle found.", "error"); return false; }
    const hBox = await handle.boundingBox();
    if (!hBox) return false;
    const tw = sliderInfo?.trackWidth || 300;
    const positions = [0.72, 0.48, 0.63, 0.82, 0.38, 0.55, 0.75, 0.45, 0.68, 0.58];
    for (let a = 0; a < positions.length; a++) {
      const dist = Math.round(tw * positions[a]);
      this.log(`Slider attempt ${a + 1}/${positions.length}: ${Math.round(positions[a] * 100)}%`, "info");
      const sx = hBox.x + hBox.width / 2, sy = hBox.y + hBox.height / 2;
      await humanDrag(page, sx, sy, sx + dist, sy);
      await sleep(1500 + Math.random() * 1000);
      const state = await page.evaluate(() => {
        if (document.querySelector('.geetest_success, .slider-success, [class*="success"], [class*="passed"]')) return "ok";
        if (document.querySelector('.geetest_fail, .slider-fail, [class*="fail"], [class*="error"]')) return "fail";
        return "?";
      });
      if (state === "ok") { this.log(`Slider solved on attempt ${a + 1}!`, "success"); return true; }
      if (state === "fail") await sleep(500 + Math.random() * 500);
    }
    this.log("Slider: all attempts exhausted.", "error");
    return false;
  }

  // ─── Local OCR via Tesseract.js (free, no API key) ───
  async localOCR(imageBuffer) {
    try {
      const Tesseract = require("tesseract.js");
      this.log("Running local OCR (Tesseract.js)...", "info");
      const worker = await Tesseract.createWorker("eng");
      await worker.setParameters({ tessedit_pageseg_mode: "7" });
      const { data } = await worker.recognize(imageBuffer);
      await worker.terminate();
      const text = (data.text || "").replace(/[\n\r]/g, "").trim();
      const confidence = Math.round(data.confidence);
      this.log(`OCR result: "${text}" (${confidence}%)`, confidence > 50 ? "success" : "info");
      // Check for math CAPTCHA
      const mathResult = this._solveMath(text);
      if (mathResult) {
        this.log(`Math CAPTCHA: ${mathResult.expression} = ${mathResult.answer}`, "success");
        return { text: mathResult.answer, confidence: 95, method: "Local OCR + Math" };
      }
      return { text, confidence, method: "Local OCR (Tesseract)" };
    } catch (e) {
      this.log(`Local OCR unavailable: ${e.message}`, "info");
      return null;
    }
  }

  _solveMath(text) {
    let c = text.replace(/\s+/g, " ").trim().replace(/[xX\u00d7]/g, "*").replace(/[\u00f7]/g, "/").replace(/[\u2014\u2013]/g, "-").replace(/[=?]+\s*$/, "").trim();
    const expr = c.replace(/[^0-9+\-*/().]/g, "");
    if (expr && /^\d/.test(expr) && /\d$/.test(expr) && /[+\-*/]/.test(expr)) {
      try {
        const r = Function('"use strict";return (' + expr + ")")();
        if (typeof r === "number" && isFinite(r)) return { expression: c, answer: String(Math.round(r * 100) / 100) };
      } catch (e) {}
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN: Detect and solve any CAPTCHA on a Puppeteer page
  // ═══════════════════════════════════════════════════════════════
  async detectAndSolve(page) {
    const detection = await this.detect(page);
    if (!detection.type) return false;

    const pageUrl = page.url();
    this.log(`Detected: ${detection.type}${detection.sitekey ? " (key: " + detection.sitekey.substring(0, 20) + "...)" : ""}`, "info");

    // Setup observer for SPA pages
    await this.setupObserver(page);

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // ── reCAPTCHA ──
        if (detection.type === "recaptcha") {
          // Step 1: Try free checkbox click
          const checkboxSolved = await this.tryRecaptchaCheckbox(page);
          if (checkboxSolved) return true;
          // Step 2: API solve
          if (!this.hasAPI) { this.log("reCAPTCHA needs API key to solve image challenge.", "error"); return false; }
          const rcType = detection.details?.version === "v3" ? "recaptchav3" : "recaptchav2";
          const token = await solveViaAPI(rcType, { sitekey: detection.sitekey, pageurl: pageUrl }, this.keys, (m, t) => this.log(m, t));
          if (token) { await this.injectToken(page, token, "recaptcha"); return true; }
        }

        // ── hCaptcha ──
        else if (detection.type === "hcaptcha") {
          if (!this.hasAPI) { this.log("hCaptcha requires API key.", "error"); return false; }
          const token = await solveViaAPI("hcaptcha", { sitekey: detection.sitekey, pageurl: pageUrl }, this.keys, (m, t) => this.log(m, t));
          if (token) { await this.injectToken(page, token, "hcaptcha"); return true; }
        }

        // ── Turnstile ──
        else if (detection.type === "turnstile") {
          // Step 1: Check stealth auto-pass
          const autoPass = await this.checkTurnstileAutoPass(page);
          if (autoPass) return true;
          // Step 2: API
          if (!this.hasAPI) { this.log("Turnstile did not auto-pass. API key required.", "error"); return false; }
          const token = await solveViaAPI("turnstile", { sitekey: detection.sitekey, pageurl: pageUrl }, this.keys, (m, t) => this.log(m, t));
          if (token) { await this.injectToken(page, token, "turnstile"); return true; }
        }

        // ── FunCaptcha ──
        else if (detection.type === "funcaptcha") {
          if (!this.hasAPI) { this.log("FunCaptcha requires API key.", "error"); return false; }
          const token = await solveViaAPI("funcaptcha", { publickey: detection.sitekey, pageurl: pageUrl }, this.keys, (m, t) => this.log(m, t));
          if (token) { await this.injectToken(page, token, "funcaptcha"); return true; }
        }

        // ── Slider ──
        else if (detection.type === "slider") {
          const solved = await this.solveSlider(page, detection.sliderInfo);
          if (solved) return true;
          if (attempt < this.maxRetries) { await sleep(1000); continue; }
        }

        // ── Image CAPTCHA ──
        else if (detection.type === "image" || detection.type === "image_guess") {
          // Step 1: Try local OCR (free)
          const ocrResult = await this.localOCR(await page.screenshot({ type: "png" }));
          if (ocrResult && ocrResult.confidence >= 65) {
            this.log(`Local OCR confident: "${ocrResult.text}"`, "success");
            return true; // Caller should handle filling the result
          }
          // Step 2: Escalate to API
          if (this.hasAPI) {
            const ss = await page.screenshot({ encoding: "base64", type: "png" });
            try {
              const apiText = await solveViaAPI("image", { base64: ss }, this.keys, (m, t) => this.log(m, t));
              if (apiText) { this.log(`API solved image: "${apiText}"`, "success"); return true; }
            } catch (e) { this.log(`API image solve failed: ${e.message}`, "error"); }
          }
        }

        // ── Bot wall (PerimeterX etc) ──
        else if (detection.type === "botwall") {
          this.log(`Bot protection wall detected: ${detection.details?.marker}. Waiting for challenge to resolve...`, "info");
          for (let w = 0; w < 9; w++) {
            await sleep(5000);
            const recheck = await this.detect(page);
            if (!recheck.type || recheck.type !== "botwall") {
              this.log("Bot wall resolved!", "success");
              return true;
            }
          }
          this.log("Bot wall did not resolve after 45s.", "error");
          return false;
        }

        return false;
      } catch (err) {
        this.log(`Attempt ${attempt}/${this.maxRetries} error: ${err.message}`, "error");
        if (attempt === this.maxRetries) return false;
        await sleep(1000);
      }
    }
    return false;
  }
}

module.exports = { CaptchaSolver };
