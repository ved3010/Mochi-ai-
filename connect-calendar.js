"use strict";

const calendarService = require("./calendar-service");
const googleClassroom = require("./google-classroom");

console.log("==================================================");
console.log("          FURRY: CHECKING GOOGLE CALENDAR         ");
console.log("==================================================\n");

if (!googleClassroom.isConnected()) {
  console.log("Google account is not connected yet.");
  console.log("Run: node connect-classroom.js to sign in.\n");
  process.exit(1);
}

console.log("Fetching your scheduled Google Calendar events for the next 7 days...\n");

calendarService.fetchUpcomingEvents({ maxResults: 15, days: 7, forceRefresh: true }).then((res) => {
  if (!res.ok) {
    if (res.message && res.message.includes("calendar-json.googleapis.com")) {
      console.log("⚠️  GOOGLE CALENDAR API NEEDS TO BE ENABLED ONCE IN GOOGLE CLOUD:");
      console.log("👉 Open this direct link in your browser and click 'ENABLE':");
      console.log("https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=715239477880\n");
      process.exit(1);
    }
    if (res.error === "SCOPE_MISSING") {
      console.log("⚠️  CALENDAR SCOPE NOT IN CURRENT TOKEN:");
      console.log("👉 Run: node connect-classroom.js to re-authorize with Calendar access.\n");
      process.exit(1);
    }
    console.error("Failed to fetch calendar events:", res.message || res.error);
    process.exit(1);
  }

  const events = res.events || [];
  if (events.length === 0) {
    console.log("Your Google Calendar has no events scheduled in the next 7 days.\n");
    process.exit(0);
  }

  console.log(`Found ${events.length} event(s) in your Google Calendar:\n`);
  events.forEach((e, i) => {
    const todayMarker = e.isToday ? "[TODAY] " : "";
    console.log(`[${i + 1}] ${todayMarker}${e.title}`);
    console.log(`    When: ${e.timeFormatted}`);
    if (e.location) console.log(`    Location: ${e.location}`);
    if (e.meetLink) console.log(`    Google Meet: ${e.meetLink}`);
    if (e.link) console.log(`    Link: ${e.link}\n`);
  });

  process.exit(0);
}).catch((err) => {
  console.error("Error checking calendar:", err.message);
  process.exit(1);
});
