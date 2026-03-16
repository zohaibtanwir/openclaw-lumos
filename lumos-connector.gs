/**
 * Lumos Connector — Google Apps Script
 * Monitors Gmail + Google Calendar and sends digests to Telegram (→ OpenClaw/Lumos)
 *
 * SETUP:
 * 1. Go to https://script.google.com → New Project → paste this file
 * 2. Fill in CONFIG below
 * 3. Run setupTriggers() once to install time-based triggers
 * 4. Authorize when prompted (needs Gmail + Calendar + URL Fetch scopes)
 */

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  // Your Telegram bot token (same one OpenClaw uses)
  TELEGRAM_BOT_TOKEN: "8729241889:AAEuBhrR4F2Pj6I4msnllxOr_DpZBOXEQSM",

  // Your personal Telegram chat ID (run getChatId() to find it, see below)
  TELEGRAM_CHAT_ID: "YOUR_TELEGRAM_CHAT_ID",

  // Gmail: query to monitor for important mail
  GMAIL_QUERY: "is:unread is:inbox -category:promotions -category:social",

  // How many unread emails to surface per digest (max)
  GMAIL_MAX_RESULTS: 5,

  // Calendar: how many hours ahead to look for events
  CALENDAR_LOOKAHEAD_HOURS: 24,

  // Label name used to track "already notified" emails (auto-created if missing)
  PROCESSED_LABEL: "lumos-notified",
};
// ───────────────────────────────────────────────────────────────────────────


// ── WEB APP API ───────────────────────────────────────────────────────────
// Deploy as: Execute as Me, Access: Anyone (no auth required — URL is the secret)
// Deploy: Extensions → Apps Script → Deploy → New deployment → Web app

/**
 * GET ?action=emails
 * GET ?action=calendar&hours=24
 * GET ?action=urgent
 */
