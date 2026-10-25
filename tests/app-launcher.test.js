"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const launcher = require("../app-launcher");

test("AppLauncher: detects Brave executable path", () => {
  const bravePath = launcher.getBravePath();
  assert.ok(bravePath, "Brave path should be detected");
  assert.match(bravePath.toLowerCase(), /brave\.exe/);
});

test("AppLauncher: finds installed YouTube App (PWA)", () => {
  const app = launcher.findInstalledApp("youtube");
  assert.ok(app, "YouTube app shortcut should be found");
  assert.equal(app.name, "youtube");
  assert.match(app.path.toLowerCase(), /\.lnk$/);
});

test("AppLauncher: returns null for uninstalled app (unstop)", () => {
  const app = launcher.findInstalledApp("unstop");
  assert.equal(app, null);
});

test("AppLauncher: handles 'open youtube' (mode: app)", async () => {
  // Mock electronShell so it doesn't actually launch a window during unit test
  const mockShell = {
    openPath: async (p) => "",
    openExternal: async (url) => {},
  };
  const result = await launcher.openTarget("open youtube", mockShell);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "app");
  assert.equal(result.target, "youtube");
  assert.match(result.path.toLowerCase(), /youtube/);
});

test("AppLauncher: handles 'open youtube web' (mode: web in Brave)", async () => {
  const mockShell = {
    openPath: async () => "",
    openExternal: async () => {},
  };
  const result = await launcher.openTarget("open youtube web", mockShell);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "web");
  assert.equal(result.preferWeb, true);
  assert.equal(result.target, "youtube");
  assert.equal(result.url, "https://www.youtube.com");
});

test("AppLauncher: handles 'open unstop' (mode: web-fallback)", async () => {
  const mockShell = {
    openPath: async () => "",
    openExternal: async () => {},
  };
  const result = await launcher.openTarget("open unstop", mockShell);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "web-fallback");
  assert.equal(result.target, "unstop");
  assert.equal(result.url, "https://unstop.com");
});

test("AppLauncher: handles 'open google classroom' (mode: web-fallback)", async () => {
  const mockShell = {
    openPath: async () => "",
    openExternal: async () => {},
  };
  const result = await launcher.openTarget("open google classroom", mockShell);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "web-fallback");
  assert.equal(result.url, "https://classroom.google.com");
});

test("AppLauncher: handles 'Open the lead code.' (speech-to-text leetcode fallback to Brave)", async () => {
  const mockShell = {
    openPath: async () => "",
    openExternal: async () => {},
  };
  const result = await launcher.openTarget("Open the lead code.", mockShell);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "web-fallback");
  assert.equal(result.url, "https://leetcode.com");
});

test("AppLauncher: handles 'open leetcode' (mode: web-fallback to Brave)", async () => {
  const mockShell = {
    openPath: async () => "",
    openExternal: async () => {},
  };
  const result = await launcher.openTarget("open leetcode", mockShell);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "web-fallback");
  assert.equal(result.url, "https://leetcode.com");
});
