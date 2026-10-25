"use strict";

// Deliberately small, anchored grammar. Unknown requests go to the configured
// model; quoted links, negations, and discussion must not become actions.
const HELP = [
  "I can help plan, write, explain, and keep tasks and memories.",
  "Fast commands (no model needed):",
  "• open Unstop / find hackathons on Unstop",
  "• play <song> on Spotify / YouTube / Apple Music",
  "• pause music on Spotify / resume music on Apple Music",
  "• next song on Spotify / what is playing on Spotify",
  "• play <Spotify track link> (desktop Spotify)",
  "• check Google Classroom / sync assignments",
  "• list tasks / add task: <title> / list reminders",
  "• remember <key>: <value>",
  "Opening an app, link, or local path happens immediately. Song names open search results; choose a result to play. Playback controls still need Allow, the desktop app, and macOS Automation permission. Google Classroom assignments can be synced into tasks directly when connected.",
].join("\n");

const APPS = new Map([
  ["safari", "Safari"], ["chrome", "Google Chrome"], ["google chrome", "Google Chrome"],
  ["firefox", "Firefox"], ["brave", "Brave Browser"], ["calculator", "Calculator"],
  ["notes", "Notes"], ["finder", "Finder"], ["terminal", "Terminal"], ["calendar", "Calendar"],
  ["mail", "Mail"], ["messages", "Messages"], ["music", "Music"], ["apple music", "Music"],
  ["spotify", "Spotify"], ["visual studio code", "Visual Studio Code"], ["vs code", "Visual Studio Code"],
  ["vscode", "Visual Studio Code"], ["code", "Visual Studio Code"],
  ["unstop smarthire", "Unstop SmartHire"], ["youtube", "YouTube"],
  ["leetcode", "LeetCode"], ["lead code", "LeetCode"], ["leadcode", "LeetCode"],
  ["discord", "Discord"], ["whatsapp", "WhatsApp"],
  ["classroom", "Google Classroom"], ["google classroom", "Google Classroom"],
  ["claude", "Claude"], ["chatgpt", "ChatGPT"], ["github", "GitHub"],
  ["notion", "Notion"], ["netflix", "Netflix"],
]);

const result = (reply, action = null) => ({ reply, action });
const open = (reply, url) => result(reply, { type: "open_url", url });

function spotifyTrack(value) {
  const uri = String(value).match(/^spotify:track:([A-Za-z0-9]{22})$/);
  if (uri) return `spotify:track:${uri[1]}`;
  try {
    const url = new URL(value);
    const track = url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]{22})\/?$/);
    return url.protocol === "https:" && url.hostname === "open.spotify.com" && !url.username && !url.password && track
      ? `spotify:track:${track[1]}` : null;
  } catch { return null; }
}