function doGet(e) {
  const action = e.parameter.action || "emails";

  let data;
  try {
    if (action === "emails") {
      data = fetchEmailsRaw(parseInt(e.parameter.max) || 10);
    } else if (action === "calendar") {
      data = fetchCalendarRaw(parseInt(e.parameter.hours) || 24);
    } else if (action === "urgent") {
      data = fetchUrgentRaw();
    } else {
      data = { error: "Unknown action. Use: emails, calendar, urgent" };
    }
  } catch (err) {
    data = { error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function fetchEmailsRaw(max) {
  const threads = GmailApp.search(CONFIG.GMAIL_QUERY, 0, max);
  return threads.map(thread => {
    const msg = thread.getMessages()[thread.getMessageCount() - 1];
    return {
      id      : thread.getId(),
      from    : msg.getFrom(),
      subject : thread.getFirstMessageSubject(),
      date    : msg.getDate().toISOString(),
      snippet : msg.getPlainBody().replace(/\s+/g, " ").trim().substring(0, 300),
      unread  : thread.isUnread(),
    };
  });
}

function fetchCalendarRaw(hoursAhead) {
  const now  = new Date();
  const end  = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
  const events = [];

  for (const cal of CalendarApp.getAllOwnedCalendars()) {
    for (const ev of cal.getEvents(now, end)) {
      events.push({
        title    : ev.getTitle(),
        start    : ev.getStartTime().toISOString(),
        end      : ev.getEndTime().toISOString(),
        location : ev.getLocation(),
        allDay   : ev.isAllDayEvent(),
        calendar : cal.getName(),
      });
    }
  }

  events.sort((a, b) => new Date(a.start) - new Date(b.start));
  return events;
}

function fetchUrgentRaw() {
  const threads = GmailApp.search(
    `is:unread is:inbox (is:important OR is:starred) newer_than:2h`, 0, 5
  );
  return threads.map(thread => {
    const msg = thread.getMessages()[thread.getMessageCount() - 1];
    return {
      from    : msg.getFrom(),
      subject : thread.getFirstMessageSubject(),
      date    : msg.getDate().toISOString(),
      snippet : msg.getPlainBody().replace(/\s+/g, " ").trim().substring(0, 300),
    };
  });
}

// ── ENTRY POINTS ──────────────────────────────────────────────────────────

/** Morning digest: email summary + day's calendar events */
function morningDigest() {
  const emailSection = getEmailDigest();
  const calSection   = getCalendarDigest(CONFIG.CALENDAR_LOOKAHEAD_HOURS);

  const now     = new Date();
  const dateStr = Utilities.formatDate(now, "Asia/Kolkata", "EEE, dd MMM yyyy");

  let msg = `☀️ <b>Morning Digest — ${dateStr}</b>\n\n`;
  msg += calSection  || "<i>No events today.</i>";
  msg += "\n\n";
  msg += emailSection || "<i>No important unread emails.</i>";

  sendTelegram(msg);
}

/** Evening digest: unread emails that arrived during the day */
function eveningDigest() {
  const emailSection = getEmailDigest();

  const now     = new Date();
  const dateStr = Utilities.formatDate(now, "Asia/Kolkata", "EEE, dd MMM yyyy");

  let msg = `🌙 <b>Evening Digest — ${dateStr}</b>\n\n`;
  msg += emailSection || "<i>No unread emails.</i>";

  sendTelegram(msg);
}

/** Urgent alert: fires every 30 min, only notifies if high-priority mail arrived */
function urgentEmailCheck() {
  const urgent = getUrgentEmails();
  if (!urgent) return;
  sendTelegram(`🚨 <b>Urgent Email</b>\n\n${urgent}`);
}


// ── GMAIL ─────────────────────────────────────────────────────────────────

function getEmailDigest() {
  const processedLabel = getOrCreateLabel(CONFIG.PROCESSED_LABEL);
  const threads = GmailApp.search(CONFIG.GMAIL_QUERY, 0, CONFIG.GMAIL_MAX_RESULTS);

  if (!threads.length) return null;

  const lines = ["📧 <b>Unread Emails</b>"];
  let count = 0;

  for (const thread of threads) {
    const msg     = thread.getMessages()[thread.getMessageCount() - 1];
    const from    = formatSender(msg.getFrom());
    const subject = thread.getFirstMessageSubject();
    const snippet = msg.getPlainBody().replace(/\s+/g, " ").trim().substring(0, 120);

    lines.push(
      `\n<b>From:</b> ${esc(from)}\n<b>Subject:</b> ${esc(subject)}\n<i>${esc(snippet)}…</i>`
    );
    thread.addLabel(processedLabel);
    count++;
  }

  return count > 0 ? lines.join("\n") : null;
}

function getUrgentEmails() {
  const query   = `is:unread is:inbox (is:important OR is:starred) newer_than:1h`;
  const threads = GmailApp.search(query, 0, 3);
  if (!threads.length) return null;

  const lines = [];
  for (const thread of threads) {
    const msg     = thread.getMessages()[thread.getMessageCount() - 1];
    const from    = formatSender(msg.getFrom());
    const subject = thread.getFirstMessageSubject();
    lines.push(`<b>From:</b> ${esc(from)}\n<b>Subject:</b> ${esc(subject)}`);
  }

  return lines.join("\n\n");
}

function formatSender(from) {
  const match = from.match(/^(.+?)\s*</);
  return match ? match[1].trim() : from;
}

function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}


// ── CALENDAR ──────────────────────────────────────────────────────────────

function getCalendarDigest(hoursAhead) {
  const now  = new Date();
  const end  = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

  const calendars = CalendarApp.getAllOwnedCalendars();
  const events    = [];

  for (const cal of calendars) {
    const calEvents = cal.getEvents(now, end);
    for (const ev of calEvents) {
      events.push({
        title  : ev.getTitle(),
        start  : ev.getStartTime(),
        end    : ev.getEndTime(),
        location: ev.getLocation(),
        allDay : ev.isAllDayEvent(),
      });
    }
  }

  if (!events.length) return null;

  events.sort((a, b) => a.start - b.start);

  const lines = ["📅 <b>Today's Events</b>"];

  for (const ev of events) {
    const timeStr = ev.allDay
      ? "All day"
      : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
    const loc = ev.location ? `\n  📍 ${esc(ev.location)}` : "";
    lines.push(`\n• <b>${esc(ev.title)}</b>\n  ${esc(timeStr)}${loc}`);
  }

  return lines.join("\n");
}

function fmtTime(date) {
  return Utilities.formatDate(date, "Asia/Kolkata", "h:mm a");
}


// ── TELEGRAM ──────────────────────────────────────────────────────────────

function sendTelegram(text) {
  const url     = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id    : CONFIG.TELEGRAM_CHAT_ID,
    text       : text,
    parse_mode : "HTML",
  };

  const options = {
    method             : "post",
    contentType        : "application/json",
    payload            : JSON.stringify(payload),
    muteHttpExceptions : true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const result   = JSON.parse(response.getContentText());

  if (!result.ok) {
    Logger.log(`Telegram error: ${JSON.stringify(result)}`);
  }
}

/**
 * Run this once to find your Telegram chat ID.
 * 1. Send any message to your bot on Telegram
 * 2. Run getChatId() → View → Logs → copy your chat_id
 */
function getChatId() {
  const url      = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/getUpdates`;
  const response = UrlFetchApp.fetch(url);
  const data     = JSON.parse(response.getContentText());
  Logger.log(JSON.stringify(data.result.map(u => ({
    chat_id  : u.message?.chat?.id,
    username : u.message?.chat?.username,
    text     : u.message?.text,
  })), null, 2));
}


// ── TRIGGERS ──────────────────────────────────────────────────────────────

/**
 * Run this ONCE to install all triggers.
 * IST = UTC+5:30:
 *   7:30 AM IST ≈ 2 AM UTC
 *   6:00 PM IST ≈ 12 PM UTC
 */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // Morning digest — 7:30 AM IST
  ScriptApp.newTrigger("morningDigest")
    .timeBased()
    .atHour(2)
    .everyDays(1)
    .create();

  // Evening digest — 6:00 PM IST
  ScriptApp.newTrigger("eveningDigest")
    .timeBased()
    .atHour(12)
    .everyDays(1)
    .create();

  // Urgent email check — every 30 minutes
  ScriptApp.newTrigger("urgentEmailCheck")
    .timeBased()
    .everyMinutes(30)
    .create();

  Logger.log("Triggers installed: morning digest, evening digest, urgent check (30min)");
}

function teardownTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log("All triggers removed.");
}


// ── UTILS ─────────────────────────────────────────────────────────────────

/** Escape HTML special characters — safe for any email/calendar content */
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
