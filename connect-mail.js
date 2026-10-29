"use strict";

const gmailService = require("./gmail-service");
const googleClassroom = require("./google-classroom");

console.log("==================================================");
console.log("          FURRY: CHECKING GMAIL INBOX             ");
console.log("==================================================\n");

if (!googleClassroom.isConnected()) {
  console.log("Google account is not connected yet.");
  console.log("Run: node connect-classroom.js to sign in.\n");
  process.exit(1);
}

console.log("Fetching your recent unread and important emails...\n");

gmailService.fetchImportantEmails({ maxResults: 10, forceRefresh: true }).then((res) => {
  if (!res.ok) {
    if (res.message && res.message.includes("disabled")) {
      console.log("⚠️  GMAIL API NEEDS TO BE ENABLED ONCE IN GOOGLE CONSOLE:");
      console.log("👉 Open this direct link in your browser and click 'ENABLE':");
      console.log("https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=715239477880\n");
      process.exit(1);
    }
    console.error("Failed to fetch emails:", res.message || res.error);
    process.exit(1);
  }

  const emails = res.emails || [];
  if (emails.length === 0) {
    console.log("🎉 You're all caught up! 0 unread emails in your inbox.\n");
    process.exit(0);
  }

  console.log(`Found ${emails.length} recent unread emails:\n`);
  emails.forEach((e, i) => {
    const badge = e.isUrgent ? "🚨 [URGENT/DEADLINE]" : "✉️ ";
    console.log(`[${i + 1}] ${badge} ${e.subject}`);
    console.log(`    From: ${e.from}`);
    if (e.date) console.log(`    Date: ${e.date}`);
    if (e.snippet) console.log(`    Preview: ${e.snippet.slice(0, 100)}...`);
    console.log(`    Link: ${e.link}\n`);
  });

  process.exit(0);
}).catch((err) => {
  console.error("Error checking Gmail:", err.message);
  process.exit(1);
});
