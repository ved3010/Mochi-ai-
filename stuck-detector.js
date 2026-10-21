"use strict";

/**
 * stuck-detector.js
 * 
 * Monitors user work focus and detects when the user may be stuck.
 * 
 * Rules & Constraints:
 * 1. Uses uiohook-napi to record ONLY timestamps of keyboard/mouse activity.
 *    NEVER stores or logs key content or keycodes.
 * 2. Uses active-win to read active window app name and context in memory only.
 * 3. Classifies active window as "work app" (Word, Docs, VS Code, Cursor, Windsurf,
 *    Antigravity, Windows Terminal, PDF reader, Notes/Notion) or "other".
 * 4. Watching detection: Detects video or lecture context in memory only (YouTube, Zoom,
 *    Meet, Teams, Coursera, NPTEL, lecture, webinar, VLC, or full display coverage).
 *    NEVER logs, stores, or sends window titles. Console logs show only app name and state.
 * 5. Manual modes: Watching mode (30/60/90m), Thinking mode (30/60m), and Stop for each.
 *    While in watching or thinking, never enters maybe_stuck or stuck.
 * 6. Patience learning: markJustThinking() doubles inactivity threshold for the rest
 *    of the day (max 4 times = 16x) and resets the next day.
 * 7. State rules:
 *    - stuck = 6+ window switches in 2 mins AND no keyboard activity for 5 mins (10s in demo)
 *    - maybe_stuck = no activity of any kind for 8 mins (15s in demo) in a work app
 *    - watching / thinking = blocks maybe_stuck and stuck
 *    - active = otherwise
 * 8. Demo mode: toggled by Ctrl+Alt+Shift+F9 (CommandOrControl+Alt+Shift+F9).
 * 9. Exports onStateChange(callback), setWatchingMode, setThinkingMode, stopManualModes, markJustThinking.
 */

const STATES = {
  ACTIVE: "active",
  MAYBE_STUCK: "maybe_stuck",
  STUCK: "stuck",
  WATCHING: "watching",
  THINKING: "thinking",
};

const WINDOW_SWITCH_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const NORMAL_MAYBE_STUCK_THRESHOLD_MS = 8 * 60 * 1000; // 8 minutes (no activity of any kind)
const NORMAL_NO_KEY_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes (no keyboard activity)
const DEMO_MAYBE_STUCK_THRESHOLD_MS = 15 * 1000; // 15 seconds in demo mode
const DEMO_NO_KEY_THRESHOLD_MS = 10 * 1000; // 10 seconds in demo mode
const MIN_SWITCHES_FOR_STUCK = 6;
const POLL_INTERVAL_MS = 1000; // Poll active window every second

let currentState = STATES.ACTIVE;
let lastActivityTime = Date.now(); // Any input or window switch
let lastKeyTime = Date.now(); // Keyboard events only (timestamp only)
let isDemoMode = false;

// Manual focus modes
let manualMode = null; // null | 'watching' | 'thinking'
let manualModeExpiresAt = 0;
let manualModeTimer = null;

// Patience learning
let patienceDay = "";
let patienceCount = 0; // 0 to 4
let patienceMultiplier = 1; // 1, 2, 4, 8, 16

// In-memory state only - NEVER written to disk, titles never logged
let currentAppName = "";
let currentAppType = "other"; // 'work app' | 'other'
let isCurrentWindowWatching = false;
let isCurrentWindowSolvingQuestions = false;
let currentBounds = null;
let lastWindowKey = null;
let windowSwitches = []; // Array of timestamps

let pollTimer = null;
let isInitialized = false;
let activeWinModule = null;
const stateListeners = new Set();

/**
 * Record keyboard activity timestamp.
 * CRITICAL PRIVACY REQUIREMENT:
 * Record ONLY the timestamp (Date.now()). Never inspect, log, or store key content.
 */
function recordKeyActivity() {
  const now = Date.now();
  lastKeyTime = now;
  lastActivityTime = now;
  evaluateState();
}

