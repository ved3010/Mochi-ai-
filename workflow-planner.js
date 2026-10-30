"use strict";

const googleClassroom = require("./google-classroom");
const gmailService = require("./gmail-service");
const unstopService = require("./unstop-service");
const calendarService = require("./calendar-service");

/**
 * Gathers all data streams: Classroom, Calendar, Gmail, Unstop, and local tasks.
 */
async function aggregateUserData(localTasks = [], localReminders = []) {
  const [classroomData, calendarResult, emailResult, unstopData] = await Promise.all([
    (async () => {
      try {
        if (!googleClassroom.isConnected()) {
          return { connected: false, summary: "Google Classroom is not connected." };
        }
        const cached = googleClassroom.loadCachedClassroom();
        const live = await googleClassroom.fetchAssignments().catch(() => null);
        const data = live?.ok ? live : cached;
        return {
          connected: true,
          pending: data?.pendingAssignments || data?.assignments || [],
          courses: data?.courses || [],
          total: data?.totalCount || 0,
        };
      } catch (e) {
        return { connected: false, error: e.message };
      }
    })(),
    calendarService.fetchUpcomingEvents({ maxResults: 15, days: 7 }).catch(() => ({ ok: false, events: [] })),
    gmailService.fetchImportantEmails().catch(() => ({ ok: false, emails: [] })),
    unstopService.getAllFeaturedOpportunities().catch(() => ({ hackathons: [], competitions: [] })),
  ]);

  return {
    classroom: classroomData,
    calendar: calendarResult?.ok ? calendarResult.events : [],
    gmail: emailResult?.ok ? emailResult.emails : [],
    unstop: unstopData,
    tasks: localTasks || [],
    reminders: localReminders || [],
    timestamp: new Date(),
  };
}

/**
 * Formats aggregated user data into a clean text block for LLM prompt context.
 */
function buildContextString(data) {
  const lines = [];

  // 1. Google Classroom
  lines.push("### 1. GOOGLE CLASSROOM");
  if (data.classroom.connected) {
    const pending = data.classroom.pending || [];
    if (pending.length > 0) {
      lines.push(`Total Pending Assignments: ${pending.length}`);
      pending.forEach((a, i) => {
        lines.push(`  ${i + 1}. "${a.title}" (${a.courseName}) — Due: ${a.dueDateFormatted || "No date"}${a.isOverdue ? " [OVERDUE!]" : ""}`);
      });
    } else {
      lines.push("All assignments are turned in! No pending coursework.");
    }
  } else {
    lines.push("Status: Not connected (connect Google Classroom to sync live college courses & assignments).");
  }

  // 2. Gmail
  lines.push("\n### 2. GMAIL INBOX");
  if (data.gmail && data.gmail.length > 0) {
    const urgent = data.gmail.filter((e) => e.isUrgent);
    if (urgent.length > 0) {
      lines.push("Urgent College / Work Notices:");
      urgent.forEach((e) => {
        lines.push(`  - [${e.from}] ${e.subject} (${e.date})`);
      });
    }
    const others = data.gmail.filter((e) => !e.isUrgent);
    if (others.length > 0) {
      lines.push("Recent Unread Emails:");
      others.slice(0, 3).forEach((e) => {
        lines.push(`  - [${e.from}] ${e.subject}`);
      });
    }
  } else {
    lines.push("No urgent unread emails detected.");
  }

  // 3. Unstop Opportunities
  lines.push("\n### 3. LIVE UNSTOP HACKATHONS & COMPETITIONS");
  const hackathons = data.unstop?.hackathons || [];
  const competitions = data.unstop?.competitions || [];
  if (hackathons.length > 0) {
    lines.push("Top Active Hackathons:");
    hackathons.slice(0, 3).forEach((h) => {
      lines.push(`  - **${h.title}** by ${h.org} (Closes in ${h.daysRemaining} days${h.prize ? ` · ${h.prize}` : ""})`);
    });
  }
  if (competitions.length > 0) {
    lines.push("Top Coding Challenges & Quizzes:");
    competitions.slice(0, 2).forEach((c) => {
      lines.push(`  - **${c.title}** by ${c.org} (Closes in ${c.daysRemaining} days)`);
    });
  }

  // 4. Local Kittu Tasks
  lines.push("\n### 4. USER'S EXISTING TODO TASKS");
  const openTasks = (data.tasks || []).filter((t) => !t.completed);
  if (openTasks.length > 0) {
    openTasks.forEach((t, i) => {
      lines.push(`  ${i + 1}. ${t.title}`);
    });
  } else {
    lines.push("No current manual tasks recorded in Kittu.");
  }

  // 5. Google Calendar Schedule
  lines.push("\n### 5. GOOGLE CALENDAR SCHEDULE (TODAY & UPCOMING)");
  if (data.calendar && data.calendar.length > 0) {
    const today = data.calendar.filter((e) => e.isToday);
    if (today.length > 0) {
      lines.push("Today's Events:");
      today.forEach((e) => {
        const loc = e.location ? ` (Location: ${e.location})` : "";
        lines.push(`  - ${e.timeFormatted}: **${e.title}**${loc}`);
      });
    } else {
      lines.push("No events scheduled for today.");
    }
    const upcoming = data.calendar.filter((e) => !e.isToday);
    if (upcoming.length > 0) {
      lines.push("Upcoming Events (Next Few Days):");
      upcoming.slice(0, 4).forEach((e) => {
        lines.push(`  - ${e.timeFormatted}: **${e.title}**`);
      });
    }
  } else {
    lines.push("No upcoming events found on primary calendar.");
  }

  return lines.join("\n");
}

/**
 * Builds the specialized prompt for generating a systematic workflow and daily plan.
 */
function buildWorkflowPrompt(contextText, userQuery = "", options = {}) {
  const isMochi = options.companionType !== "cat";
  const name = options.companionName || (isMochi ? "Mochi" : "Kittu");
  const role = isMochi ? "cute, ultra-smart desktop blob AI productivity coach" : "ultra-smart, supportive desktop cat AI productivity coach";
  const now = new Date();
  const timeString = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return [
    `Today is ${timeString}.`,
    "",
    "Below is the live data fetched across the user's Google Classroom, Gmail, Unstop, and tasks:",
    "",
    contextText,
    "",
    `User Request: "${userQuery || "Give me a systematic workflow and the best tasklist plan for today."}"`,
    "",
    "INSTRUCTIONS:",
    `You are ${name}, an ${role}.`,
    "Using the real data above, generate a systematic, highly motivating daily workflow and best task list.",
    "Structure your response exactly as follows:",
    "",
    "1. **High-Priority & Urgent Deadlines** (Top 1–3 items that MUST get done first, with specific course/title)",
    "2. **Systematic Daily Workflow (Time-Blocked Sprint)** (Break the day into realistic 25–45 min Pomodoro blocks)",
    "3. **Career & Growth Target** (Pick the 1 best Unstop hackathon or competition for them to check out or register for)",
    `4. **${name}'s Tip & Energy Check** (Friendly, supportive motivation, reminding them to take breaks)`,
    "",
    "Do not include emojis in priority labels or headings (use clean text labels: Urgent, High, Medium, Low).",
    "Format actionable items with clean markdown checkboxes (`- [ ]`). Keep it structured, clear, and actionable!",
  ].join("\n");
}

module.exports = {
  aggregateUserData,
  buildContextString,
  buildWorkflowPrompt,
};
