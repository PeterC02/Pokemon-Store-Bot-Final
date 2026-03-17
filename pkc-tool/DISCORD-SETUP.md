# Canary Discord Bot — Setup Guide

Complete guide to creating, configuring, and connecting the Discord application to the Canary bot.

---

## Table of Contents

1. [Create the Discord Application](#1-create-the-discord-application)
2. [Create the Bot User](#2-create-the-bot-user)
3. [Configure OAuth2](#3-configure-oauth2)
4. [Generate the Bot Invite Link](#4-generate-the-bot-invite-link)
5. [Invite the Bot to Your Server](#5-invite-the-bot-to-your-server)
6. [Server Preparation](#6-server-preparation)
7. [Run /setup](#7-run-setup)
8. [Environment Variables Reference](#8-environment-variables-reference)
9. [Bot Commands Reference](#9-bot-commands-reference)
10. [How Subscriptions Work](#10-how-subscriptions-work)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Create the Discord Application

1. Go to **https://discord.com/developers/applications**
2. Sign in with the Discord account that will own the bot
3. Click **"New Application"** (top right)
4. Name it **Canary** (or whatever you prefer — users will see this name)
5. Accept the Terms of Service and click **Create**

You'll land on the **General Information** page:

- **Application ID** — copy this, it's your `DISCORD_CLIENT_ID`
- **Public Key** — not needed for this setup

![General Information page location of Application ID](https://i.imgur.com/placeholder-general-info.png)

---

## 2. Create the Bot User

1. In the left sidebar, click **"Bot"**
2. Click **"Add Bot"** → confirm with **"Yes, do it!"**
3. You'll see your bot user with a **Token** section

### 2a. Copy the Bot Token

1. Click **"Reset Token"** (or **"Copy"** if it's visible)
2. **Save this token immediately** — you can only see it once
3. This is your `DISCORD_BOT_TOKEN`

> ⚠️ **NEVER share your bot token.** Anyone with it can control your bot.
> If it leaks, click "Reset Token" immediately to invalidate the old one.

### 2b. Enable Privileged Intents

Scroll down to **Privileged Gateway Intents** and enable:

| Intent | Why It's Needed |
|--------|-----------------|
| ✅ **Server Members Intent** | Required to grant/revoke subscriber roles to users |
| ✅ **Message Content Intent** | Required for reading message context in alert channels |

Click **Save Changes**.

### 2c. Uncheck Public Bot (Recommended)

Under the **Authorization Flow** section:

- ❌ Uncheck **"Public Bot"** — this prevents anyone else from inviting your bot
- Only you (the application owner) will be able to add it to servers

---

## 3. Configure OAuth2

The OAuth2 flow is what allows users to "Log in with Discord" on the Canary website when subscribing.

1. In the left sidebar, click **"OAuth2"**
2. Note the **Client ID** (same as Application ID) and **Client Secret**
   - Click **"Reset Secret"** if you need to regenerate it
   - Copy the **Client Secret** — this is your `DISCORD_CLIENT_SECRET`

### 3a. Add Redirect URLs

Under **Redirects**, click **"Add Redirect"** and add:

**For production:**
```
https://api.canary.heuricity.com/api/auth/discord/callback
```

**For local development (optional):**
```
http://localhost:8000/api/auth/discord/callback
```

> Replace `api.canary.heuricity.com` with your actual server domain.

Click **Save Changes**.

### How This Works

When a user clicks "Continue with Discord" on the subscribe page:
1. They're sent to Discord's OAuth consent screen
2. They authorise the Canary app to read their identity
3. Discord redirects them to your callback URL with a temporary code
4. Your server exchanges that code for the user's Discord ID
5. Your server creates a Stripe Checkout session with that Discord ID attached
6. After payment, the bot uses the Discord ID to grant the subscriber role

---

## 4. Generate the Bot Invite Link

### 4a. Using the URL Generator (Recommended)

1. Go to **OAuth2** → **URL Generator**
2. Under **Scopes**, select:
   - ✅ `bot`
   - ✅ `applications.commands`
3. Under **Bot Permissions**, select:
   - ✅ Manage Roles
   - ✅ Send Messages
   - ✅ Send Messages in Threads
   - ✅ Embed Links
   - ✅ Attach Files
   - ✅ Read Message History
   - ✅ Use Slash Commands
4. Copy the **Generated URL** at the bottom

### 4b. Manual URL Construction

If you prefer, construct the URL manually:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=268504128&scope=bot%20applications.commands
```

Replace `YOUR_CLIENT_ID` with your Application ID.

The permission integer `268504128` includes:
- Manage Roles (268435456)
- Send Messages (2048)
- Embed Links (16384)
- Attach Files (32768)
- Read Message History (65536)
- Use Slash Commands (2147483648 — added separately via scope)

### 4c. Save This URL

You'll use this invite URL to:
- Add the bot to your own server
- Give to approved partners so they can add the bot to their servers

---

## 5. Invite the Bot to Your Server

1. Open the invite URL from Step 4 in your browser
2. Select the server you want to add the bot to from the dropdown
3. Click **"Authorise"**
4. Complete the CAPTCHA if prompted

The bot will appear in your server's member list as offline until the server is running.

### Permissions Check

After inviting, verify the bot's role in Server Settings → Roles:

- The **Canary** role (auto-created) should be **above** the subscriber role in the role hierarchy
- If the bot's role is below the subscriber role, it **cannot** grant that role to users

**To fix:** Drag the **Canary** bot role above your subscriber role in the role list.

---

## 6. Server Preparation

Before running `/setup`, prepare your Discord server:

### 6a. Create an Alert Channel

1. Create a new text channel (e.g., `#canary-alerts` or `#drop-alerts`)
2. This is where the bot will post:
   - Real-time drop alerts
   - Queue status changes
   - Site state changes (challenge wall up/down)
   - Daily predictions (9am GMT)
   - Weekly recaps (Sunday 6pm GMT)

**Recommended permissions for the alert channel:**
- Everyone: ❌ Send Messages (read-only for members)
- Canary bot role: ✅ Send Messages, ✅ Embed Links, ✅ Attach Files

### 6b. Create a Subscriber Role

1. Go to Server Settings → Roles → **Create Role**
2. Name it something clear (e.g., `Subscriber`, `Canary Pro`, `Premium`)
3. Choose a colour (yellow `#FFD700` matches the Canary brand)
4. **Do not** assign any channel permissions to this role yet
   - You can gate channels behind this role to create subscriber-only areas

**Important:** Make sure this role is **below** the Canary bot role in the hierarchy.

### 6c. Optional: Create Subscriber-Only Channels

If you want exclusive channels for paying subscribers:

1. Create channels like `#subscriber-chat`, `#premium-signals`
2. In channel permissions:
   - @everyone: ❌ View Channel
   - @Subscriber: ✅ View Channel
3. Subscribers will automatically see these channels when their role is granted

---

## 7. Run /setup

Once the bot is online and in your server:

1. Type `/setup` in any channel where the bot can see messages
2. You'll be prompted with two options:
   - **Channel** — select your alert channel (e.g., `#canary-alerts`)
   - **Role** — select your subscriber role (e.g., `@Subscriber`)
3. Submit the command

The bot will:
- Register your guild in the Canary database
- Link it to your partner account
- Set the alert channel for drop notifications
- Set the subscriber role for automatic grant/revoke
- Confirm with a success message

### Permissions Required

You need **Manage Server** permission in the Discord server to run `/setup`.

### Verify It Worked

After running `/setup`:
- The bot should respond with "✅ Guild configured successfully"
- Try `/status` — it should return the current Pokemon Center site status
- Check the alert channel — the bot may post a test message

---

## 8. Environment Variables Reference

These Discord-related variables go in your server's `.env` file:

```env
# === Discord Bot (REQUIRED) ===
DISCORD_BOT_TOKEN=your-bot-token-here
# ↑ From Step 2a — Bot → Token

# === Discord OAuth (REQUIRED for subscribe flow) ===
DISCORD_CLIENT_ID=123456789012345678
# ↑ From Step 1 — General Information → Application ID

DISCORD_CLIENT_SECRET=AbCdEfGhIjKlMnOpQrStUvWxYz123456
# ↑ From Step 3 — OAuth2 → Client Secret

DISCORD_REDIRECT_URI=https://api.canary.heuricity.com/api/auth/discord/callback
# ↑ Must EXACTLY match one of the Redirect URLs from Step 3a

# === Optional ===
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1234567890/abcdef...
# ↑ Optional fallback: right-click alert channel → Integrations → Webhooks → New → Copy URL

DISCORD_CHANNEL_ID=1234567890123456789
# ↑ Legacy fallback — only needed if /setup hasn't been run
```

### Where to Find Your Discord IDs

To copy Discord IDs, enable Developer Mode first:
1. User Settings → Advanced → **Developer Mode** → On
2. Now you can right-click users, channels, servers, and roles to **Copy ID**

| ID | How to Get It |
|----|---------------|
| Server (Guild) ID | Right-click the server name → Copy Server ID |
| Channel ID | Right-click the channel → Copy Channel ID |
| Role ID | Server Settings → Roles → right-click role → Copy Role ID |
| User ID | Right-click any user → Copy User ID |

---

## 9. Bot Commands Reference

### Free Commands (no subscription needed)

| Command | Description |
|---------|-------------|
| `/status` | Shows current Pokemon Center site state (normal, challenge wall, queue, dropping) |
| `/subscribe` | Shows pricing tiers and a link to subscribe |

### Paid Commands (subscription required)

| Command | Description |
|---------|-------------|
| `/predict` | AI-powered prediction of the next drop with confidence score |
| `/drops` | History of recent drops with timing and products |
| `/products` | Tracked products and their last-seen status |
| `/signals` | Raw detection signals from the monitoring engine |
| `/trending` | Trending Pokemon TCG content from Reddit communities |

### Partner Commands (Manage Server permission required)

| Command | Description |
|---------|-------------|
| `/setup` | Configure alert channel and subscriber role for this server |

### What Happens When a Non-Subscriber Uses a Paid Command?

The bot responds with an embed like:

> 🔒 **Subscription Required**
>
> This command requires an active Canary subscription.
> Use `/subscribe` to see pricing and get started.

---

## 10. How Subscriptions Work

### The User Journey

1. User runs `/subscribe` in Discord (or visits the website)
2. They're shown pricing: Discord Bot £10/mo or Desktop + Bot £50/mo
3. They click the subscribe link → Discord OAuth → Stripe Checkout
4. After payment, the bot **automatically grants the subscriber role** in the server
5. The user can now use all paid commands and see subscriber-only channels

### Automatic Role Management

| Event | What Happens |
|-------|-------------|
| **Payment succeeds** | Subscriber role granted immediately |
| **Subscription cancelled** | Role revoked at end of billing period |
| **Payment fails** | Role revoked after grace period |
| **Subscription renewed** | Role stays active (no action needed) |

This is all automatic — no manual role management required.

### Multi-Server Support

- A single subscription is tied to **one guild** (the one the user subscribed through)
- If a user is in multiple Canary-powered servers, they need a subscription for each
- Partners can each have their own invite link so subscribers are attributed correctly

---

## 11. Troubleshooting

### Bot is offline / not responding

| Check | Fix |
|-------|-----|
| Is the server running? | Check server logs for `Canary bot ready` |
| Is `DISCORD_BOT_TOKEN` set? | Add it to `.env` and restart |
| Is the token valid? | Regenerate in Discord Developer Portal → Bot → Reset Token |
| Is the bot in the server? | Use the invite URL from Step 4 |

### /setup says "Permission denied"

- You need **Manage Server** permission in the Discord server
- Ask the server owner to grant you this permission or run the command themselves

### Bot can't grant roles

| Check | Fix |
|-------|-----|
| Bot role position | Drag the Canary bot role **above** the subscriber role in Server Settings → Roles |
| Manage Roles permission | Ensure the bot was invited with Manage Roles (re-invite if needed) |
| Role is @everyone | Can't assign @everyone — create a dedicated subscriber role |

### Slash commands not showing up

- Slash commands take up to **1 hour** to propagate globally
- For instant updates in your test server, the bot syncs commands on startup
- Try restarting the bot / server
- Make sure `applications.commands` scope was included in the invite URL

### OAuth "redirect_uri mismatch" error

- The `DISCORD_REDIRECT_URI` in your `.env` must **exactly** match one of the Redirect URLs in Discord Developer Portal → OAuth2 → Redirects
- Check for trailing slashes, http vs https, port numbers
- Common mistake: `http://` locally vs `https://` in production

### Alerts not posting

| Check | Fix |
|-------|-----|
| Has `/setup` been run? | Run `/setup` and select the alert channel |
| Bot has permissions in channel? | Check channel permissions — bot needs Send Messages + Embed Links |
| Detection engine running? | Check server logs for `Detection engine starting` |
| Is the site actually changing? | `/status` shows current state — alerts only fire on state changes |

### Subscriber can't use paid commands after paying

| Check | Fix |
|-------|-----|
| Does the user have the subscriber role? | Check in Discord — if not, the webhook may have failed |
| Is the subscription in the DB? | Check server logs for `New subscription` after payment |
| Is `STRIPE_WEBHOOK_SECRET` correct? | Verify in server logs — look for `Invalid webhook` errors |
| Did the guild_id get passed? | Check Stripe payment metadata for `guild_id` |

### Test the Full Flow

If something isn't working, trace the flow step by step:

```
1. /subscribe in Discord → Does it show the pricing embed?
2. Click subscribe link → Does it redirect to Discord OAuth?
3. Authorise → Does it redirect to Stripe Checkout?
4. Pay (use test card 4242 4242 4242 4242) → Does it redirect to success page?
5. Check server logs → Is there a webhook event logged?
6. Check Discord → Does the user have the subscriber role?
7. /predict → Does it work now?
```

---

## Quick Reference Card

```
Discord Developer Portal: https://discord.com/developers/applications
Bot Token:                 Bot → Reset Token → Copy
Client ID:                 General Information → Application ID
Client Secret:             OAuth2 → Reset Secret → Copy
Redirect URL:              OAuth2 → Redirects → Add
Invite URL:                OAuth2 → URL Generator → bot + applications.commands
Privileged Intents:        Bot → Server Members ✅, Message Content ✅
```
