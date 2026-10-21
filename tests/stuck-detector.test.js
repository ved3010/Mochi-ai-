"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const stuckDetector = require("../stuck-detector");

test("stuck-detector: App classification for work apps vs other", async (t) => {
  // 1. Word
  assert.equal(stuckDetector.classifyApp("WINWORD.EXE", "Document1 - Word"), "work app");
  assert.equal(stuckDetector.classifyApp("Microsoft Word", "Report.docx"), "work app");
  assert.equal(stuckDetector.classifyApp("writer.exe", "Notes - LibreOffice Writer"), "work app");
  assert.equal(stuckDetector.classifyApp("chrome.exe", "Proposal - Word Online - Google Chrome"), "work app");

  // 2. Google Docs
  assert.equal(stuckDetector.classifyApp("chrome.exe", "Meeting Notes - Google Docs - Google Chrome"), "work app");
  assert.equal(stuckDetector.classifyApp("msedge.exe", "docs.google.com/document/d/123"), "work app");
  assert.equal(stuckDetector.classifyApp("google docs", "Untitled document"), "work app");

  // 3. VS Code / Code Editors
  assert.equal(stuckDetector.classifyApp("Code.exe", "stuck-detector.js - Furry - Visual Studio Code"), "work app");
  assert.equal(stuckDetector.classifyApp("Cursor.exe", "main.js - Furry"), "work app");
  assert.equal(stuckDetector.classifyApp("vscodium.exe", "index.ts - VSCodium"), "work app");
  assert.equal(stuckDetector.classifyApp("windsurf.exe", "App.tsx"), "work app");

  // 4. PDF Reader
  assert.equal(stuckDetector.classifyApp("AcroRd32.exe", "manual.pdf - Adobe Acrobat Reader"), "work app");
  assert.equal(stuckDetector.classifyApp("SumatraPDF.exe", "book.pdf"), "work app");
  assert.equal(stuckDetector.classifyApp("msedge.exe", "whitepaper.pdf - Personal - Microsoft Edge"), "work app");
  assert.equal(stuckDetector.classifyApp("foxit.exe", "document.pdf"), "work app");

  // 5. Notes
  assert.equal(stuckDetector.classifyApp("notepad.exe", "Untitled - Notepad"), "work app");
  assert.equal(stuckDetector.classifyApp("Obsidian.exe", "My Vault - Obsidian v1.5"), "work app");
  assert.equal(stuckDetector.classifyApp("Notion.exe", "Project Roadmap - Notion"), "work app");
  assert.equal(stuckDetector.classifyApp("ONENOTE.EXE", "Work Notebook - OneNote"), "work app");
  assert.equal(stuckDetector.classifyApp("notepad++.exe", "script.py - Notepad++"), "work app");

  // 6. Other / Non-work
  assert.equal(stuckDetector.classifyApp("chrome.exe", "YouTube - Funny Cat Videos - Google Chrome"), "other");
  assert.equal(stuckDetector.classifyApp("Spotify.exe", "Spotify Premium"), "other");
  assert.equal(stuckDetector.classifyApp("Steam.exe", "Steam"), "other");
  assert.equal(stuckDetector.classifyApp("Discord.exe", "Discord | #general"), "other");
  assert.equal(stuckDetector.classifyApp("explorer.exe", "Downloads"), "other");
});

test("stuck-detector: Privacy verification - key activity records only timestamp", async (t) => {
  const before = Date.now();
  stuckDetector.recordKeyActivity({
    keycode: 42,
    rawcode: 100,
    char: "A",
    key: "SuperSecretPassword123!",
  });
  const after = Date.now();

  const lastKeyTime = stuckDetector.getLastKeyTime();
  const lastActivityTime = stuckDetector.getLastActivityTime();

  assert.ok(lastKeyTime >= before && lastKeyTime <= after);
  assert.ok(lastActivityTime >= before && lastActivityTime <= after);

  // stuck-detector exports no key content and holds no key buffer
  assert.equal(typeof stuckDetector.getCurrentKey, "undefined");
  assert.equal(typeof stuckDetector.keyLogs, "undefined");
  assert.equal(typeof stuckDetector.keyContent, "undefined");
});

