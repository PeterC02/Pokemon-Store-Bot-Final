# Canary by Heuricity

Your early warning system for Pokemon Center drops. Real-time detection, predictions, and alerts.

## Products

### Tier 1 — Discord Bot (£10/mo)
Real-time alerts, drop predictions, and product tracking in your Discord server.

### Tier 2 — Desktop Bot (£50 one-time)  
Everything in Tier 1 + auto-queue entry with embedded browser panels, proxy support, and Imperva bypass.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Detection Server (FastAPI + Python)        │
│  ├─ Homepage monitor (5s poll)              │
│  ├─ Sitemap diff (60s poll)                 │
│  ├─ Product catalog API (2min poll)         │
│  ├─ Drop prediction engine                  │
│  ├─ Drop event tracker                      │
│  └─ REST API + WebSocket push               │
├─────────────────────────────────────────────┤
│  Discord Bot (discord.py)                   │
│  ├─ /status  — current site state           │
│  ├─ /predict — next drop prediction         │
│  ├─ /drops   — drop history                 │
│  ├─ /products — detected products           │
│  ├─ /signals — recent detection signals     │
│  └─ Auto-post alerts to channel             │
├─────────────────────────────────────────────┤
│  Electron Desktop App                       │
│  ├─ Live signal dashboard                   │
│  ├─ Embedded browser panels (multi-profile) │
│  ├─ Imperva reese84 auto-solve (CapSolver)  │
│  └─ Auto-navigate after queue               │
└─────────────────────────────────────────────┘
```

## Quick Start

### 1. Detection Server

```bash
cd pkc-tool/server
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # Edit with your keys
python main.py
```

Server starts at `http://localhost:8000`. Admin password printed on first run — **save it**.

### 2. Discord Bot

1. Create a bot at [Discord Developer Portal](https://discord.com/developers/applications)
2. Enable `Message Content` intent
3. Invite bot to your server with `applications.commands` + `bot` scopes
4. Set `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` in `.env`
5. Run: `python discord_bot.py`

### 3. Desktop App (Tier 2)

```bash
cd pkc-tool/app
npm install
npm run dev
```

Login with server URL + credentials. Create profiles, launch browser panels.

### 4. Deploy to Railway

```bash
cd pkc-tool/server
railway deploy
```

Set env vars in Railway dashboard (see `.env.example`).

## Detection Signals

| Signal | Source | Alert Level |
|--------|--------|-------------|
| Queue is LIVE | Homepage monitor | 🔴 Critical |
| Challenge gate active | Homepage monitor | 🟡 Warning |
| New products in sitemap | Sitemap diff | 🟡 Warning |
| New products in catalog | Search API | 🟡 Warning |
| Build ID changed | Homepage monitor | 🟡 Warning |
| Price change | Search API | ℹ️ Info |
| Product restock | Search API | 🟡 Warning |
| Site back to normal | Homepage monitor | 🟢 Info |

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/api/auth/login` | POST | No | Login |
| `/api/auth/register` | POST | No | Register (invite code) |
| `/api/status` | GET | Yes | Current site status |
| `/api/signals` | GET | Yes | Detection signal history |
| `/api/products` | GET | Yes | Detected products |
| `/api/drops` | GET | Yes | Drop event history |
| `/api/prediction` | GET | Yes | Next drop prediction |
| `/api/invites` | POST | Admin | Create invite code |
| `/api/clients` | GET | Admin | Connected WebSocket clients |
| `/ws?token=` | WS | Yes | Real-time signal stream |

## Tech Stack

| Component | Tech |
|-----------|------|
| Server | FastAPI, httpx, aiosqlite, Python 3.12+ |
| Discord Bot | discord.py 2.4 |
| Desktop App | Electron 33, TypeScript, React, Tailwind CSS |
| Detection | Homepage fingerprint, sitemap diff, search API polling |
| Prediction | Historical pattern analysis with Bayesian priors |
| Captcha | CapSolver (reese84), manual (hCaptcha) |
| Real-time | WebSocket push |
| Deployment | Docker, Railway |
