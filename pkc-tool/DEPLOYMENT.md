# Canary by Heuricity — Production Deployment Guide

Complete guide to go from code to a shipped, revenue-generating product.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Repository Cleanup](#2-repository-cleanup)
3. [External Account Setup](#3-external-account-setup)
4. [Discord Application Setup](#4-discord-application-setup)
5. [Stripe Setup](#5-stripe-setup)
6. [Deploy the Detection Server](#6-deploy-the-detection-server)
7. [Deploy the Website](#7-deploy-the-website)
8. [DNS & Domain Setup](#8-dns--domain-setup)
9. [Wire Stripe Webhooks](#9-wire-stripe-webhooks)
10. [Discord Bot Go-Live](#10-discord-bot-go-live)
11. [Create Your First Partner](#11-create-your-first-partner)
12. [End-to-End Smoke Test](#12-end-to-end-smoke-test)
13. [Post-Launch Checklist](#13-post-launch-checklist)
14. [Architecture Reference](#14-architecture-reference)

---

## 1. Prerequisites

You need:

- **Node.js 18+** (for the website build)
- **Python 3.11+** (for the server)
- **Git** (to push code)
- A **domain name** (guide assumes `canary.heuricity.com`)
- A **credit/debit card** for Stripe and hosting

Accounts you'll create in this guide:

| Service | Purpose | Cost |
|---------|---------|------|
| [Railway](https://railway.app) or [Fly.io](https://fly.io) | Host the detection server + Discord bot | ~£5–15/mo |
| [Vercel](https://vercel.com) | Host the Next.js website | Free tier |
| [Stripe](https://stripe.com) | Payment processing | 1.4% + 20p per transaction |
| [Discord Developer Portal](https://discord.com/developers) | Bot + OAuth application | Free |
| [Cloudflare](https://cloudflare.com) (optional) | DNS + CDN | Free tier |

---

## 2. Repository Cleanup

Everything lives inside `pkc-tool/`. The rest of the repo is old experiments.

```bash
# From the repo root, move pkc-tool contents to root (or create a fresh repo)
# Option A: Fresh repo (recommended)
mkdir canary && cd canary
cp -r ../Pokemon-Store-Bot-Final/pkc-tool/* .
cp -r ../Pokemon-Store-Bot-Final/pkc-tool/.gitignore .
git init
git add .
git commit -m "Initial commit: Canary by Heuricity"

# Option B: Clean existing repo
cd Pokemon-Store-Bot-Final
# Delete everything except pkc-tool/ and .git/
# Then move pkc-tool/* to root
```

Final structure should be:

```
canary/
├── .gitignore
├── README.md
├── DEPLOYMENT.md
├── server/          ← FastAPI detection server + Discord bot
│   ├── main.py
│   ├── config.py
│   ├── db.py
│   ├── discord_bot.py
│   ├── llm_service.py
│   ├── models.py
│   ├── requirements.txt
│   ├── .env.example
│   └── detection/
│       ├── engine.py
│       ├── homepage.py
│       ├── sitemap.py
│       ├── catalog.py
│       ├── social.py
│       ├── predictor.py
│       └── formatter.py
├── app/             ← Electron desktop app (Phase 5 — later)
└── web/             ← Next.js website
    ├── package.json
    ├── src/app/
    │   ├── page.tsx           (landing page)
    │   ├── subscribe/
    │   │   ├── page.tsx       (subscribe flow)
    │   │   └── success/page.tsx
    │   └── partners/
    │       ├── page.tsx       (partner dashboard)
    │       └── apply/page.tsx (partner application)
    └── .env.local
```

---

## 3. External Account Setup

### 3a. Generate Secrets

Run this locally to generate your JWT secret:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Save the output — you'll need it in Step 6.

---

## 4. Discord Application Setup

### 4a. Create the Application

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it **Canary**
3. Go to **General Information** → note the **Application ID** (this is `DISCORD_CLIENT_ID`)
4. Go to **OAuth2** → note the **Client Secret** (this is `DISCORD_CLIENT_SECRET`)

### 4b. Create the Bot

1. Go to **Bot** tab → click **Add Bot**
2. Copy the **Token** (this is `DISCORD_BOT_TOKEN`)
3. Under **Privileged Gateway Intents**, enable:
   - ✅ **Server Members Intent** (needed for role management)
   - ✅ **Message Content Intent**
4. Under **Bot Permissions**, select:
   - Manage Roles
   - Send Messages
   - Embed Links
   - Use Slash Commands

### 4c. Configure OAuth2

1. Go to **OAuth2** → **Redirects**
2. Add: `https://api.canary.heuricity.com/api/auth/discord/callback`
   - (Replace with your actual server domain)
   - For local testing also add: `http://localhost:8000/api/auth/discord/callback`
3. Save

### 4d. Generate Bot Invite URL

In **OAuth2** → **URL Generator**:
- Scopes: `bot`, `applications.commands`
- Permissions: Manage Roles, Send Messages, Embed Links, Use Slash Commands

Save this URL — you'll give it to partners to invite the bot.

---

## 5. Stripe Setup

### 5a. Create Account

1. Go to https://dashboard.stripe.com/register
2. Complete business verification (required for live payments)
3. Set your **country to UK** and **currency to GBP**

### 5b. Get API Keys

1. Go to **Developers** → **API keys**
2. Copy the **Secret key** (starts with `sk_live_...`) → this is `STRIPE_SECRET_KEY`
3. ⚠️ Use **live keys**, not test keys, when you're ready for real payments
4. For testing first, use `sk_test_...` keys

### 5c. Create Webhook (do this AFTER deploying the server in Step 6)

We'll come back to this in [Step 9](#9-wire-stripe-webhooks).

---

## 6. Deploy the Detection Server

The server runs: FastAPI API + detection engine + Discord bot (all in one process).

### Option A: Railway (Recommended — simplest)

#### 6a-1. Create Railway Project

1. Go to https://railway.app → New Project → Deploy from GitHub Repo
2. Connect your repo, select the `server/` directory as root
3. Railway will auto-detect Python

#### 6a-2. Add a Procfile

Create `server/Procfile`:

```
web: python -m uvicorn main:app --host 0.0.0.0 --port $PORT
```

#### 6a-3. Add a runtime.txt

Create `server/runtime.txt`:

```
python-3.13.3
```

#### 6a-4. Set Environment Variables

In Railway dashboard → your service → **Variables**, add ALL of these:

```env
# REQUIRED
JWT_SECRET=<your-generated-secret-from-step-3a>
DISCORD_BOT_TOKEN=<from-step-4b>
DISCORD_CLIENT_ID=<from-step-4a>
DISCORD_CLIENT_SECRET=<from-step-4a>
DISCORD_REDIRECT_URI=https://api.canary.heuricity.com/api/auth/discord/callback
STRIPE_SECRET_KEY=<from-step-5b>
STRIPE_WEBHOOK_SECRET=<from-step-9-later>
CORS_ORIGINS=https://canary.heuricity.com,https://www.canary.heuricity.com

# OPTIONAL but recommended
DISCORD_WEBHOOK_URL=<webhook-url-for-engine-alerts>
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=<your-key>
```

#### 6a-5. Deploy

Railway will auto-deploy on push. Check logs to confirm:

```
INFO: Database initialised at /app/data/pkc.db
INFO: Detection engine starting
INFO: Application startup complete.
```

#### 6a-6. Note Your Server URL

Railway gives you a URL like `canary-server-production.up.railway.app`.
You'll point `api.canary.heuricity.com` here in Step 8.

### Option B: Fly.io

Create `server/fly.toml`:

```toml
app = "canary-server"
primary_region = "lhr"  # London

[build]
  builder = "paketobuildpacks/builder:base"

[env]
  PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
```

```bash
cd server
fly launch
fly secrets set JWT_SECRET=... DISCORD_BOT_TOKEN=... # etc
fly deploy
```

### Option C: VPS (DigitalOcean, Hetzner)

```bash
# On the server
sudo apt update && sudo apt install python3.11 python3.11-venv nginx certbot

# Clone and setup
git clone <your-repo> /opt/canary
cd /opt/canary/server
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Create .env file
cp .env.example .env
nano .env  # Fill in all values

# Create systemd service
sudo tee /etc/systemd/system/canary.service << 'EOF'
[Unit]
Description=Canary Detection Server
After=network.target

[Service]
User=www-data
WorkingDirectory=/opt/canary/server
EnvironmentFile=/opt/canary/server/.env
ExecStart=/opt/canary/server/venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable canary
sudo systemctl start canary

# Nginx reverse proxy
sudo tee /etc/nginx/sites-available/canary << 'EOF'
server {
    listen 80;
    server_name api.canary.heuricity.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/canary /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.canary.heuricity.com
```

---

## 7. Deploy the Website

### 7a. Vercel Deployment

1. Go to https://vercel.com → New Project → Import Git Repository
2. Set the **Root Directory** to `web/`
3. Framework: **Next.js** (auto-detected)

### 7b. Set Environment Variables

In Vercel → Project Settings → Environment Variables:

```
NEXT_PUBLIC_API_URL=https://api.canary.heuricity.com
```

### 7c. Deploy

Vercel auto-deploys on push. Your site will be at `your-project.vercel.app`.
You'll point `canary.heuricity.com` here in Step 8.

---

## 8. DNS & Domain Setup

You need two subdomains:

| Subdomain | Points To | Purpose |
|-----------|-----------|---------|
| `canary.heuricity.com` | Vercel | Website |
| `api.canary.heuricity.com` | Railway/Fly/VPS | Server API |

### Using Cloudflare (recommended):

1. Add `heuricity.com` to Cloudflare
2. Add DNS records:

```
Type  Name    Content                              Proxy
CNAME canary  cname.vercel-dns.com                 ✅ Proxied
CNAME api     canary-server-production.up.railway.app  ❌ DNS only
```

> **Important**: The API subdomain should be DNS-only (grey cloud), not proxied,
> because Railway/Fly handle their own SSL and WebSocket connections need direct access.

### In Vercel:

1. Go to Project → Settings → Domains
2. Add `canary.heuricity.com`
3. Vercel will verify the CNAME

### In Railway:

1. Go to Service → Settings → Networking → Custom Domain
2. Add `api.canary.heuricity.com`
3. Railway will verify the CNAME

---

## 9. Wire Stripe Webhooks

Now that the server is deployed:

1. Go to https://dashboard.stripe.com/webhooks
2. Click **Add endpoint**
3. URL: `https://api.canary.heuricity.com/api/webhooks/stripe`
4. Select events:
   - `checkout.session.completed`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
   - `invoice.paid`
5. Click **Add endpoint**
6. Copy the **Signing secret** (starts with `whsec_...`)
7. Add it to your server environment as `STRIPE_WEBHOOK_SECRET`
8. Redeploy the server (or restart)

### Test the webhook:

In Stripe Dashboard → Webhooks → your endpoint → **Send test webhook**:
- Select `checkout.session.completed` → Send
- Check server logs for `Stripe webhook: checkout.session.completed`

---

## 10. Discord Bot Go-Live

### 10a. Start the Bot

The bot starts automatically with the server if `DISCORD_BOT_TOKEN` is set.
Check logs for:

```
Canary bot ready: Canary#1234 (guilds: 0)
Slash commands synced
```

### 10b. Invite to Your Own Server First

Use the invite URL from Step 4d to add the bot to your test server.

### 10c. Run /setup

In your Discord server:

```
/setup channel:#canary-alerts role:@Subscriber
```

This registers your guild for alerts and subscription gating.

---

## 11. Create Your First Partner

You are your own first partner. From your deployed server:

```bash
# Login as admin (use the password from first server startup logs)
TOKEN=$(curl -s -X POST https://api.canary.heuricity.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YOUR_ADMIN_PASSWORD"}' | jq -r .access_token)

# Create yourself as a partner
curl -X POST https://api.canary.heuricity.com/api/partners \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Canary Official",
    "owner_discord_id": "YOUR_DISCORD_USER_ID",
    "owner_email": "your@email.com"
  }'

# Approve the partner (note the partner ID from response)
curl -X PATCH https://api.canary.heuricity.com/api/partners/1/status \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "approved"}'
```

Now your subscribe link works: `https://canary.heuricity.com/subscribe?ref=YOUR_INVITE_CODE`

---

## 12. End-to-End Smoke Test

Run through this checklist to verify everything works:

### Server Health
- [ ] `curl https://api.canary.heuricity.com/health` returns `{"status":"ok"}`

### Website
- [ ] `https://canary.heuricity.com` loads the landing page
- [ ] Pricing section shows correct prices (£10/£50)
- [ ] "Get Discord Bot" button goes to `/subscribe?tier=bot`

### Subscribe Flow
- [ ] Click "Continue with Discord" on subscribe page
- [ ] Redirects to Discord OAuth consent screen
- [ ] After authorising, redirects to Stripe Checkout
- [ ] Complete payment (use Stripe test card `4242 4242 4242 4242` if on test keys)
- [ ] Redirected to `/subscribe/success`
- [ ] Check server logs for `New subscription #1`
- [ ] Check Discord — you should have the subscriber role

### Bot Commands
- [ ] `/status` — shows site status (free, works for everyone)
- [ ] `/predict` — shows prediction (requires subscription)
- [ ] `/drops` — shows drop history (requires subscription)
- [ ] `/subscribe` — shows pricing embed (free)

### Alerts
- [ ] Wait for a detection signal (or trigger one by restarting server)
- [ ] Alert should appear in the configured alert channel

### Stripe Lifecycle
- [ ] Cancel the subscription in Stripe Dashboard
- [ ] Server logs show `Subscription #1 cancelled`
- [ ] Subscriber role is removed in Discord
- [ ] Bot commands now blocked for that user

---

## 13. Post-Launch Checklist

### Immediate (Day 1)
- [ ] Switch Stripe to **live keys** (replace `sk_test_` with `sk_live_`)
- [ ] Update webhook endpoint to use live signing secret
- [ ] Set `DISCORD_REDIRECT_URI` to production URL
- [ ] Set `CORS_ORIGINS` to production domains only
- [ ] Verify `.env` is NOT committed to git
- [ ] Save admin password somewhere secure (password manager)

### First Week
- [ ] Set up [Stripe Tax](https://stripe.com/tax) for UK VAT compliance
- [ ] Add terms of service and privacy policy pages
- [ ] Set up error monitoring (Sentry free tier)
- [ ] Set up uptime monitoring (Uptime Robot free tier)
- [ ] Configure database backups (copy `data/pkc.db` periodically)
- [ ] Set up a `#canary-support` channel in Discord

### First Month
- [ ] Monitor Stripe dashboard for failed payments
- [ ] Review detection accuracy — tune poll intervals if needed
- [ ] Recruit first partners — share the partner application page
- [ ] Set up Stripe Connect for partner payouts
- [ ] Consider adding an LLM API key for richer predictions

### Legal / Business
- [ ] Register as a sole trader or Ltd company (UK)
- [ ] Stripe requires business verification for live payments >£X
- [ ] Add disclaimer: "Not affiliated with The Pokemon Company or Nintendo"
- [ ] GDPR: you store Discord user IDs — add data processing note to privacy policy

---

## 14. Architecture Reference

### Payment Flow

```
User → canary.heuricity.com/subscribe
  → selects tier + billing
  → clicks "Continue with Discord"
  → GET /api/auth/discord?tier=bot&billing=monthly&ref=INVITE_CODE
  → Discord OAuth consent screen
  → GET /api/auth/discord/callback?code=...&state=...
  → Server exchanges code for Discord user ID
  → Server creates Stripe Checkout session with metadata
  → 303 redirect to Stripe Checkout
  → User pays
  → Stripe fires webhook → POST /api/webhooks/stripe
  → Server creates subscription in DB
  → Server calls grant_subscriber_role()
  → Bot adds Discord role to user
  → User redirected to /subscribe/success
```

### Alert Flow

```
Detection Engine (runs every 5s)
  → Detects change on pokemoncenter.com
  → Creates Signal in DB
  → Formats via MessageFormatter
  → Broadcasts to WebSocket clients
  → Sends to Discord webhook (if configured)

Bot Poll Loop (every 10s)
  → Fetches new signals from API
  → Sends to ALL configured guild alert channels
  → Pings subscriber role for critical alerts
```

### Subscription Check Flow

```
User runs /predict in Discord
  → Bot calls _check_subscription()
  → If guild NOT in partner_guilds → allow (free mode)
  → If guild IS configured → check subscriptions table
  → If active sub exists → allow
  → If no sub → block with "use /subscribe"
```

### Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | ✅ Yes | Server crashes without it |
| `DISCORD_BOT_TOKEN` | ✅ Yes | Bot won't start without it |
| `DISCORD_CLIENT_ID` | ✅ Yes | Needed for OAuth subscribe flow |
| `DISCORD_CLIENT_SECRET` | ✅ Yes | Needed for OAuth subscribe flow |
| `DISCORD_REDIRECT_URI` | ✅ Yes | Must match Discord developer portal |
| `STRIPE_SECRET_KEY` | ✅ Yes | Needed to create checkout sessions |
| `STRIPE_WEBHOOK_SECRET` | ✅ Yes | Needed to verify webhook signatures |
| `CORS_ORIGINS` | ✅ Yes | Comma-separated allowed origins |
| `DISCORD_WEBHOOK_URL` | Recommended | Engine posts alerts here too |
| `DISCORD_CHANNEL_ID` | Optional | Legacy fallback alert channel |
| `LLM_PROVIDER` | Optional | `anthropic` or `openai` |
| `ANTHROPIC_API_KEY` | Optional | Enables LLM narratives |
| `OPENAI_API_KEY` | Optional | Alternative LLM provider |
| `STRIPE_CONNECT_CLIENT_ID` | Optional | For partner Connect payouts |
| `HOMEPAGE_POLL_INTERVAL` | Optional | Default: 5 seconds |
| `SITEMAP_POLL_INTERVAL` | Optional | Default: 60 seconds |
| `CATALOG_POLL_INTERVAL` | Optional | Default: 120 seconds |
| `SOCIAL_POLL_INTERVAL` | Optional | Default: 300 seconds |
| `DB_PATH` | Optional | Default: `data/pkc.db` |
| `HOST` | Optional | Default: `0.0.0.0` |
| `PORT` | Optional | Default: `8000` |

---

## Quick Start Summary

If you want the absolute fastest path to revenue:

1. **5 min** — Create Discord app, get bot token + OAuth credentials
2. **5 min** — Create Stripe account, get API keys
3. **10 min** — Deploy server to Railway with env vars
4. **5 min** — Deploy website to Vercel with `NEXT_PUBLIC_API_URL`
5. **5 min** — Point DNS records
6. **5 min** — Create Stripe webhook, add signing secret to Railway
7. **5 min** — Create yourself as a partner, approve, run `/setup`
8. **5 min** — Smoke test the full flow

**Total: ~45 minutes from code to accepting payments.**