test("stuck-detector: Separate tracking - mouse/other activity does NOT update lastKeyTime", async (t) => {
  const pastTime = Date.now() - 60000;
  stuckDetector._setTestState({
    lastKeyTime: pastTime,
    lastActivityTime: pastTime,
  });

  // Non-keyboard activity occurs (e.g. mouse move/click)
  stuckDetector.recordOtherActivity();

  assert.equal(stuckDetector.getLastKeyTime(), pastTime, "lastKeyTime should remain unchanged by non-keyboard input");
  assert.ok(stuckDetector.getLastActivityTime() > pastTime, "lastActivityTime should be updated");
});

test("stuck-detector: PROOF that stuck can happen in NORMAL MODE using mocked time", async (t) => {
  // Normal mode: 8m for maybe_stuck, 5m no keyboard + 6 window switches in 2m for stuck
  stuckDetector.toggleDemoMode(false);
  assert.equal(stuckDetector.isDemoMode(), false);

  const now = Date.now();
  // Simulated timeline:
  // - No keyboard typing for 5 minutes and 10 seconds (e.g. user stopped typing in VS Code)
  // - Mouse/window activity occurred recently (30 seconds ago), so user is NOT completely idle
  // - 6 window switches in the last 2 minutes (e.g. browsing Stack Overflow, switching between docs and IDE)
  const windowSwitchesIn2Min = [
    now - 90 * 1000,
    now - 75 * 1000,
    now - 60 * 1000,
    now - 45 * 1000,
    now - 30 * 1000,
    now - 15 * 1000,
  ];

  stuckDetector._setTestState({
    currentState: "active",
    currentAppType: "work app",
    currentAppName: "Code.exe",
    lastKeyTime: now - (5 * 60 * 1000 + 10 * 1000), // 5m 10s without keyboard
    lastActivityTime: now - 15 * 1000, // Recent window/mouse activity (15s ago)
    windowSwitches: windowSwitchesIn2Min,
    isDemoMode: false,
  });

  stuckDetector._evaluateState();

  // PROOF: In normal mode, state evaluates to STUCK!
  assert.equal(
    stuckDetector.getState(),
    "stuck",
    "stuck state MUST be triggered in normal mode when 6+ window switches in 2m and no keyboard activity for >= 5 minutes"
  );
});

test("stuck-detector: Normal mode maybe_stuck = no activity of any kind for 8 minutes in a work app", async (t) => {
  stuckDetector.toggleDemoMode(false);
  const now = Date.now();

  // 1. Inactivity in work app for 8m 5s with < 6 switches -> maybe_stuck
  stuckDetector._setTestState({
    currentState: "active",
    currentAppType: "work app",
    currentAppName: "Code.exe",
    lastKeyTime: now - (8 * 60 * 1000 + 5000),
    lastActivityTime: now - (8 * 60 * 1000 + 5000),
    windowSwitches: [now - 30000], // only 1 switch
    isDemoMode: false,
  });
  stuckDetector._evaluateState();
  assert.equal(stuckDetector.getState(), "maybe_stuck");

  // 2. Inactivity in non-work app ('other') for 8m 5s -> remains active
  stuckDetector._setTestState({
    currentState: "active",
    currentAppType: "other",
    currentAppName: "Spotify.exe",
    lastKeyTime: now - (8 * 60 * 1000 + 5000),
    lastActivityTime: now - (8 * 60 * 1000 + 5000),
    windowSwitches: [],
    isDemoMode: false,
  });
  stuckDetector._evaluateState();
  assert.equal(stuckDetector.getState(), "active");
});

test("stuck-detector: Demo mode thresholds (15s for 8-min rule, 10s for 5-min rule)", async (t) => {
  stuckDetector.toggleDemoMode(true);
  assert.equal(stuckDetector.isDemoMode(), true);

  const now = Date.now();

  // Demo maybe_stuck: 15s no activity in work app
  stuckDetector._setTestState({
    currentState: "active",
    currentAppType: "work app",
    currentAppName: "notepad.exe",
    lastKeyTime: now - 16000,
    lastActivityTime: now - 16000,
    windowSwitches: [],
    isDemoMode: true,
  });
  stuckDetector._evaluateState();
  assert.equal(stuckDetector.getState(), "maybe_stuck");

  // Demo stuck: 6 window switches in 2 min + no keyboard for 10s (even with recent mouse/window activity)
  const switches = [
    now - 50000,
    now - 40000,
    now - 30000,
    now - 20000,
    now - 10000,
    now - 2000,
  ];
  stuckDetector._setTestState({
    currentState: "active",
    currentAppType: "work app",
    currentAppName: "notepad.exe",
    lastKeyTime: now - 11000, // 11s no keyboard
    lastActivityTime: now - 2000, // recent mouse activity 2s ago
    windowSwitches: switches,
    isDemoMode: true,
  });
  stuckDetector._evaluateState();
  assert.equal(stuckDetector.getState(), "stuck");

  // Typing on keyboard immediately resets state to active
  stuckDetector.recordKeyActivity();
  assert.equal(stuckDetector.getState(), "active");

  stuckDetector.toggleDemoMode(false);
});

