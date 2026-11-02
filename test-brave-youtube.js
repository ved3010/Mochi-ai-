"use strict";

const stuckDetector = require("./stuck-detector");
const activeWin = require("active-win");

console.log("==================================================================");
console.log("    BRAVE YOUTUBE APP (PWA) & WATCHING MODE VERIFICATION");
console.log("==================================================================\n");

// 1. Static Unit Checks for Brave YouTube scenarios
const scenarios = [
  {
    desc: "Brave with YouTube video open",
    app: "brave.exe",
    title: "Lofi Hip Hop Radio - YouTube - Brave",
    path: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  },
  {
    desc: "Brave YouTube downloaded PWA (brave_proxy.exe)",
    app: "brave_proxy.exe",
    title: "YouTube - Home",
    path: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave_proxy.exe"
  },
  {
    desc: "Brave YouTube app process named YouTube.exe",
    app: "YouTube.exe",
    title: "YouTube",
    path: "C:\\Users\\User\\AppData\\Local\\BraveSoftware\\YouTube.exe"
  },
  {
    desc: "Work App priority test (Google Doc titled 'YouTube Marketing Notes')",
    app: "brave.exe",
    title: "YouTube Marketing Notes - Google Docs - Brave",
    path: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
];

scenarios.forEach((s, idx) => {
  const isWatching = stuckDetector.isWatchingContext(s.app, s.title, null, s.path);
  const isWork = stuckDetector.classifyApp(s.app, s.title) === "work app";
  console.log(`[TEST ${idx + 1}] ${s.desc}`);
  console.log(`  -> Detected as Watching: ${isWatching ? "YES (WATCHING STATE)" : "NO"}`);
  console.log(`  -> Detected as Work App: ${isWork ? "YES" : "NO"}`);
  console.log("");
});

console.log("==================================================================");
console.log("             LIVE WINDOW DETECTION MONITOR (Next 15 Seconds)      ");
console.log(" Switch to your YouTube App now to see it detected live below:   ");
console.log("==================================================================\n");

let secondsLeft = 15;
let lastDetected = null;

const interval = setInterval(async () => {
  try {
    const win = await activeWin();
    if (win) {
      const appName = win.owner?.name || "";
      const appPath = win.owner?.path || "";
      const title = win.title || "";
      const isWatching = stuckDetector.isWatchingContext(appName, title, win.bounds, appPath);
      const isWork = stuckDetector.classifyApp(appName, title) === "work app";
      const key = `${appName}_${isWatching}_${isWork}`;

      if (key !== lastDetected) {
        lastDetected = key;
        const stateName = isWatching ? "WATCHING (YouTube / Video detected!)" : (isWork ? "ACTIVE (Work App)" : "ACTIVE (General)");
        console.log(`>>> [ACTIVE WINDOW DETECTED] App: '${appName}' | State: ${stateName}`);
      }
    }
  } catch (err) {
    // ignore
  }

  secondsLeft--;
  if (secondsLeft <= 0) {
    clearInterval(interval);
    console.log("\n[DONE] Live monitor finished. All checks completed.");
  }
}, 1000);
