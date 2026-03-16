# OpenClaw/Lumos - Self-Hosted AI Agent on Hetzner VPS

A self-hosted AI agent stack running on a Hetzner VPS, accessible via Telegram. Integrates Gmail and Google Calendar through a Google Apps Script connector ("Lumos Connector") that sends automated digests and urgent alerts.

## Architecture

```
+------------------+       +---------------------+       +------------------+
|   Telegram App   | <---> |  Hetzner VPS (CX22) | <---> |  Anthropic API   |
|   (Hedwig Bot)   |       |  OpenClaw + Lumos   |       |  Claude Sonnet   |
+------------------+       +---------------------+       +------------------+
                                     ^
                                     | Tailscale VPN
                                     v
                            +------------------+
                            |  Local Machine   |
                            |  (SSH via TS)    |
                            +------------------+

+------------------+       +---------------------+
|  Google Apps     | ----> |  Telegram Bot API   |
|  Script (GAS)   |       |  (Hedwig)           |
|  Gmail+Calendar |       +---------------------+
+------------------+
```

**Components:**
- **Hetzner VPS (CX22)** — Ubuntu 24.04, 2 vCPU, 4GB RAM, 40GB SSD (Falkenstein, DE)
- **OpenClaw** — Open-source AI agent framework (local gateway on port 18789)
- **Lumos** — The AI agent persona, running Claude Sonnet 4.6 via Anthropic API
- **Hedwig** — Telegram bot (`@HedwigOwlPostBot`) for bidirectional chat with Lumos
- **Lumos Connector** — Google Apps Script for Gmail/Calendar digest notifications
- **Tailscale** — Zero-config mesh VPN for secure SSH access (no public SSH port)
- **UFW + Hetzner Firewall** — Defense in depth, only Tailscale and HTTPS exposed

## VPS Setup

### 1. Provision the server

Created a Hetzner Cloud CX22 instance:
- **OS:** Ubuntu 24.04
- **Location:** Falkenstein (fsn1)
- **SSH Key:** Added during creation (no password auth)

```bash
# Initial login
ssh root@<SERVER_IP>

# Create non-root user
adduser zohaib
usermod -aG sudo zohaib

# Copy SSH keys to new user
mkdir -p /home/zohaib/.ssh
cp /root/.ssh/authorized_keys /home/zohaib/.ssh/
chown -R zohaib:zohaib /home/zohaib/.ssh
chmod 700 /home/zohaib/.ssh
chmod 600 /home/zohaib/.ssh/authorized_keys
```

### 2. SSH hardening

```bash
sudo nano /etc/ssh/sshd_config
```

Key settings:
```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
Port 22  # Will be blocked by firewall, only accessible via Tailscale
```

```bash
sudo systemctl restart sshd
```

### 3. Install Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```

Once connected, SSH access is exclusively via Tailscale:
```bash
# From local machine (after installing Tailscale locally)
ssh zohaib@<TAILSCALE_HOSTNAME>
```

### 4. Firewall setup (defense in depth)

**UFW (host firewall):**
```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow Tailscale interface
sudo ufw allow in on tailscale0

# Allow HTTPS (for future web services)
sudo ufw allow 443/tcp

# Enable
sudo ufw enable
sudo ufw status verbose
```

**Hetzner Cloud Firewall (network-level):**
- Created firewall in Hetzner console
- Rules: deny all inbound except TCP 443 (HTTPS)
- SSH (port 22) is NOT exposed — only reachable via Tailscale
- Applied to the server

This creates two layers: Hetzner firewall blocks traffic before it hits the VPS, UFW provides host-level defense.

### 5. System updates & essentials

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential unzip
```

## OpenClaw Installation

### 1. Install OpenClaw

```bash
curl -fsSL https://get.openclaw.ai | bash
```

### 2. Run the onboarding wizard

```bash
openclaw onboard
```

This sets up:
- Anthropic API key (for Claude access)
- Default model (`anthropic/claude-sonnet-4-6`)
- Local workspace at `/home/zohaib/.openclaw/workspace`
- Gateway on `localhost:18789` with token auth

### 3. Configure the gateway

The gateway runs in local mode, bound to loopback only:

| Setting | Value |
|---------|-------|
| Port | 18789 |
| Mode | local |
| Bind | loopback |
| Auth | token-based |
| Tailscale | off (direct TS SSH instead) |

Denied commands for safety:
- `camera.snap`, `camera.clip`, `screen.record`
- `contacts.add`, `calendar.add`, `reminders.add`, `sms.send`

See `openclaw.example.json` for the full configuration template.

## Telegram Bot (Hedwig)

### 1. Create the bot

1. Message `@BotFather` on Telegram
2. `/newbot` -> name it `Hedwig Owl Post` -> username `@HedwigOwlPostBot`
3. Copy the bot token

### 2. Configure in OpenClaw

The Telegram channel is configured in `openclaw.json`:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "botToken": "YOUR_BOT_TOKEN",
      "groupPolicy": "allowlist",
      "streaming": "partial"
    }
  }
}
```