test("stuck-detector: Window switches older than 2 minutes are pruned", async (t) => {
  const now = Date.now();
  stuckDetector._setTestState({
    windowSwitches: [
      now - (3 * 60 * 1000), // 3 min ago - pruned
      now - (2.5 * 60 * 1000), // 2.5 min ago - pruned
      now - (1 * 60 * 1000), // 1 min ago - retained
      now - (10 * 1000), // 10s ago - retained
    ],
  });

  assert.equal(stuckDetector.getWindowSwitchesCount(), 2);
});

test("stuck-detector: onStateChange callback listener dispatches details", async (t) => {
  const dispatched = [];
  const unsubscribe = stuckDetector.onStateChange((newState, oldState, meta) => {
    dispatched.push({ newState, oldState, meta });
  });

  const now = Date.now();
  stuckDetector._setTestState({
    currentState: "active",
    currentAppType: "work app",
    currentAppName: "Code.exe",
    lastKeyTime: now - (5 * 60 * 1000 + 5000),
    lastActivityTime: now - 10000,
    windowSwitches: [now - 50000, now - 40000, now - 30000, now - 20000, now - 10000, now - 2000],
    isDemoMode: false,
  });
  stuckDetector._evaluateState();

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].newState, "stuck");
  assert.equal(dispatched[0].oldState, "active");
  assert.equal(dispatched[0].meta.appType, "work app");
  assert.equal(dispatched[0].meta.windowSwitchesLast2Min, 6);

  unsubscribe();
});

test("stuck-detector: Work apps expansion - Antigravity, Windows Terminal, Cursor, Windsurf, browser tabs (Docs, Notion, PDF)", async (t) => {
  // Antigravity
  assert.equal(stuckDetector.classifyApp("antigravity.exe", "Antigravity IDE - main.js"), "work app");
  assert.equal(stuckDetector.classifyApp("chrome.exe", "Antigravity - Coding Task"), "work app");

  // Windows Terminal
  assert.equal(stuckDetector.classifyApp("wt.exe", "PowerShell"), "work app");
  assert.equal(stuckDetector.classifyApp("WindowsTerminal.exe", "Windows Terminal"), "work app");
  assert.equal(stuckDetector.classifyApp("cmd.exe", "Windows Terminal - Administrator"), "work app");

  // Cursor & Windsurf
  assert.equal(stuckDetector.classifyApp("Cursor.exe", "stuck-detector.js - Furry"), "work app");
  assert.equal(stuckDetector.classifyApp("windsurf.exe", "workspace - Windsurf"), "work app");

  // Browser tabs: Google Docs
  assert.equal(stuckDetector.classifyApp("chrome.exe", "Architecture Plan - Google Docs - Google Chrome"), "work app");
  assert.equal(stuckDetector.classifyApp("firefox.exe", "docs.google.com/document/d/xyz"), "work app");

  // Browser tabs: Notion
  assert.equal(stuckDetector.classifyApp("chrome.exe", "Product Roadmap - Notion - Google Chrome"), "work app");
  assert.equal(stuckDetector.classifyApp("msedge.exe", "Sprint Tasks - Notion"), "work app");

  // Problem Solving & Coding platforms (LeetCode, HackerRank, Codeforces, Kaggle)
  assert.equal(stuckDetector.classifyApp("chrome.exe", "Two Sum - LeetCode - Google Chrome"), "work app");
  assert.equal(stuckDetector.classifyApp("firefox.exe", "Solve Algorithms | HackerRank"), "work app");
  assert.equal(stuckDetector.classifyApp("msedge.exe", "Problem - 1000A - Codeforces"), "work app");
  assert.equal(stuckDetector.classifyApp("brave.exe", "Titanic - Machine Learning from Disaster | Kaggle"), "work app");

  // Other IDEs & Editors (PyCharm, IntelliJ, Sublime Text)
  assert.equal(stuckDetector.classifyApp("pycharm64.exe", "main.py - project"), "work app");
  assert.equal(stuckDetector.classifyApp("idea64.exe", "MyService.java - IntelliJ IDEA"), "work app");
  assert.equal(stuckDetector.classifyApp("sublime_text.exe", "script.js - Sublime Text"), "work app");
});

