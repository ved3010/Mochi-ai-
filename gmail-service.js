"use strict";

const googleClassroom = require("./google-classroom");

let cachedEmails = {
  timestamp: 0,
  data: null,
};
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

function isConnected() {
  return googleClassroom.isConnected();
}

/**
 * Fetches recent unread or important messages from Gmail.
 * @param {object} options
 * @param {number} [options.maxResults=8]
 * @param {string} [options.query="is:unread"]
 * @returns {Promise<{ ok: boolean, emails?: Array, error?: string, message?: string }>}
 */
async function fetchImportantEmails(options = {}) {
  const { maxResults = 8, query = "is:unread", forceRefresh = false } = options;

  if (!isConnected()) {
    return {
      ok: false,
      error: "NOT_CONNECTED",
      message: "Gmail is not connected. Sign in via Google Classroom to link both services.",
    };
  }

  const now = Date.now();
  if (!forceRefresh && cachedEmails.data && now - cachedEmails.timestamp < CACHE_TTL_MS) {
    return { ok: true, emails: cachedEmails.data };
  }

  const accessToken = await googleClassroom.getValidAccessToken();
  if (!accessToken) {
    return {
      ok: false,
      error: "AUTH_EXPIRED",
      message: "Google access token expired. Please reconnect in Settings.",
    };
  }

  try {
    const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`;
    const listRes = await fetch(listUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!listRes.ok) {
      if (listRes.status === 401) {
        return { ok: false, error: "AUTH_EXPIRED", message: "Gmail authorization expired." };
      }
      const errText = await listRes.text();
      if (listRes.status === 403) {
        if (errText.includes("SERVICE_DISABLED") || errText.includes("has not been used")) {
          return {
            ok: false,
            error: "API_DISABLED",
            message: "Gmail API is not enabled in your Google Cloud project. Please click Enable at: https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=715239477880",
          };
        }
        return {
          ok: false,
          error: "SCOPE_MISSING",
          message: "Gmail permission not granted. Please reconnect Google account to approve Gmail access.",
        };
      }
      return { ok: false, error: "API_ERROR", message: `Gmail API error (${listRes.status}): ${errText}` };
    }

    const listData = await listRes.json();
    const messages = listData.messages || [];

    if (messages.length === 0) {
      cachedEmails = { timestamp: now, data: [] };
      return { ok: true, emails: [] };
    }

    // Fetch details for each message
    const emailPromises = messages.map(async (msg) => {
      try {
        const detailUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
        const detailRes = await fetch(detailUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        });
        if (!detailRes.ok) return null;

        const detail = await detailRes.json();
        const headers = detail.payload?.headers || [];
        const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "(No Subject)";
        const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "Unknown Sender";
        const date = headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";

        const snippet = detail.snippet || "";
        const combinedText = `${subject} ${snippet}`.toLowerCase();
        const isUrgent = /deadline|due|assignment|exam|quiz|submission|interview|test|urgent|important|notice|shortlist|admit card|hall ticket/i.test(combinedText);

        return {
          id: msg.id,
          subject,
          from,
          date,
          snippet,
          isUrgent,
          link: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
        };
      } catch (_) {
        return null;
      }
    });

    const results = (await Promise.all(emailPromises)).filter(Boolean);

    // Sort urgent emails first
    results.sort((a, b) => (b.isUrgent ? 1 : 0) - (a.isUrgent ? 1 : 0));

    cachedEmails = { timestamp: now, data: results };
    return { ok: true, emails: results };
  } catch (err) {
    console.error("[GmailService] Failed to fetch emails:", err);
    return { ok: false, error: "NETWORK_ERROR", message: err.message };
  }
}

/**
 * Returns a clean summary string for the LLM workflow prompt.
 */
async function getGmailSummaryText() {
  if (!isConnected()) {
    return "Gmail status: Not connected (connect Google account to sync).";
  }

  const res = await fetchImportantEmails();
  if (!res.ok) {
    return `Gmail status: ${res.message || "Unavailable"}`;
  }

  const emails = res.emails || [];
  if (emails.length === 0) {
    return "Gmail: Inbox is clean! No unread messages.";
  }

  const urgent = emails.filter((e) => e.isUrgent);
  const others = emails.filter((e) => !e.isUrgent);

  const lines = [];
  if (urgent.length > 0) {
    lines.push(`🚨 High-Priority / Deadline Notices (${urgent.length}):`);
    urgent.forEach((e) => {
      lines.push(`- **${e.subject}** (From: ${e.from}) — "${e.snippet.slice(0, 100)}"`);
    });
  }

  if (others.length > 0) {
    lines.push(`📬 Other Unread Messages (${others.length}):`);
    others.slice(0, 4).forEach((e) => {
      lines.push(`- **${e.subject}** (From: ${e.from})`);
    });
  }

  return `Gmail Summary:\n${lines.join("\n")}`;
}

module.exports = {
  isConnected,
  fetchImportantEmails,
  getGmailSummaryText,
};