function inferShortcut(message, context = {}) {
  const text = String(message || "").trim().replace(/^(?:please\s+|can you\s+|could you\s+)/i, "").trim();
  if (/^(?:help|what can you do)[?! .]*$/i.test(text)) return result(HELP);
  if (/^(?:hi|hey|hello|yo|sup|what's up)[!. ]*$/i.test(text)) return result("Hey! I'm here and ready to help. What would you like to work on?");
  if (/^(?:good morning|good afternoon|good evening)[!. ]*$/i.test(text)) return result("Hello! I'm ready to help. What are we working on?");
  if (/^(?:thanks|thank you|thx)[!. ]*$/i.test(text)) return result("You're welcome! Let me know what you need next.");
  if (/^(?:who are you|what are you|who|what)[?.! ]*$/i.test(text)) {
    const isMochi = context && context.companionType === "mochi";
    const name = (context && context.companionName) || (isMochi ? "Mochi" : "Kittu");
    if (isMochi) {
      return result(`I'm ${name}, your cute personal desktop blob companion! I can answer questions, explain ideas, help plan work, remember things you ask me to remember, and handle approved desktop tasks.`);
    }
    return result("I'm your personal desktop cat assistant. I can answer questions, explain ideas, help plan work, remember things you ask me to remember, and handle approved desktop tasks.");
  }
  if (/^(?:how are you|how's it going)[?.! ]*$/i.test(text)) return result("I'm ready and listening. Tell me what you need help with.");
  if (/^(?:list|show)(?: my)? (?:open )?tasks[?.!]*$/i.test(text) || /^my tasks[?.!]*$/i.test(text)) {
    return result("", { type: "list_tasks" });
  }
  if (/^(?:list|show)(?: my)? reminders[?.!]*$/i.test(text)) return result("", { type: "list_reminders" });

  const workflowMatch =
    /\b(?:workflow|tasklist|task\s*list|to-?do\s*list|daily plan|study plan|plan my day|schedule my day|perfect plan|organize my day|best task)\b|\b(?:what(?:'s| is) remaining|check my status|status.*remaining)\b/i.test(text);
  if (workflowMatch) {
    return result("", { type: "generate_workflow" });
  }

  const classroomMatch =
    /(?:check|get|fetch|show|read|sync|list|save|import)\b.*?\b(?:google\s+classroom|classroom)\b|\b(?:google\s+classroom|classroom)\b.*?\b(?:assignments?|tasks?|homework|deadlines?|details|check|sync|subjects?|courses?)\b|\bhow many (?:subjects?|courses?|assignments?)\b.*?\b(?:google\s+classroom|classroom)\b/i.test(text);
  if (classroomMatch && !/^(?:open|launch|start|visit|go to)\b/i.test(text)) {
    return result("", { type: "check_classroom" });
  }

  const gmailMatch =
    /\b(?:check|read|fetch|show|list)\b.*?\b(?:gmail|emails?|inbox|messages?)\b|\b(?:gmail|emails?)\b.*?\b(?:unread|urgent|notices?|deadlines?)\b/i.test(text);
  if (gmailMatch && !/^(?:open|launch|start|visit|go to)\b/i.test(text)) {
    return result("", { type: "check_gmail" });
  }

  const unstopLiveMatch =
    /\b(?:fetch|get|check|show|list)\b.*?\b(?:hackathons?|competitions?|contests?)\b.*?\b(?:unstop)?\b/i.test(text)
    && !/^(?:open|visit|go to)\b/i.test(text);
  if (unstopLiveMatch) {
    return result("", { type: "check_unstop" });
  }

  const calendarMatch =
    /\b(?:check|read|fetch|show|list|get|view)\b.*?\b(?:calendar|events?|schedule|meetings?|appointments?)\b|\b(?:calendar|schedule)\b.*?\b(?:today|tomorrow|this week|upcoming|check|events?)\b|\bwhat(?:'s| is) on my (?:calendar|schedule)\b|^(?:my\s+)?(?:calendar|schedule)[?!.]*$/i.test(text);
  if (calendarMatch && !/^(?:open|launch|start|visit|go to)\b/i.test(text)) {
    return result("", { type: "check_calendar" });
  }

  if (/^(?:open|visit|go to)\s+(?:google\s+)?calendar[.!]?$/i.test(text)) {
    return open("Open Google Calendar in your browser.", "https://calendar.google.com/");
  }

  let match = text.match(/^(?:add|create|new)\s+(?:a\s+)?(urgent|high(?: priority)?|medium|low(?: priority)?)?\s*(?:task|todo)(?:\s*:\s*|\s+)(.+)$/i);
  if (match) {
    let rawPriority = (match[1] || "").toLowerCase().replace(/\s+priority/g, "").trim();
    let title = match[2].trim();
    const endPriorityMatch = title.match(/(?:\[?\s*priority\s*:\s*(urgent|high|medium|low)\s*\]?|\s*\[(urgent|high|medium|low)\])$/i);
    if (endPriorityMatch) {
      rawPriority = (endPriorityMatch[1] || endPriorityMatch[2]).toLowerCase();
      title = title.slice(0, endPriorityMatch.index).trim();
    }
    const action = { type: "create_task", title };
    if (rawPriority && ["urgent", "high", "medium", "low"].includes(rawPriority)) {
      action.priority = rawPriority;
    }
    return result("", action);
  }

  match = text.match(/^(?:complete|finish|check off|done with)\s+(?:task|todo)\s*:\s*(.+)$/i);
  if (match) return result("", { type: "complete_task", id: match[1].trim() });

  match = text.match(/^remember\s+([^:\n]{1,80}):\s*(.+)$/i);
  if (match) return result("", { type: "remember", key: match[1].trim(), value: match[2].trim() });

  match = text.match(/^(?:open|launch|start)\s+(?:the )?(.+?)(?: app)?[.!]?$/i);
  if (match && APPS.has(match[1].toLowerCase())) {
    const name = APPS.get(match[1].toLowerCase());
    return result(`I can open ${name}.`, { type: "open_app", name });
  }

  if (/^(?:open|visit|go to) unstop[.!]?$/i.test(text)) {
    return open("Open Unstop in your browser. Use your own login there; I am not signed in to your account.", "https://unstop.com/");
  }
  match = text.match(/^(?:find|search(?: for)?|show(?: me)?|browse|open)\s+(.+?)\s+on unstop[.!]?$/i);
  if (match) {
    const query = match[1].trim();
    const categories = { hackathons: "hackathons", internships: "internships", jobs: "jobs", competitions: "competitions" };
    const category = categories[query.toLowerCase()];
    return open(category ? `Open Unstop ${category}. You can review opportunities and apply there.`
      : `Search public Unstop listings for “${query}” in your browser (Google site search).`,
    category ? `https://unstop.com/${category}` : `https://www.google.com/search?q=${encodeURIComponent(`site:unstop.com ${query}`)}`);
  }

  match = text.match(/^(pause|resume|next|previous|skip)(?: (?:the )?(?:music|song|track))?(?: (?:on|in) (spotify|apple music|music))?[.!]?$/i);
  if (match && (match[2] || /\b(music|song|track)\b/i.test(text))) {
    const player = match[2]?.toLowerCase() === "spotify" ? "spotify" : match[2] ? "music" : null;
    if (!player) return result("Which app? Try “pause music on Spotify” or “resume music on Apple Music”.");
    const command = match[1].toLowerCase() === "skip" ? "next" : match[1].toLowerCase();
    return result(`I can ${command} playback in ${player === "spotify" ? "Spotify" : "Music"}.`, { type: "music_control", player, command });
  }
  match = text.match(/^(?:what(?:'s| is) playing|now playing) on (spotify|apple music|music)[?.!]?$/i);
  if (match) return result("Check the desktop player's current track?", {
    type: "music_control", player: match[1].toLowerCase() === "spotify" ? "spotify" : "music", command: "status",
  });

  match = text.match(/^play\s+(\S+)$/i);
  if (match && spotifyTrack(match[1])) return result("Play this Spotify track in the desktop app?", {
    type: "music_control", player: "spotify", command: "play_track", uri: spotifyTrack(match[1]),
  });
  if (/^play (?:some )?music[.!]?$/i.test(text)) {
    return open("Open YouTube Music to choose a song. Or ask “play <song> on Spotify”.", "https://music.youtube.com/");
  }
  match = text.match(/^(?:play|search(?: for)?|find)\s+(.+?)\s+(?:on|in)\s+(spotify|youtube music|youtube|apple music)$/i);
  if (match) {
    const query = match[1].trim();
    const provider = match[2].toLowerCase();
    const urls = {
      spotify: `https://open.spotify.com/search/${encodeURIComponent(query)}`,
      youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      "youtube music": `https://music.youtube.com/search?q=${encodeURIComponent(query)}`,
      "apple music": `https://music.apple.com/us/search?term=${encodeURIComponent(query)}`,
    };
    return open(`Search ${match[2]} for “${query}”. Choose the matching result to play; this does not start playback automatically.`, urls[provider]);
  }
  match = text.match(/^play\s+(.+)$/i);
  if (match && !/\b(?:on|in)\s+\S+/i.test(match[1])) {
    return open(`Search YouTube for “${match[1]}”. Select a result to play.`, `https://www.youtube.com/results?search_query=${encodeURIComponent(match[1])}`);
  }
  if (/^(?:open|visit|go to) youtube[.!]?$/i.test(text)) return open("Open YouTube?", "https://www.youtube.com/");
  // A URL occurring in a question is not permission to open it.
  match = text.match(/^(?:open|visit|go to)\s+(https?:\/\/\S+)$/i);
  if (match) {
    try {
      const url = new URL(match[1]);
      if (url.username || url.password) return null;
      return open("Open this page in your browser?", url.toString());
    } catch { return null; }
  }

  // Opening apps is intentionally a fast, no-confirmation path. Keep the
  // grammar explicit enough that multi-step requests do not launch a guessed
  // application name, while allowing apps outside the small common-app map.
  match = text.match(/^(?:open|launch|start)\s+(?:the\s+)?app(?:lication)?\s+(.+?)[.!]?$/i)
    || text.match(/^(?:open|launch|start)\s+(?:the\s+)?(.+?)(?:\s+app)?[.!]?$/i);
  if (match) {
    const name = match[1].trim();
    if (!name || /\b(?:and|then)\b/i.test(name)) return null;
    if (/^(?:~\/|\.\.?(?:\/|$)|\/)/.test(name)) {
      return result(`Opening ${name}.`, { type: "open_path", path: name });
    }
    return result(`Opening ${name}.`, { type: "open_app", name });
  }
  return null;
}

module.exports = { inferShortcut, spotifyTrack };