test("stuck-detector: Video / lecture window (keywords or full display) enters watching and NEVER triggers stuck", async (t) => {
  stuckDetector.stopManualModes();
  stuckDetector.toggleDemoMode(false);

  // Setup mock display for screen bounds testing (display: 1920x1080)
  stuckDetector.setMockScreen({
    getAllDisplays: () => [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      },
    ],
  });

  // (1) Priority order: a Google Doc titled 'Lecture notes' is NOT watching
  const googleDocLecture = stuckDetector.isWatchingContext(
    "chrome.exe",
    "Lecture notes - Google Docs - Google Chrome"
  );
  assert.equal(googleDocLecture, false, "Google Doc titled 'Lecture notes' must NOT be watching");

  // Other work apps containing lecture/meet/teams in title must NOT be watching
  assert.equal(
    stuckDetector.isWatchingContext("Code.exe", "teams-controller.ts - Visual Studio Code"),
    false,
    "IDE with 'teams' in title must NOT be watching"
  );
  assert.equal(
    stuckDetector.isWatchingContext("notepad.exe", "Meet agenda.txt - Notepad"),
    false,
    "Notepad with 'Meet' in title must NOT be watching"
  );
  assert.equal(
    stuckDetector.isWatchingContext("WINWORD.EXE", "Lecture transcript.docx - Word"),
    false,
    "Word with 'lecture' in title must NOT be watching"
  );
  assert.equal(
    stuckDetector.isWatchingContext("chrome.exe", "Lecture Handout.pdf - Google Chrome"),
    false,
    "PDF with 'Lecture' in title must NOT be watching"
  );

  // (2) A maximized IDE is NOT watching (bounds cover workArea 1040, not full display 1080)
  const maximizedIDEBounds = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.equal(
    stuckDetector.isWatchingContext("Code.exe", "App.tsx - Visual Studio Code", maximizedIDEBounds),
    false,
    "A maximized IDE must NOT be watching"
  );

  // A maximized browser or other window is also NOT treated as fullscreen
  assert.equal(
    stuckDetector.isWatchingContext("chrome.exe", "Some Random Article", maximizedIDEBounds),
    false,
    "A normal maximized window must NOT be treated as fullscreen"
  );

  // (3) A YouTube tab in Chrome IS watching
  const youtubeInChrome = stuckDetector.isWatchingContext(
    "chrome.exe",
    "Machine Learning Course - YouTube - Google Chrome"
  );
  assert.equal(youtubeInChrome, true, "A YouTube tab in Chrome must be watching");

  // YouTube App downloaded from Brave (PWA / proxy / desktop app)
  assert.equal(
    stuckDetector.isWatchingContext("brave_proxy.exe", "Rick Astley - YouTube", null, "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave_proxy.exe"),
    true,
    "Brave PWA proxy for YouTube must be watching"
  );
  assert.equal(
    stuckDetector.isWatchingContext("YouTube", "Never Gonna Give You Up", null, "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    true,
    "YouTube PWA window with app title 'YouTube' must be watching"
  );
  assert.equal(
    stuckDetector.isWatchingContext("YouTube.exe", "Video Player", null),
    true,
    "YouTube standalone app process must be watching"
  );
  assert.equal(
    stuckDetector.isWatchingContext("brave.exe", "YouTube - Home"),
    true,
    "Brave with YouTube title must be watching"
  );

  // (4) A true fullscreen window IS watching (covers 1920x1080 display bounds)
  const trueFullScreenBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.equal(
    stuckDetector.isWatchingContext("someplayer.exe", "Player", trueFullScreenBounds),
    true,
    "A true fullscreen window must be watching"
  );
  assert.equal(
    stuckDetector.isWatchingContext("vlc.exe", "movie.mp4", trueFullScreenBounds),
    true,
    "VLC in true fullscreen must be watching"
  );

  // (5) Whole phrases 'Google Meet' and 'Microsoft Teams' vs bare words 'Meet' or 'Teams'
  // Whole phrases in browser/meeting app:
  assert.equal(
    stuckDetector.isWatchingContext("chrome.exe", "Google Meet - Team Sync - Google Chrome"),
    true,
    "Whole phrase 'Google Meet' must match"
  );
  assert.equal(
    stuckDetector.isWatchingContext("msedge.exe", "Microsoft Teams - Standup - Microsoft Edge"),
    true,
    "Whole phrase 'Microsoft Teams' must match"
  );
  assert.equal(
    stuckDetector.isWatchingContext("Teams.exe", "Standup Chat"),
    true,
    "Teams desktop app must match"
  );

  // Bare words 'Meet' or 'Teams' must NOT match:
  assert.equal(
    stuckDetector.isWatchingContext("chrome.exe", "Engineering Teams - Google Chrome"),
    false,
    "Bare word 'Teams' must NOT trigger watching"
  );
  assert.equal(
    stuckDetector.isWatchingContext("chrome.exe", "Team Meet and Greet - Google Chrome"),
    false,
    "Bare word 'Meet' must NOT trigger watching"
  );

  // Non-browser / non-media apps with keywords must NOT trigger watching
  assert.equal(
    stuckDetector.isWatchingContext("explorer.exe", "Lecture slides"),
    false,
    "Windows Explorer with 'Lecture' must NOT trigger watching"
  );
  assert.equal(
    stuckDetector.isWatchingContext("calc.exe", "Calculator"),
    false,
    "Calculator must NOT trigger watching"
  );

  // (6) Valid media/video contexts
  assert.equal(stuckDetector.isWatchingContext("Zoom.exe", "Zoom Meeting"), true);
  assert.equal(stuckDetector.isWatchingContext("vlc.exe", "recording.mp4"), true);
  assert.equal(stuckDetector.isWatchingContext("firefox.exe", "Coursera - Neural Networks"), true);
  assert.equal(stuckDetector.isWatchingContext("chrome.exe", "NPTEL :: Computer Science - Lecture 04"), true);
  assert.equal(stuckDetector.isWatchingContext("chrome.exe", "Webinar: Modern Web Dev 2026"), true);

  // (7) CRITICAL: A video window in 'other' app NEVER triggers stuck or maybe_stuck
  const now = Date.now();
  const frequentSwitches = [
    now - 100 * 1000,
    now - 80 * 1000,
    now - 60 * 1000,
    now - 40 * 1000,
    now - 20 * 1000,
    now - 5 * 1000,
  ];

  stuckDetector._setTestState({
    currentState: "active",
    currentAppType: "other",
    currentAppName: "chrome.exe",
    isCurrentWindowWatching: true, // e.g. watching YouTube
    lastKeyTime: now - 10 * 60 * 1000, // 10 minutes without typing
    lastActivityTime: now - 10 * 60 * 1000, // 10 minutes inactive
    windowSwitches: frequentSwitches,
    isDemoMode: false,
    manualMode: null,
  });

  stuckDetector._evaluateState();

  // MUST evaluate to 'watching', NEVER 'stuck' or 'maybe_stuck'
  assert.equal(stuckDetector.getState(), "watching");
  assert.notEqual(stuckDetector.getState(), "stuck");
  assert.notEqual(stuckDetector.getState(), "maybe_stuck");
});

