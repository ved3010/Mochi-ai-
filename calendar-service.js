"use strict";

const googleClassroom = require("./google-classroom");

let cachedEvents = {
  timestamp: 0,
  data: null,
};
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

function isConnected() {
  return googleClassroom.isConnected();
}

/**
 * Format ISO date string into readable user friendly string.
 */
function formatEventTime(isoString, isAllDay = false) {
  if (!isoString) return "";
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;

    if (isAllDay) {
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        weekday: "short",
      });
    }

    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();

    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow =
      d.getDate() === tomorrow.getDate() &&
      d.getMonth() === tomorrow.getMonth() &&
      d.getFullYear() === tomorrow.getFullYear();

    const timeStr = d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    if (isToday) return `Today at ${timeStr}`;
    if (isTomorrow) return `Tomorrow at ${timeStr}`;

    const dateStr = d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    return `${dateStr} at ${timeStr}`;
  } catch (_) {
    return isoString;
  }
}

/**
 * Fetches upcoming events from the user's primary Google Calendar.
 * @param {object} options
 * @param {number} [options.maxResults=15]
 * @param {number} [options.days=7]
 * @param {boolean} [options.forceRefresh=false]
 * @returns {Promise<{ ok: boolean, events?: Array, todayEvents?: Array, upcomingEvents?: Array, error?: string, message?: string }>}
 */
async function fetchUpcomingEvents(options = {}) {
  const { maxResults = 15, days = 7, forceRefresh = false } = options;

  if (!isConnected()) {
    return {
      ok: false,
      error: "NOT_CONNECTED",
      message: "Google account is not connected yet. Connect your Google account to sync your Calendar.",
    };
  }

  const nowMs = Date.now();
  if (!forceRefresh && cachedEvents.data && nowMs - cachedEvents.timestamp < CACHE_TTL_MS) {
    return {
      ok: true,
      events: cachedEvents.data.events,
      todayEvents: cachedEvents.data.todayEvents,
      upcomingEvents: cachedEvents.data.upcomingEvents,
    };
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
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", String(maxResults));

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { ok: false, error: "AUTH_EXPIRED", message: "Google Calendar authorization expired." };
      }
      const errText = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(errText);
      } catch (_) {}

      const msg = parsed?.error?.message || errText;
      if (response.status === 403) {
        if (/disabled/i.test(msg) || /SERVICE_DISABLED|accessNotConfigured/i.test(msg)) {
          return {
            ok: false,
            error: "API_DISABLED",
            message:
              "Google Calendar API is not enabled in your Google Cloud Project. Please enable it in Google Cloud Console:\nhttps://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=715239477880",
          };
        }
        if (/insufficient.*(?:scope|permission)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(msg)) {
          return {
            ok: false,
            error: "SCOPE_MISSING",
            message:
              "Calendar permission not granted in current token. Re-run 'node connect-classroom.js' to grant Calendar access.",
          };
        }
      }

      return {
        ok: false,
        error: `HTTP_${response.status}`,
        message: `Google Calendar returned error ${response.status}: ${msg.slice(0, 200)}`,
      };
    }

    const json = await response.json();
    const items = json.items || [];

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfToday = startOfToday + 24 * 60 * 60 * 1000;

    const events = items.map((item) => {
      const isAllDay = !item.start?.dateTime && Boolean(item.start?.date);
      const startIso = item.start?.dateTime || item.start?.date || "";
      const endIso = item.end?.dateTime || item.end?.date || "";
      const startTimeMs = startIso ? new Date(startIso).getTime() : 0;
      const isToday = startTimeMs >= startOfToday && startTimeMs < endOfToday;

      return {
        id: item.id,
        title: item.summary || "Untitled Event",
        description: item.description || "",
        location: item.location || "",
        startIso,
        endIso,
        isAllDay,
        timeFormatted: formatEventTime(startIso, isAllDay),
        isToday,
        meetLink: item.hangoutLink || "",
        link: item.htmlLink || "",
      };
    });

    const todayEvents = events.filter((e) => e.isToday);
    const upcomingEvents = events.filter((e) => !e.isToday);

    cachedEvents = {
      timestamp: Date.now(),
      data: { events, todayEvents, upcomingEvents },
    };

    return {
      ok: true,
      events,
      todayEvents,
      upcomingEvents,
    };
  } catch (err) {
    return {
      ok: false,
      error: "FETCH_FAILED",
      message: `Failed to fetch calendar events: ${err.message}`,
    };
  }
}

module.exports = {
  isConnected,
  fetchUpcomingEvents,
  formatEventTime,
};