/**
 * Record non-keyboard activity timestamp (mouse, scroll, etc.).
 */
function recordOtherActivity() {
  lastActivityTime = Date.now();
  evaluateState();
}

/**
 * Backward compatibility alias for any input activity.
 */
function recordActivity() {
  recordKeyActivity();
}

/**
 * Classifies an application based on process name and window title.
 * In memory only - window title is never logged.
 * 
 * @param {string} appName - Process or executable name
 * @param {string} windowTitle - Window title (in-memory only)
 * @returns {'work app' | 'other'}
 */
function classifyApp(appName, windowTitle) {
  const name = String(appName || "").toLowerCase();
  const title = String(windowTitle || "").toLowerCase();

  // 1. Word: Microsoft Word, WINWORD, Word, LibreOffice Writer, WPS Writer
  const isWord =
    /\b(winword|word|microsoft word|writer)\b/i.test(name) ||
    title.endsWith(" - word") ||
    title.includes(" - word ") ||
    title.includes("microsoft word");

  // 2. Docs: Google Docs in browser or desktop wrapper
  const isDocs =
    title.includes("google docs") ||
    title.includes("docs.google.com") ||
    name.includes("google docs") ||
    (/\bdocs\b/i.test(name) && !name.includes("docker"));

  // 3. Code Editors & Terminals & IDEs:
  // Antigravity, Windows Terminal, VS Code, Cursor, Windsurf, VSCodium, JetBrains (IntelliJ, PyCharm, WebStorm, CLion, Rider, GoLand, Android Studio), Sublime, Vim, Neovim, Emacs, Eclipse, Xcode
  const isCodeOrTerminal =
    /\b(code|vscode|visual studio code|codium|vscodium|cursor|windsurf|antigravity|antigravity ide|windowsterminal|windows terminal|wt\.exe|idea|idea64|pycharm|pycharm64|webstorm|webstorm64|clion|clion64|rider|rider64|goland|goland64|studio64|sublime_text|sublime text|nvim|vim|emacs|eclipse|xcode)\b/i.test(name) ||
    title.includes("visual studio code") ||
    title.includes(" - visual studio code") ||
    title.includes(" - code") ||
    title.includes("cursor") ||
    title.includes("windsurf") ||
    title.includes("antigravity") ||
    title.includes("windows terminal") ||
    title.includes("sublime text") ||
    title.includes("intellij") ||
    title.includes("pycharm") ||
    title.includes("webstorm");

  // 4. Problem Solving & Competitive Programming platforms:
  // LeetCode, HackerRank, Codeforces, Kaggle, CodeChef, GeeksforGeeks, NeetCode, AtCoder, Codewars
  const isProblemSolving =
    /\b(leetcode|hackerrank|codeforces|kaggle|codechef|geeksforgeeks|neetcode|atcoder|codewars)\b/i.test(name) ||
    title.includes("leetcode") ||
    title.includes("hackerrank") ||
    title.includes("codeforces") ||
    title.includes("kaggle") ||
    title.includes("codechef") ||
    title.includes("geeksforgeeks") ||
    title.includes("neetcode") ||
    title.includes("atcoder") ||
    title.includes("codewars");

  // 5. PDF Reader / Browser tabs containing PDF
  const isPDF =
    /\b(acrobat|acrord32|adobearm|adobe reader|sumatrapdf|foxit|pdf reader|preview|okular|evince)\b/i.test(name) ||
    /\.pdf\b/i.test(title) ||
    title.includes("pdf reader") ||
    title.includes(".pdf");

  // 6. Notes, Sheets, Math & Work Tools
  const isNotesOrWorkTools =
    /\b(notes|notepad|notepad\+\+|obsidian|notion|onenote|evernote|simplenote|bear|excel|sheets|overleaf|jupyter)\b/i.test(name) ||
    title.includes("notepad") ||
    title.includes("obsidian") ||
    title.includes("notion") ||
    title.includes("onenote") ||
    title.includes("evernote") ||
    title.includes("google sheets") ||
    title.includes("overleaf") ||
    title.includes("jupyter");

  if (isWord || isDocs || isCodeOrTerminal || isProblemSolving || isPDF || isNotesOrWorkTools) {
    return "work app";
  }

  return "other";
}