test("stuck-detector: Manual modes (Watching & Thinking) block stuck and expire on time", async (t) => {
  stuckDetector.stopManualModes();
  stuckDetector.toggleDemoMode(false);
  const now = Date.now();

  const frequentSwitches = [
    now - 90 * 1000,
    now - 75 * 1000,
    now - 60 * 1000,
    now - 45 * 1000,
    now - 30 * 1000,
    now - 10 * 1000,
  ];

  // --- Watching Mode (30 min) ---
  stuckDetector.setWatchingMode(30);
  assert.equal(stuckDetector.getManualMode(), "watching");
  assert.equal(stuckDetector.getState(), "watching");

  // Attempt to trigger stuck while in Watching mode
  stuckDetector._setTestState({
    currentAppType: "work app",
    currentAppName: "Code.exe",
    isCurrentWindowWatching: false,
    lastKeyTime: now - 10 * 60 * 1000, // 10 min no typing
    lastActivityTime: now - 10 * 60 * 1000,
    windowSwitches: frequentSwitches,
  });
  stuckDetector._evaluateState();

  assert.equal(
    stuckDetector.getState(),
    "watching",
    "Watching mode must block stuck state even under stuck conditions"
  );

  // Expire Watching mode on time (simulated time passing 30 minutes)
  stuckDetector._setTestState({
    manualModeExpiresAt: now - 1000, // expired 1 second ago
  });
  stuckDetector._evaluateState();

  assert.equal(
    stuckDetector.getManualMode(),
    null,
    "Manual mode must auto-expire when duration elapses"
  );
  // After expiration with stuck conditions, it transitions to normal evaluation (stuck)
  assert.equal(stuckDetector.getState(), "stuck");

  // Reset activity
  stuckDetector.recordKeyActivity();
  assert.equal(stuckDetector.getState(), "active");

  // --- Thinking Mode (30 min) ---
  stuckDetector.setThinkingMode(30);
  assert.equal(stuckDetector.getManualMode(), "thinking");
  assert.equal(stuckDetector.getState(), "thinking");

  // Attempt to trigger stuck while in Thinking mode
  stuckDetector._setTestState({
    currentAppType: "work app",
    currentAppName: "Code.exe",
    isCurrentWindowWatching: false,
    lastKeyTime: now - 10 * 60 * 1000,
    lastActivityTime: now - 10 * 60 * 1000,
    windowSwitches: frequentSwitches,
  });
  stuckDetector._evaluateState();

  assert.equal(
    stuckDetector.getState(),
    "thinking",
    "Thinking mode must block stuck state even under stuck conditions"
  );

  // Manual stop
  stuckDetector.stopManualModes();
  assert.equal(stuckDetector.getManualMode(), null);

  // Reset to clean active state
  stuckDetector.recordKeyActivity();
});

