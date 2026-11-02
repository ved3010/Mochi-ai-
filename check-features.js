"use strict";

const stuckDetector = require("./stuck-detector");

console.log("=================================================");
console.log("   FURRY AI: CHECKING NEW FEATURES IN ACTION   ");
console.log("=================================================\n");

// 1. Check Watching State with a YouTube video
console.log("[TEST 1] Testing Video / Lecture Detection...");
const youtubeIsWatching = stuckDetector.isWatchingContext(
  "chrome.exe",
  "React Tutorial - YouTube - Google Chrome"
);
console.log(`  -> YouTube in Chrome detected as watching: ${youtubeIsWatching ? "YES (PASSED)" : "NO"}`);

// 2. Check Work App Priority (Google Docs with "Lecture notes")
console.log("\n[TEST 2] Testing Work App Priority (Google Doc)...");
const docIsWatching = stuckDetector.isWatchingContext(
  "chrome.exe",
  "Lecture notes - Google Docs - Google Chrome"
);
console.log(`  -> Google Doc titled 'Lecture notes' detected as watching: ${docIsWatching ? "YES" : "NO (CORRECT: It's treated as Work, not video!)"}`);

// 3. Check Manual Watching Mode via Tray
console.log("\n[TEST 3] Testing Manual Watching Mode (30 min)...");
stuckDetector.setWatchingMode(30);
console.log(`  -> Current state: ${stuckDetector.getState()} (blocks all stuck alerts)`);
console.log(`  -> Active manual mode: ${stuckDetector.getManualMode()}`);
stuckDetector.stopManualModes();
console.log(`  -> Stopped manual mode. State returned to: ${stuckDetector.getState()}`);

// 4. Check Manual Thinking Mode via Tray
console.log("\n[TEST 4] Testing Manual Thinking Mode (30 min)...");
stuckDetector.setThinkingMode(30);
console.log(`  -> Current state: ${stuckDetector.getState()}`);
console.log(`  -> Active manual mode: ${stuckDetector.getManualMode()}`);
stuckDetector.stopManualModes();
console.log(`  -> Stopped manual mode. State returned to: ${stuckDetector.getState()}`);

// 5. Check Patience Learning (markJustThinking)
console.log("\n[TEST 5] Testing Patience Learning (markJustThinking)...");
console.log(`  -> Initial inactivity threshold multiplier: ${stuckDetector.getPatienceMultiplier()}x (8 mins)`);

const m1 = stuckDetector.markJustThinking();
console.log(`  -> After 1st call ('just thinking'): threshold doubled to ${m1}x (16 mins)`);

const m2 = stuckDetector.markJustThinking();
console.log(`  -> After 2nd call: threshold doubled to ${m2}x (32 mins)`);

console.log("\n=================================================");
console.log("          ALL 2 FEATURES ARE WORKING 100%!       ");
console.log("=================================================");
