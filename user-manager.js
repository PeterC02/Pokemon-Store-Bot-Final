const fs = require("fs");
const path = require("path");

/**
 * UserManager — Manages up to 50 user profiles for fleet checkout.
 * Each user has: name, shipping address, payment card details, and metadata.
 * Persisted to disk as JSON. Designed for the Fleet Runner.
 */
const USERS_PATH = path.join(__dirname, "users.json");
const MAX_USERS = 50;

// Map common country names to Shopify-compatible ISO codes
const COUNTRY_MAP = {
  'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB', 'england': 'GB',
  'united states': 'US', 'usa': 'US', 'us': 'US', 'america': 'US',
  'canada': 'CA', 'australia': 'AU', 'ireland': 'IE', 'germany': 'DE',
  'france': 'FR', 'japan': 'JP', 'netherlands': 'NL', 'new zealand': 'NZ',
};
function normalizeCountry(c) {
  if (!c) return 'GB';
  const lower = c.trim().toLowerCase();
  return COUNTRY_MAP[lower] || (c.length === 2 ? c.toUpperCase() : c);
}

class UserManager {
  constructor() {
    this.users = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(USERS_PATH)) {
        return JSON.parse(fs.readFileSync(USERS_PATH, "utf-8"));
      }
    } catch (_) {}
    return [];
  }

  _save() {
    fs.writeFileSync(USERS_PATH, JSON.stringify(this.users, null, 2));
  }

  getAll() {
    return this.users;
  }

  getById(id) {
    return this.users.find((u) => u.id === id) || null;
  }

  getByIds(ids) {
    return ids.map((id) => this.users.find((u) => u.id === id)).filter(Boolean);
  }

  add(user) {
    if (this.users.length >= MAX_USERS) {
      throw new Error(`Maximum ${MAX_USERS} users reached.`);
    }
    // Validate required fields
    if (!user.name || !user.name.trim()) {
      throw new Error("User name is required.");
    }
    user.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    user.createdAt = new Date().toISOString();
    user.enabled = user.enabled !== false;
    // Ensure nested objects exist
    user.shipping = user.shipping || {};
    user.payment = user.payment || {};
    this.users.push(user);
    this._save();
    return user;
  }

  addBulk(usersArray) {
    const added = [];
    for (const u of usersArray) {
      if (this.users.length >= MAX_USERS) break;
      try {
        added.push(this.add(u));
      } catch (_) {}
    }
    return added;
  }

  update(id, data) {
    const idx = this.users.findIndex((u) => u.id === id);
    if (idx === -1) throw new Error("User not found.");
    // Deep merge shipping and payment
    const existing = this.users[idx];
    if (data.shipping) data.shipping = { ...existing.shipping, ...data.shipping };
    if (data.payment) data.payment = { ...existing.payment, ...data.payment };
    this.users[idx] = { ...existing, ...data, id, updatedAt: new Date().toISOString() };
    this._save();
    return this.users[idx];
  }

  remove(id) {
    const idx = this.users.findIndex((u) => u.id === id);
    if (idx === -1) throw new Error("User not found.");
    this.users.splice(idx, 1);
    this._save();
  }

  removeAll() {
    this.users = [];
    this._save();
  }

  toggleEnabled(id) {
    const user = this.getById(id);
    if (!user) throw new Error("User not found.");
    user.enabled = !user.enabled;
    this._save();
    return user;
  }

  getEnabled() {
    return this.users.filter((u) => u.enabled !== false);
  }

  count() {
    return this.users.length;
  }

  // Convert user to checkout-ready config
  toCheckoutConfig(user) {
    return {
      checkoutDetails: {
        email: user.shipping?.email || "",
        firstName: user.shipping?.firstName || "",
        lastName: user.shipping?.lastName || "",
        address: user.shipping?.address || "",
        address2: user.shipping?.address2 || "",
        city: user.shipping?.city || "",
        county: user.shipping?.county || "",
        state: user.shipping?.county || user.shipping?.state || "",
        zip: user.shipping?.zip || "",
        country: normalizeCountry(user.shipping?.country),
        phone: user.shipping?.phone || "",
      },
      paymentDetails: {
        cardNumber: user.payment?.cardNumber || "",
        cardName: user.payment?.cardName || "",
        expiryMonth: user.payment?.expiryMonth || "",
        expiryYear: user.payment?.expiryYear || "",
        cvv: user.payment?.cvv || "",
      },
    };
  }
}

module.exports = { UserManager };