test("stuck-detector: markJustThinking doubles inactivity threshold up to 4 times and resets next day", async (t) => {
  stuckDetector.stopManualModes();
  stuckDetector.toggleDemoMode(false);
  const now = Date.now();

  // Reset patience state for today
  stuckDetector._setTestState({
    patienceCount: 0,
    patienceMultiplier: 1,
    patienceDay: "",
  });
  assert.equal(stuckDetector.getPatienceMultiplier(), 1);

  // Base normal maybe_stuck threshold is 8 minutes (480,000 ms).
  // At 9 minutes of inactivity, user would normally be maybe_stuck:
  stuckDetector._setTestState({
    currentState: "active",
    currentAppType: "work app",
    currentAppName: "Code.exe",
    isCurrentWindowWatching: false,
    lastKeyTime: now - 9 * 60 * 1000,
    lastActivityTime: now - 9 * 60 * 1000, // 9 min inactive
    windowSwitches: [],
    isDemoMode: false,
  });
  stuckDetector._evaluateState();
  assert.equal(stuckDetector.getState(), "maybe_stuck");

  // Call markJustThinking(): doubles threshold to 16 minutes (2x)!
  const mult1 = stuckDetector.markJustThinking();
  assert.equal(mult1, 2);
  assert.equal(stuckDetector.getPatienceMultiplier(), 2);

  // Re-evaluating at 9 minutes inactivity with 2x threshold (16 min) -> user is NOT stuck!
  assert.equal(
    stuckDetector.getState(),
    "active",
    "9 minutes inactive is within doubled threshold (16 min), state must return to active"
  );

  // 2nd call: 4x (32 min threshold)
  const mult2 = stuckDetector.markJustThinking();
  assert.equal(mult2, 4);

  // 3rd call: 8x (64 min threshold)
  const mult3 = stuckDetector.markJustThinking();
  assert.equal(mult3, 8);

  // 4th call: 16x (128 min threshold)
  const mult4 = stuckDetector.markJustThinking();
  assert.equal(mult4, 16);

  // 5th call: capped at maximum 4 times (remains 16x)
  const mult5 = stuckDetector.markJustThinking();
  assert.equal(mult5, 16, "Must not double more than 4 times per day");
  assert.equal(stuckDetector.getPatienceMultiplier(), 16);

  // Simulate next day rollover: setting patienceDay to yesterday
  stuckDetector._setPatienceDay("1999-01-01");

  // Checking patience multiplier on next day should reset to 1x
  assert.equal(
    stuckDetector.getPatienceMultiplier(),
    1,
    "Inactivity threshold must reset to 1x on the next day"
  );
  assert.equal(stuckDetector.getPatienceCount(), 0);
});