/**
 * Checks if window covers the full display bounds using Electron screen.
 * Compares window bounds to the full display bounds (screen.getAllDisplays().bounds, NOT workArea),
 * ensuring a normal maximized window (which stops at the taskbar/dock) is NOT treated as fullscreen.
 * 
 * @param {object} [bounds] - Window bounds { x, y, width, height }
 * @returns {boolean}
 */
function isWindowCoveringFullDisplay(bounds) {
  if (!bounds || typeof bounds.width !== "number" || typeof bounds.height !== "number") {
    return false;
  }
  try {
    let screen = mockScreen;
    if (!screen) {
      const electron = require("electron");
      screen = electron.screen;
    }
    if (screen && typeof screen.getAllDisplays === "function") {
      const displays = screen.getAllDisplays();
      for (const d of displays) {
        const db = d.bounds;
        if (!db || typeof db.width !== "number" || typeof db.height !== "number") continue;

        // True fullscreen must cover the full display bounds (db.bounds, NOT workArea).
        // On Windows and macOS, a normal maximized window leaves space for the taskbar / dock,
        // so its height or width is smaller than the full display bounds.
        const coversX = bounds.x <= (db.x || 0) + 2 && (bounds.x + bounds.width) >= ((db.x || 0) + db.width - 2);
        const coversY = bounds.y <= (db.y || 0) + 2 && (bounds.y + bounds.height) >= ((db.y || 0) + db.height - 2);
        const fullWidth = bounds.width >= db.width - 2;
        const fullHeight = bounds.height >= db.height - 2;

        if (coversX && coversY && fullWidth && fullHeight) {
          return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

/**
 * Checks if an application is a web browser or a dedicated media/meeting application.
 * Supports desktop browsers, PWAs (like YouTube downloaded via Brave/Chrome), and media players.
 * @param {string} appName - Executable or process name
 * @param {string} [appPath] - Full executable path (optional)
 * @returns {boolean}
 */
function isBrowserOrMediaApp(appName, appPath) {
  const name = `${appName || ""} ${appPath || ""}`.toLowerCase();
  return (
    name.includes("chrome") ||
    name.includes("edge") ||
    name.includes("msedge") ||
    name.includes("brave") ||
    name.includes("firefox") ||
    name.includes("opera") ||
    name.includes("safari") ||
    name.includes("arc") ||
    name.includes("vivaldi") ||
    name.includes("vlc") ||
    name.includes("zoom") ||
    name.includes("teams") ||
    name.includes("youtube") ||
    name.includes("wmplayer") ||
    name.includes("mpv") ||
    name.includes("potplayer") ||
    name.includes("kmplayer") ||
    name.includes("netflix")
  );
}

/**
 * Detects if the current active window represents video or lecture context.
 * In memory only - never stores, logs, or transmits windowTitle.
 * 
 * Rules:
 * (1) Priority order: if the window is a work app (Google Docs, Notion, PDF, Word,
 *     IDE, Notepad), it is NOT watching, unless the title explicitly indicates a video/lecture site
 *     (e.g., YouTube, Coursera, Udemy, etc.).
 * (2) Use video keywords only when the app is a browser or a media/meeting app.
 * (3) The fullscreen rule compares window bounds to the full display bounds.
 * 
 * @param {string} appName - Process name
 * @param {string} windowTitle - Window title (in memory only)
 * @param {object} [bounds] - Window bounds
 * @param {string} [appPath] - Process executable path
 * @returns {boolean}
 */
function isWatchingContext(appName, windowTitle, bounds, appPath) {
  const name = `${appName || ""} ${appPath || ""}`.toLowerCase();
  const title = String(windowTitle || "").toLowerCase();

  // If the title explicitly belongs to video/lecture platforms, it IS watching (even if code words appear in the title)
  const isExplicitVideoPlatform =
    title.includes("youtube") ||
    title.includes("coursera") ||
    title.includes("nptel") ||
    title.includes("udemy") ||
    title.includes("edx") ||
    title.includes("khan academy") ||
    title.includes("netflix") ||
    title.includes("prime video") ||
    title.includes("primevideo") ||
    title.includes("hotstar") ||
    title.includes("disney") ||
    title.includes("hulu") ||
    title.includes("twitch") ||
    name.includes("youtube") ||
    name.includes("vlc") ||
    name.includes("zoom");

  if (!isExplicitVideoPlatform && classifyApp(appName, windowTitle) === "work app") {
    return false;
  }

  // Fullscreen rule: If a non-work window covers the full display bounds,
  // it is treated as watching (e.g. video in true fullscreen mode).
  if (isWindowCoveringFullDisplay(bounds)) {
    return true;
  }

  // Use video keywords only when the app is a browser, PWA, or media/meeting app
  if (!isBrowserOrMediaApp(appName, appPath)) {
    return false;
  }

  if (name.includes("youtube")) {
    return true;
  }

  // Match 'Google Meet' and 'Microsoft Teams' as whole phrases, not bare words 'Meet' or 'Teams'
  const isVideoOrMeeting =
    isExplicitVideoPlatform ||
    title.includes("google meet") ||
    title.includes("microsoft teams") ||
    title.includes("canvas") ||
    title.includes("blackboard") ||
    title.includes("moodle") ||
    title.includes("panopto") ||
    title.includes("kaltura") ||
    title.includes("loom") ||
    title.includes("ted.com") ||
    title.includes("ted talks") ||
    title.includes("skillshare") ||
    title.includes("pluralsight") ||
    title.includes("linkedin learning") ||
    title.includes("vimeo") ||
    title.includes("bilibili") ||
    title.includes("dailymotion") ||
    title.includes("lecture") ||
    title.includes("webinar") ||
    title.includes("tutorial") ||
    title.includes("zoom") ||
    name.includes("zoom") ||
    title.includes("vlc") ||
    name.includes("vlc") ||
    name.includes("teams");

  return isVideoOrMeeting;
}

/**
 * Detects if the current active window represents solving questions,
 * competitive programming, or quiz/exam contexts.
 * In memory only - never stores, logs, or transmits windowTitle.
 * 
 * @param {string} appName - Process name
 * @param {string} windowTitle - Window title (in memory only)
 * @returns {boolean}
 */
function isQuestionSolvingContext(appName, windowTitle) {
  const name = String(appName || "").toLowerCase();
  const title = String(windowTitle || "").toLowerCase();

  const isPlatform =
    /\b(leetcode|hackerrank|codeforces|kaggle|codechef|geeksforgeeks|neetcode|atcoder|codewars|hackerearth|interviewbit|projecteuler|spoj|topcoder|exercism)\b/i.test(name) ||
    title.includes("leetcode") ||
    title.includes("hackerrank") ||
    title.includes("codeforces") ||
    title.includes("kaggle") ||
    title.includes("codechef") ||
    title.includes("geeksforgeeks") ||
    title.includes("neetcode") ||
    title.includes("atcoder") ||
    title.includes("codewars") ||
    title.includes("hackerearth") ||
    title.includes("interviewbit") ||
    title.includes("project euler") ||
    title.includes("spoj") ||
    title.includes("topcoder") ||
    title.includes("exercism");

  if (isPlatform) return true;

  const isQuestionOrQuiz =
    title.includes("quiz") ||
    title.includes("exam") ||
    title.includes("contest") ||
    title.includes("assessment") ||
    /\b(solve|solving|question|questions|problem|problems)\b/i.test(title);

  return Boolean(isQuestionOrQuiz && (isBrowserOrMediaApp(appName) || /canvas|blackboard|moodle|exam|quiz/i.test(name)));
}

/**
 * Helper to get the current date string (YYYY-MM-DD).
 */
function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Resets patience learning on a new calendar day.
 */
function checkPatienceDayReset() {
  const today = getTodayString();
  if (patienceDay !== today) {
    patienceDay = today;
    patienceCount = 0;
    patienceMultiplier = 1;
  }
}

/**
 * Patience learning: Doubles the inactivity threshold for the rest of the day (max 4 times = 16x).
 * Resets automatically the next day.
 * 
 * @returns {number} Current patience multiplier (1, 2, 4, 8, or 16)
 */
function markJustThinking() {
  checkPatienceDayReset();
  if (patienceCount < 4) {
    patienceCount++;
    patienceMultiplier *= 2;
    console.log(
      `[StuckDetector] markJustThinking called. Inactivity threshold doubled (${patienceMultiplier}x, ${patienceCount}/4 today)`
    );
  } else {
    console.log(
      `[StuckDetector] markJustThinking: already at maximum 4x doubling today (${patienceMultiplier}x)`
    );
  }
  evaluateState();
  return patienceMultiplier;
}

/**
 * Sets manual Watching mode for the given duration in minutes.
 * Automatically expires when the duration elapses.
 * 
 * @param {number} [minutes=30]
 */
function setWatchingMode(minutes = 30) {
  const mins = Math.max(1, Number(minutes) || 30);
  manualMode = STATES.WATCHING;
  manualModeExpiresAt = Date.now() + mins * 60 * 1000;
  if (manualModeTimer) clearTimeout(manualModeTimer);
  manualModeTimer = setTimeout(() => {
    stopManualModes();
  }, mins * 60 * 1000);
  console.log(`[StuckDetector] Manual Watching mode enabled for ${mins} minutes`);
  evaluateState();
}

/**
 * Sets manual Thinking mode for the given duration in minutes.
 * Automatically expires when the duration elapses.
 * 
 * @param {number} [minutes=30]
 */
function setThinkingMode(minutes = 30) {
  const mins = Math.max(1, Number(minutes) || 30);
  manualMode = STATES.THINKING;
  manualModeExpiresAt = Date.now() + mins * 60 * 1000;
  if (manualModeTimer) clearTimeout(manualModeTimer);
  manualModeTimer = setTimeout(() => {
    stopManualModes();
  }, mins * 60 * 1000);
  console.log(`[StuckDetector] Manual Thinking mode enabled for ${mins} minutes`);
  evaluateState();
}

/**
 * Stops any active manual mode (Watching or Thinking).
 */
function stopManualModes() {
  if (manualMode) {
    console.log(`[StuckDetector] Manual ${manualMode} mode stopped`);
  }
  manualMode = null;
  manualModeExpiresAt = 0;
  if (manualModeTimer) {
    clearTimeout(manualModeTimer);
    manualModeTimer = null;
  }
  evaluateState();
}

/**
 * Returns timestamps of window switches that happened in the last 2 minutes.
 * Automatically prunes older entries from memory.
 */
function getWindowSwitchesInLast2Minutes() {
  const cutoff = Date.now() - WINDOW_SWITCH_WINDOW_MS;
  windowSwitches = windowSwitches.filter((timestamp) => timestamp >= cutoff);
  return windowSwitches;
}

/**
 * Dynamically fetches active window using active-win (kept in-memory only).
 */
async function fetchActiveWindow() {
  try {
    if (!activeWinModule) {
      const mod = await import("active-win");
      activeWinModule = mod.default || mod;
    }
    return await activeWinModule();
  } catch (err) {
    return null;
  }
}

/**
 * Polls the currently active window, counts switches, and updates classification.
 */
async function pollActiveWindow() {
  const win = await fetchActiveWindow();
  if (!win) return;

  const appName = win.owner?.name || "";
  const appPath = win.owner?.path || "";
  const title = win.title || "";
  const windowKey = `${win.id || ""}_${appName}_${title}`;

  const isFirstWindow = lastWindowKey === null;
  const isWindowChanged = lastWindowKey !== null && lastWindowKey !== windowKey;

  // Check if window changed
  if (isWindowChanged) {
    const now = Date.now();
    windowSwitches.push(now);
    // Switching windows counts as user activity (mouse / alt-tab), but NOT keyboard typing
    lastActivityTime = now;
    // Prune entries older than 2 minutes
    const cutoff = now - WINDOW_SWITCH_WINDOW_MS;
    windowSwitches = windowSwitches.filter((t) => t >= cutoff);
  }
  lastWindowKey = windowKey;

  // In-memory classification only - NEVER store or log window title
  currentAppName = appName;
  currentAppType = classifyApp(appName, title);
  currentBounds = win.bounds || null;
  isCurrentWindowWatching = isWatchingContext(appName, title, currentBounds, appPath);
  isCurrentWindowSolvingQuestions = isQuestionSolvingContext(appName, title);

  const didChange = evaluateState();
  if ((isWindowChanged || isFirstWindow) && !didChange) {
    // Console logs show ONLY app name and the state - NEVER window titles
    console.log(`[StuckDetector] App: '${currentAppName}' | State: ${currentState}`);
  }
}

/**
 * Evaluates the current state: 'active', 'maybe_stuck', 'stuck', 'watching', or 'thinking'.
 * 
 * Rules:
 * 1. While in watching or thinking, the detector must NEVER enter maybe_stuck or stuck.
 * 2. stuck = 6 or more window switches in the last 2 minutes AND no keyboard activity for 5 minutes (10s in demo).
 * 3. maybe_stuck = no activity of any kind for 8 minutes (scaled by patience, or 15s in demo) in a work app.
 * 4. active = otherwise.
 * 
 * @returns {boolean} Whether the state changed
 */
function evaluateState() {
  const now = Date.now();

  // Auto-expire manual modes if elapsed
  if (manualMode && manualModeExpiresAt > 0 && now >= manualModeExpiresAt) {
    manualMode = null;
    manualModeExpiresAt = 0;
    if (manualModeTimer) {
      clearTimeout(manualModeTimer);
      manualModeTimer = null;
    }
  }

  let newState = STATES.ACTIVE;

  // Priority 1: Manual modes (Watching / Thinking)
  if (manualMode === STATES.WATCHING) {
    newState = STATES.WATCHING;
  } else if (manualMode === STATES.THINKING) {
    newState = STATES.THINKING;
  } else if (isCurrentWindowWatching && currentAppType !== "work app") {
    // Priority 2: Detected video or lecture context (never when in a work app)
    newState = STATES.WATCHING;
  } else if (isCurrentWindowSolvingQuestions) {
    // Priority 3: Solving questions (LeetCode, HackerRank, Codeforces, quizzes, exams)
    // Deep focus solving questions - cat must NOT disturb the user
    newState = STATES.THINKING;
  } else {
    // Normal stuck and maybe_stuck evaluation
    checkPatienceDayReset();
    const noActivityDuration = now - lastActivityTime;
    const noKeyDuration = now - lastKeyTime;

    const baseMaybeStuckThreshold = isDemoMode
      ? DEMO_MAYBE_STUCK_THRESHOLD_MS
      : NORMAL_MAYBE_STUCK_THRESHOLD_MS;
    const maybeStuckThreshold = baseMaybeStuckThreshold * patienceMultiplier;

    const noKeyThreshold = isDemoMode
      ? DEMO_NO_KEY_THRESHOLD_MS
      : NORMAL_NO_KEY_THRESHOLD_MS;

    const switchesIn2Min = getWindowSwitchesInLast2Minutes();
    const hasFrequentSwitches = switchesIn2Min.length >= MIN_SWITCHES_FOR_STUCK;

    // Rule: stuck = 6+ window switches in 2 mins AND no keyboard activity for 5 mins (or 10s demo)
    const isStuck = hasFrequentSwitches && noKeyDuration >= noKeyThreshold;

    // Rule: maybe_stuck = no activity of any kind for 8 mins in a work app
    const isMaybeStuck = currentAppType === "work app" && noActivityDuration >= maybeStuckThreshold;

    if (isStuck) {
      newState = STATES.STUCK;
    } else if (isMaybeStuck) {
      newState = STATES.MAYBE_STUCK;
    } else {
      newState = STATES.ACTIVE;
    }
  }

  let didChange = false;
  if (newState !== currentState) {
    const previousState = currentState;
    currentState = newState;
    didChange = true;

    // Console logs show ONLY app name and the state - NEVER window titles
    console.log(
      `[StuckDetector] State changed to: ${currentState} ` +
      `(previous: ${previousState}, app: '${currentAppName}', appType: '${currentAppType}')`
    );

    // Notify registered listeners
    const switchesCount = getWindowSwitchesInLast2Minutes().length;
    for (const listener of stateListeners) {
      try {
        listener(currentState, previousState, {
          appType: currentAppType,
          appName: currentAppName,
          manualMode,
          isDemoMode,
          patienceMultiplier,
          windowSwitchesLast2Min: switchesCount,
        });
      } catch (err) {
        console.error("[StuckDetector] Listener error:", err);
      }
    }
  }

  return didChange;
}

/**
 * Toggles demo mode (15s for 8-min rule, 10s for 5-min rule).
 * @param {boolean} [forcedState] - Optional explicit boolean state
 */
function toggleDemoMode(forcedState) {
  isDemoMode = typeof forcedState === "boolean" ? forcedState : !isDemoMode;
  console.log(
    `[StuckDetector] Demo mode ${
      isDemoMode ? "ENABLED (15s inactive / 10s no-key)" : "DISABLED (8m inactive / 5m no-key)"
    }`
  );
  evaluateState();
  return isDemoMode;
}

/**
 * Subscribes a callback to state changes.
 * @param {function(string, string, object): void} callback
 * @returns {function(): void} Unsubscribe function
 */
function onStateChange(callback) {
  if (typeof callback === "function") {
    stateListeners.add(callback);
  }
  return () => {
    stateListeners.delete(callback);
  };
}

/**
 * Initializes the stuck detector.
 * Connects to uiohook-napi and registers keyboard shortcut for demo mode.
 * 
 * @param {object} [options]
 * @param {object} [options.uIOhook] - Existing uIOhook instance from uiohook-napi
 * @param {object} [options.globalShortcut] - Electron globalShortcut
 * @param {string} [options.shortcut] - Shortcut string, defaults to 'CommandOrControl+Alt+Shift+F9'
 */
function init(options = {}) {
  if (isInitialized) return;
  isInitialized = true;

  // 1. Connect to uIOhook (either passed in or required)
  let hook = options.uIOhook;
  if (!hook) {
    try {
      const uiohookNapi = require("uiohook-napi");
      hook = uiohookNapi.uIOhook;
    } catch (err) {
      console.warn("[StuckDetector] uiohook-napi not available directly, waiting for main hook:", err.message);
    }
  }

  if (hook) {
    // Keyboard events update lastKeyTime and lastActivityTime (NEVER store key content)
    hook.on("keydown", recordKeyActivity);
    hook.on("keyup", recordKeyActivity);

    // Mouse and wheel events update only lastActivityTime
    hook.on("mousemove", recordOtherActivity);
    hook.on("mousedown", recordOtherActivity);
    hook.on("mouseup", recordOtherActivity);
    hook.on("wheel", recordOtherActivity);
  }

  // 2. Register demo mode shortcut in Electron
  const shortcutKey = options.shortcut || "CommandOrControl+Alt+Shift+F9";
  try {
    let electronGlobalShortcut = options.globalShortcut;
    if (!electronGlobalShortcut) {
      const electron = require("electron");
      electronGlobalShortcut = electron.globalShortcut;
    }

    if (electronGlobalShortcut && typeof electronGlobalShortcut.register === "function") {
      const registered = electronGlobalShortcut.register(shortcutKey, () => {
        toggleDemoMode();
      });
      if (registered) {
        console.log(`[StuckDetector] Demo mode shortcut registered: ${shortcutKey}`);
      } else {
        console.warn(`[StuckDetector] Could not register shortcut: ${shortcutKey}`);
      }
    }
  } catch (err) {
    console.warn("[StuckDetector] globalShortcut registration skipped:", err.message);
  }

  // 3. Start active window polling
  pollActiveWindow();
  pollTimer = setInterval(() => {
    pollActiveWindow();
  }, POLL_INTERVAL_MS);

  console.log("[StuckDetector] Initialized successfully. Monitoring focus state...");
}

/**
 * Stops all timers and removes hooks.
 */
function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (manualModeTimer) {
    clearTimeout(manualModeTimer);
    manualModeTimer = null;
  }
  isInitialized = false;
  stateListeners.clear();
}

function getPatienceMultiplier() {
  checkPatienceDayReset();
  return patienceMultiplier;
}

function getPatienceCount() {
  checkPatienceDayReset();
  return patienceCount;
}

function getManualMode() {
  return manualMode;
}

let mockScreen = null;
function setMockScreen(screen) {
  mockScreen = screen;
}

module.exports = {
  STATES,
  init,
  stop,
  onStateChange,
  getState: () => currentState,
  isDemoMode: () => isDemoMode,
  toggleDemoMode,
  getLastActivityTime: () => lastActivityTime,
  getLastActivityTimestamp: () => lastActivityTime,
  getLastKeyTime: () => lastKeyTime,
  getWindowSwitchesCount: () => getWindowSwitchesInLast2Minutes().length,
  getCurrentAppType: () => currentAppType,
  getCurrentAppName: () => currentAppName,
  classifyApp,
  isWatchingContext,
  isQuestionSolvingContext,
  setWatchingMode,
  setThinkingMode,
  stopManualModes,
  stopWatchingMode: () => stopManualModes(STATES.WATCHING),
  stopThinkingMode: () => stopManualModes(STATES.THINKING),
  markJustThinking,
  getPatienceMultiplier,
  getPatienceCount,
  getManualMode,
  setMockScreen,
  recordKeyActivity,
  recordOtherActivity,
  recordActivity,
  _setTestState: (opts = {}) => {
    if (typeof opts.currentState !== "undefined") currentState = opts.currentState;
    if (typeof opts.lastActivityTime !== "undefined") lastActivityTime = opts.lastActivityTime;
    if (typeof opts.lastActivityTimestamp !== "undefined") lastActivityTime = opts.lastActivityTimestamp;
    if (typeof opts.lastKeyTime !== "undefined") lastKeyTime = opts.lastKeyTime;
    if (typeof opts.currentAppType !== "undefined") currentAppType = opts.currentAppType;
    if (typeof opts.currentAppName !== "undefined") currentAppName = opts.currentAppName;
    if (typeof opts.isCurrentWindowWatching !== "undefined") isCurrentWindowWatching = opts.isCurrentWindowWatching;
    if (typeof opts.isCurrentWindowSolvingQuestions !== "undefined") isCurrentWindowSolvingQuestions = opts.isCurrentWindowSolvingQuestions;
    if (typeof opts.manualMode !== "undefined") manualMode = opts.manualMode;
    if (typeof opts.manualModeExpiresAt !== "undefined") manualModeExpiresAt = opts.manualModeExpiresAt;
    if (typeof opts.patienceMultiplier !== "undefined") patienceMultiplier = opts.patienceMultiplier;
    if (typeof opts.patienceCount !== "undefined") patienceCount = opts.patienceCount;
    if (typeof opts.patienceDay !== "undefined") patienceDay = opts.patienceDay;
    if (typeof opts.windowSwitches !== "undefined") windowSwitches = opts.windowSwitches;
    if (typeof opts.isDemoMode !== "undefined") isDemoMode = opts.isDemoMode;
  },
  _evaluateState: evaluateState,
  _setPatienceDay: (dayStr) => {
    patienceDay = dayStr;
  },
};
