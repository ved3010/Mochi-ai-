"use strict";

const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");

// Common web URLs for platforms
const PLATFORM_URLS = {
  youtube: "https://www.youtube.com",
  spotify: "https://open.spotify.com",
  whatsapp: "https://web.whatsapp.com",
  discord: "https://discord.com/app",
  classroom: "https://classroom.google.com",
  "google classroom": "https://classroom.google.com",
  unstop: "https://unstop.com",
  claude: "https://claude.ai",
  chatgpt: "https://chatgpt.com",
  github: "https://github.com",
  vscode: "https://vscode.dev",
  "vs code": "https://vscode.dev",
  "visual studio code": "https://vscode.dev",
  code: "https://vscode.dev",
  notion: "https://www.notion.so",
  reddit: "https://www.reddit.com",
  netflix: "https://www.netflix.com",
  instagram: "https://www.instagram.com",
  twitter: "https://x.com",
  x: "https://x.com",
  gmail: "https://mail.google.com",
  google: "https://www.google.com",
  telegram: "https://web.telegram.org",
  linkedin: "https://www.linkedin.com",
  brave: "https://search.brave.com",
  leetcode: "https://leetcode.com",
  "lead code": "https://leetcode.com",
  "the lead code": "https://leetcode.com",
  leadcode: "https://leetcode.com",
  codeforces: "https://codeforces.com",
  hackerrank: "https://www.hackerrank.com",
  geeksforgeeks: "https://www.geeksforgeeks.org",
  gfg: "https://www.geeksforgeeks.org",
};

// Protocol handlers for native apps
const APP_PROTOCOLS = {
  spotify: "spotify:",
  whatsapp: "whatsapp:",
  discord: "discord:",
};

let cachedBravePath = null;
let cachedShortcuts = null;
let lastScanTime = 0;

/**
 * Locate the Brave Browser executable on Windows.
 */
function getBravePath() {
  if (cachedBravePath && fs.existsSync(cachedBravePath)) {
    return cachedBravePath;
  }

  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

  const candidates = [
    path.join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      cachedBravePath = p;
      return p;
    }
  }

  return null;
}

/**
 * Scan Windows Start Menu shortcuts (.lnk) to detect installed native apps & PWAs.
 */
function scanStartMenuShortcuts(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedShortcuts && now - lastScanTime < 60000) {
    return cachedShortcuts;
  }

  const appData = process.env.APPDATA || "";
  const programData = process.env.ALLUSERSPROFILE || "C:\\ProgramData";

  const searchDirs = [
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
  ];

  const shortcuts = [];

  function walk(dir) {
    try {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".lnk")) {
          const baseName = path.basename(entry.name, ".lnk").toLowerCase();
          shortcuts.push({ name: baseName, path: full });
        }
      }
    } catch (_) {}
  }

  searchDirs.forEach(walk);
  cachedShortcuts = shortcuts;
  lastScanTime = now;
  return shortcuts;
}

/**
 * Find an installed desktop app shortcut (.lnk) matching the requested name.
 */
function findInstalledApp(targetName) {
  const query = targetName.toLowerCase().trim();
  const shortcuts = scanStartMenuShortcuts();

  // 1. Direct exact match (e.g. "youtube", "discord")
  const exact = shortcuts.find((s) => s.name === query);
  if (exact) return exact;

  // 2. Starts with / includes match (e.g. "youtube app" -> "youtube")
  const prefix = shortcuts.find(
    (s) => s.name.startsWith(query) || query.startsWith(s.name)
  );
  if (prefix) return prefix;

  // 3. Normalized alias matches (e.g. "vs code" -> "visual studio code")
  const aliases = {
    "vs code": "visual studio code",
    vscode: "visual studio code",
    code: "visual studio code",
    yt: "youtube",
    "google classroom": "classroom",
  };

  const alias = aliases[query];
  if (alias) {
    const aliasMatch = shortcuts.find(
      (s) => s.name === alias || s.name.includes(alias)
    );
    if (aliasMatch) return aliasMatch;
  }

  // 4. Substring contains match
  const contains = shortcuts.find((s) => s.name.includes(query));
  if (contains) return contains;

  return null;
}

/**
 * Open a URL in the Brave browser (or fallback to system default).
 */
