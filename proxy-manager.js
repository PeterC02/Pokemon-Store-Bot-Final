/**
 * ProxyManager — Rotating proxy support for both browser and API modes.
 * 
 * Accepts proxies in formats:
 *   - host:port
 *   - host:port:user:pass
 *   - http://user:pass@host:port
 *   - socks5://user:pass@host:port
 * 
 * Rotation strategies: round-robin, random, sticky (per-domain).
 */
class ProxyManager {
  constructor(proxyList = [], strategy = "round-robin") {
    this.proxies = this.parseProxies(proxyList);
    this.strategy = strategy;
    this.index = 0;
    this.stickyMap = new Map();
    this.failures = new Map();
  }

  parseProxies(list) {
    if (!list || list.length === 0) return [];
    return list.map((p) => this.parseProxy(p)).filter(Boolean);
  }

  parseProxy(raw) {
    if (!raw || !raw.trim()) return null;
    raw = raw.trim();

    // Format: http://user:pass@host:port or socks5://user:pass@host:port
    const urlMatch = raw.match(/^(https?|socks[45]):\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/i);
    if (urlMatch) {
      return {
        protocol: urlMatch[1].toLowerCase(),
        host: urlMatch[4],
        port: parseInt(urlMatch[5]),
        username: urlMatch[2] || null,
        password: urlMatch[3] || null,
        raw,
      };
    }

    // Format: host:port:user:pass
    const parts = raw.split(":");
    if (parts.length === 4) {
      return {
        protocol: "http",
        host: parts[0],
        port: parseInt(parts[1]),
        username: parts[2],
        password: parts[3],
        raw,
      };
    }

    // Format: host:port
    if (parts.length === 2) {
      return {
        protocol: "http",
        host: parts[0],
        port: parseInt(parts[1]),
        username: null,
        password: null,
        raw,
      };
    }

    return null;
  }

  get count() {
    return this.proxies.length;
  }

  get hasProxies() {
    return this.proxies.length > 0;
  }

  // Get next proxy based on strategy
  getNext(domain = null) {
    if (this.proxies.length === 0) return null;

    // Filter out proxies with too many failures
    const available = this.proxies.filter((p) => {
      const fails = this.failures.get(p.raw) || 0;
      return fails < 5;
    });

    if (available.length === 0) {
      // Reset failures and try again
      this.failures.clear();
      return this.proxies[0];
    }

    let proxy;
    switch (this.strategy) {
      case "sticky":
        if (domain && this.stickyMap.has(domain)) {
          proxy = this.stickyMap.get(domain);
          if (available.includes(proxy)) return proxy;
        }
        proxy = available[this.index % available.length];
        this.index++;
        if (domain) this.stickyMap.set(domain, proxy);
        return proxy;

      case "random":
        proxy = available[Math.floor(Math.random() * available.length)];
        return proxy;

      case "round-robin":
      default:
        proxy = available[this.index % available.length];
        this.index++;
        return proxy;
    }
  }

  // Mark a proxy as failed
  markFailed(proxy) {
    if (!proxy) return;
    const fails = this.failures.get(proxy.raw) || 0;
    this.failures.set(proxy.raw, fails + 1);
  }

  // Format proxy for Puppeteer --proxy-server arg
  toPuppeteerArg(proxy) {
    if (!proxy) return null;
    return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
  }

  // Format proxy for node-fetch agent (HTTP)
  toFetchAgent(proxy) {
    if (!proxy) return null;
    try {
      const HttpsProxyAgent = require("https-proxy-agent");
      const url = proxy.username
        ? `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`
        : `http://${proxy.host}:${proxy.port}`;
      return new HttpsProxyAgent(url);
    } catch (_) {
      return null;
    }
  }

  // Get auth credentials for Puppeteer page.authenticate()
  getAuth(proxy) {
    if (!proxy || !proxy.username) return null;
    return { username: proxy.username, password: proxy.password };
  }
}

module.exports = { ProxyManager };