test("stuck-detector: User solving questions (LeetCode, HackerRank, Codeforces, quizzes) enters non-disturb thinking state", async (t) => {
  stuckDetector.stopManualModes();
  stuckDetector.toggleDemoMode(false);
  const now = Date.now();

  // Test question solving detection
  assert.equal(stuckDetector.isQuestionSolvingContext("chrome.exe", "Two Sum - LeetCode"), true);
  assert.equal(stuckDetector.isQuestionSolvingContext("msedge.exe", "Solve Challenge - HackerRank"), true);
  assert.equal(stuckDetector.isQuestionSolvingContext("brave.exe", "Problem 1234A - Codeforces"), true);
  assert.equal(stuckDetector.isQuestionSolvingContext("chrome.exe", "Midterm Exam Quiz - Canvas"), true);

  // Even if idle for 10 minutes with frequent window switches (normally stuck/maybe_stuck conditions),
  // solving questions must evaluate to 'thinking' (non-disturb) and NEVER stuck!
  stuckDetector._setTestState({
    currentState: "active",
    currentAppType: "work app",
    currentAppName: "chrome.exe",
    isCurrentWindowWatching: false,
    isCurrentWindowSolvingQuestions: true,
    lastKeyTime: now - 10 * 60 * 1000,
    lastActivityTime: now - 10 * 60 * 1000,
    windowSwitches: [now - 90000, now - 80000, now - 70000, now - 60000, now - 50000, now - 40000],
  });
  stuckDetector._evaluateState();

  assert.equal(
    stuckDetector.getState(),
    "thinking",
    "Solving questions context must set state to thinking so user is never disturbed"
  );

  // Reset
  stuckDetector._setTestState({ isCurrentWindowSolvingQuestions: false });
  stuckDetector.recordKeyActivity();
  assert.equal(stuckDetector.getState(), "active");
});

test("stuck-detector: Watching videos or lectures (YouTube, Coursera, NPTEL) prevents disturbance", async (t) => {
  stuckDetector.stopManualModes();
  stuckDetector.toggleDemoMode(false);
  const now = Date.now();

  assert.equal(stuckDetector.isWatchingContext("chrome.exe", "CS50 Lecture 1 - YouTube - Google Chrome"), true);
  assert.equal(stuckDetector.isWatchingContext("msedge.exe", "Deep Learning Specialization - Coursera"), true);
  assert.equal(stuckDetector.isWatchingContext("brave.exe", "Data Structures Lecture 10 - NPTEL"), true);
  assert.equal(stuckDetector.isWatchingContext("vlc.exe", "Lecture_Recording.mp4"), true);

  // Under inactive conditions, watching context evaluates to watching and blocks stuck
  stuckDetector._setTestState({
    currentState: "active",
    currentAppType: "other",
    currentAppName: "chrome.exe",
    isCurrentWindowWatching: true,
    isCurrentWindowSolvingQuestions: false,
    lastKeyTime: now - 15 * 60 * 1000,
    lastActivityTime: now - 15 * 60 * 1000,
  });
  stuckDetector._evaluateState();

  assert.equal(
    stuckDetector.getState(),
    "watching",
    "Video/lecture watching context must set state to watching so user is never disturbed"
  );

  // Reset
  stuckDetector._setTestState({ isCurrentWindowWatching: false });
  stuckDetector.recordKeyActivity();
});

test("stuck-detector: Active work (typing/mouse activity) keeps state active and prevents disturbance", async (t) => {
  stuckDetector.stopManualModes();
  stuckDetector.toggleDemoMode(false);

  stuckDetector._setTestState({
    currentState: "active",
    currentAppType: "work app",
    currentAppName: "Code.exe",
    isCurrentWindowWatching: false,
    isCurrentWindowSolvingQuestions: false,
  });

  stuckDetector.recordKeyActivity();
  stuckDetector._evaluateState();
  assert.equal(stuckDetector.getState(), "active", "Active typing must keep state as active");

  stuckDetector.recordOtherActivity();
  stuckDetector._evaluateState();
  assert.equal(stuckDetector.getState(), "active", "Mouse/other work activity must keep state as active");
});