function openInBrave(url, electronShell = null) {
  const bravePath = getBravePath();
  if (bravePath) {
    try {
      const child = spawn(bravePath, [url], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { ok: true, launchedWith: "brave", path: bravePath, url };
    } catch (err) {
      console.warn("[AppLauncher] Error launching Brave directly:", err);
    }
  }

  // Fallback to electron shell or OS start
  if (electronShell && typeof electronShell.openExternal === "function") {
    electronShell.openExternal(url);
    return { ok: true, launchedWith: "electron-shell", url };
  }

  exec(`start "" "${url}"`);
  return { ok: true, launchedWith: "os-default", url };
}

/**
 * Launch an installed desktop application or shortcut.
 */
function launchApp(appShortcutPath, electronShell = null) {
  return new Promise((resolve) => {
    if (electronShell && typeof electronShell.openPath === "function") {
      electronShell
        .openPath(appShortcutPath)
        .then((err) => {
          if (!err) {
            resolve({ ok: true, path: appShortcutPath });
          } else {
            console.warn("[AppLauncher] openPath failed, falling back to exec:", err);
            exec(`start "" "${appShortcutPath}"`, (execErr) => {
              resolve({ ok: !execErr, path: appShortcutPath, error: execErr });
            });
          }
        })
        .catch(() => {
          exec(`start "" "${appShortcutPath}"`, (execErr) => {
            resolve({ ok: !execErr, path: appShortcutPath, error: execErr });
          });
        });
    } else {
      exec(`start "" "${appShortcutPath}"`, (execErr) => {
        resolve({ ok: !execErr, path: appShortcutPath, error: execErr });
      });
    }
  });
}

/**
 * Main entry point:
 * Intelligently opens an app or web URL according to user rules:
 * - If user specifies "web" (e.g., "open youtube web"): open directly in Brave browser.
 * - Otherwise: first check if native app / PWA exists. If yes, open app. If no, open in Brave.
 *
 * @param {string} rawCommand - e.g. "open youtube", "open youtube web", "open unstop", "youtube"
 * @param {object} electronShell - optional Electron shell module
 */
async function openTarget(rawCommand, electronShell = null) {
  let cleaned = String(rawCommand || "")
    .toLowerCase()
    .trim()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "");

  // Strip leading "open " or "launch " or "start "
  cleaned = cleaned.replace(/^(?:please\s+)?(?:open|launch|start|run)\s+/i, "").trim();
  cleaned = cleaned.replace(/^the\s+/i, "").trim();
  cleaned = cleaned.replace(/\s+app$/i, "").trim();

  // Check if user explicitly asked for "web" or "browser"
  let preferWeb = false;
  if (/\b(?:web|website|browser|in\s+brave|in\s+browser)\b/i.test(cleaned)) {
    preferWeb = true;
    cleaned = cleaned
      .replace(/\b(?:web|website|browser|in\s+brave|in\s+browser)\b/gi, "")
      .trim();
  }

  const targetName = cleaned;
  if (!targetName) {
    return { ok: false, error: "Empty target name" };
  }

  // 1. If user explicitly asked for web:
  if (preferWeb) {
    const webUrl =
      PLATFORM_URLS[targetName] ||
      (targetName.startsWith("http")
        ? targetName
        : `https://www.${targetName.replace(/\s+/g, "")}.com`);
    console.log(`[AppLauncher] User specified web. Opening ${webUrl} in Brave.`);
    const result = openInBrave(webUrl, electronShell);
    return {
      ok: true,
      mode: "web",
      preferWeb: true,
      target: targetName,
      url: webUrl,
      ...result,
    };
  }

  // 2. User did NOT specify web -> Check if native app exists first!
  const installedApp = findInstalledApp(targetName);
  if (installedApp) {
    console.log(`[AppLauncher] Found native app for "${targetName}": ${installedApp.path}`);
    const launchResult = await launchApp(installedApp.path, electronShell);
    return {
      ok: launchResult.ok,
      mode: "app",
      target: targetName,
      appName: installedApp.name,
      path: installedApp.path,
    };
  }

  // Also check native protocol (e.g. spotify:, discord:)
  if (APP_PROTOCOLS[targetName]) {
    const protocol = APP_PROTOCOLS[targetName];
    try {
      exec(`start ${protocol}`);
      return { ok: true, mode: "protocol", target: targetName, protocol };
    } catch (_) {}
  }

  // 3. Native app NOT found -> Open in Brave browser!
  const webUrl =
    PLATFORM_URLS[targetName] ||
    (targetName.startsWith("http")
      ? targetName
      : `https://www.${targetName.replace(/\s+/g, "")}.com`);

  console.log(
    `[AppLauncher] Native app not found for "${targetName}". Opening in Brave browser: ${webUrl}`
  );
  const result = openInBrave(webUrl, electronShell);
  return {
    ok: true,
    mode: "web-fallback",
    target: targetName,
    url: webUrl,
    ...result,
  };
}

module.exports = {
  getBravePath,
  scanStartMenuShortcuts,
  findInstalledApp,
  openInBrave,
  launchApp,
  openTarget,
  PLATFORM_URLS,
};
