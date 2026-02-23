const fs = require("fs");
const path = require("path");

/**
 * ProfileManager — Stores up to 50 user checkout profiles.
 * Each profile contains shipping details, payment details, and preferences.
 * Persisted to disk as JSON.
 */
const PROFILES_PATH = path.join(__dirname, "profiles.json");
const MAX_PROFILES = 50;

class ProfileManager {
  constructor() {
    this.profiles = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(PROFILES_PATH)) {
        return JSON.parse(fs.readFileSync(PROFILES_PATH, "utf-8"));
      }
    } catch (_) {}
    return [];
  }

  _save() {
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(this.profiles, null, 2));
  }

  getAll() {
    return this.profiles;
  }

  getById(id) {
    return this.profiles.find((p) => p.id === id) || null;
  }

  add(profile) {
    if (this.profiles.length >= MAX_PROFILES) {
      throw new Error(`Maximum ${MAX_PROFILES} profiles reached.`);
    }
    profile.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    profile.createdAt = new Date().toISOString();
    this.profiles.push(profile);
    this._save();
    return profile;
  }

  update(id, data) {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error("Profile not found.");
    this.profiles[idx] = { ...this.profiles[idx], ...data, id, updatedAt: new Date().toISOString() };
    this._save();
    return this.profiles[idx];
  }

  remove(id) {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error("Profile not found.");
    this.profiles.splice(idx, 1);
    this._save();
  }

  removeAll() {
    this.profiles = [];
    this._save();
  }
}

module.exports = { ProfileManager };