- **dmPolicy: pairing** — Bot responds to DMs from paired users
- **groupPolicy: allowlist** — Only responds in explicitly allowed groups
- **streaming: partial** — Streams responses as they generate

### 3. Enable the Telegram plugin

```json
{
  "plugins": {
    "entries": {
      "telegram": { "enabled": true }
    }
  }
}
```

### 4. Start OpenClaw

```bash
openclaw start
```

Message `@HedwigOwlPostBot` on Telegram — Lumos responds via Claude Sonnet.

## Lumos Connector (Google Apps Script)

The `lumos-connector.gs` script monitors Gmail and Google Calendar, sending automated digests to Telegram.

### Features

| Feature | Schedule | Description |
|---------|----------|-------------|
| Morning Digest | 7:30 AM IST | Unread emails + today's calendar events |
| Evening Digest | 6:00 PM IST | Unread email summary |
| Urgent Alerts | Every 30 min | Starred/important emails from the last hour |

### Setup

1. Go to [script.google.com](https://script.google.com) -> New Project
2. Paste the contents of `lumos-connector.gs`
3. Fill in the `CONFIG` object:
   ```javascript
   const CONFIG = {
     TELEGRAM_BOT_TOKEN: "your-bot-token",
     TELEGRAM_CHAT_ID: "your-chat-id",  // Run getChatId() to find this
     // ...rest of defaults are fine
   };
   ```
4. Run `getChatId()` once:
   - Send any message to your bot on Telegram
   - Run the function -> View -> Logs -> copy your `chat_id`
5. Run `setupTriggers()` once to install time-based triggers
6. Authorize when prompted (needs Gmail, Calendar, URL Fetch scopes)

### Web App API (optional)

Deploy as a web app for external access to your data:

```
GET ?action=emails         → Unread inbox emails (JSON)
GET ?action=calendar&hours=24  → Upcoming calendar events (JSON)
GET ?action=urgent         → Starred/important recent emails (JSON)
```

Deploy: Extensions -> Apps Script -> Deploy -> New deployment -> Web app
- Execute as: Me
- Access: Anyone (URL is the secret)

### Email deduplication

Processed emails are labeled `lumos-notified` in Gmail to prevent duplicate notifications. The label is auto-created on first run.

### Timezone

All times use `Asia/Kolkata` (IST, UTC+5:30). Trigger times are set in UTC:
- Morning 7:30 AM IST = 2:00 AM UTC
- Evening 6:00 PM IST = 12:00 PM UTC

## Security Model

```
Internet ──> Hetzner Firewall (deny all except 443)
                 │
                 v
              UFW (deny all except tailscale0 + 443)
                 │
                 v
              Tailscale (authenticated mesh VPN)
                 │
                 v
              OpenClaw Gateway (loopback + token auth)
```

- **No public SSH port** — SSH only via Tailscale
- **No password auth** — SSH key only
- **No root login** — `PermitRootLogin no`
- **Gateway not exposed** — Bound to loopback, token-authenticated
- **Sensitive commands denied** — Camera, contacts, SMS blocked in OpenClaw
- **Two firewall layers** — Hetzner (network) + UFW (host)

## File Structure

```
openclaw-lumos/
├── README.md               # This file
├── .gitignore              # Excludes openclaw.json (contains secrets)
├── openclaw.example.json   # Sanitized OpenClaw config template
└── lumos-connector.gs      # Google Apps Script (Gmail/Calendar → Telegram)
```

## Next Steps

### Gmail OAuth2 Two-Way Integration

The current Lumos Connector is **one-way** (Gmail/Calendar -> Telegram). The next phase adds **two-way integration** so Lumos can read, reply to, and manage emails conversationally:

1. **Google Cloud Project** — Create a project with Gmail API and Calendar API enabled
2. **OAuth2 Credentials** — Set up OAuth2 consent screen and credentials (not just Apps Script scopes)
3. **OpenClaw Gmail Tool** — Register Gmail as an OpenClaw tool so Lumos can:
   - Read full email threads (not just snippets)
   - Compose and send replies
   - Archive, label, or snooze emails
   - Create/modify calendar events
4. **Conversation Flow** — "Reply to that email from Sarah saying I'll join the call" -> Lumos drafts and sends via Gmail API
5. **Token Refresh** — OAuth2 refresh token stored securely on the VPS, auto-refreshed by OpenClaw

### Other Planned Improvements

- [ ] Gmail two-way integration (read, reply, manage via Lumos)
- [ ] Calendar event creation/modification via Telegram
- [ ] Persistent conversation memory across Telegram sessions
- [ ] Voice message transcription and response
- [ ] Multi-user support with Telegram group allowlisting
- [ ] Monitoring and alerting (uptime, error rates)
