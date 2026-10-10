"use strict";

const { app, BrowserWindow, screen, session, systemPreferences } = require("electron");
const path = require("path");
const fs = require("fs");

// Load .env variables into process.env if present
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (key && val) {
          process.env[key] = val;
        }
      }
    }
  }
} catch (_) {}

if (process.platform === "darwin") {
  const childProcess = require("child_process");
  const nativeSpawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    if (String(command).toLowerCase() === "powershell.exe") {
      return nativeSpawn("/usr/bin/true", [], options);
    }
    return nativeSpawn(command, args, options);
  };
}

// Load sidecar & main desktop-pet logic
require("./agent-main");
require("./main.js");

app.whenReady().then(async () => {
  if (session && session.defaultSession) {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === "media" || permission === "audioCapture") {
        return callback(true);
      }
      callback(true);
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      if (permission === "media" || permission === "audioCapture") {
        return true;
      }
      return true;
    });
  }

  if (process.platform === "darwin" && systemPreferences?.askForMediaAccess) {
    try {
      const granted = await systemPreferences.askForMediaAccess("microphone");
      console.log("[Comnyang] macOS microphone permission granted:", granted);
    } catch (e) {
      console.warn("[Comnyang] macOS microphone permission check failed:", e?.message || e);
    }
  }

  setTimeout(() => {
    try {
      let editorWin = null;
      if (process.env.OPEN_EDITOR === "1") {
        // Create editor window if explicitly requested
        editorWin = new BrowserWindow({
          width: 900,
          height: 720,
          title: "Comnyang Dev - Desktop Companion & Pattern Editor",
          backgroundColor: "#1e1e1e",
          icon: path.join(__dirname, "assets", "comnyang-logo.png"),
          webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        editorWin.setMenu(null);
        editorWin.loadFile(path.join(__dirname, "editor", "index.html"));
        editorWin.show();
        editorWin.focus();
        editorWin.moveTop();
        console.log("[Comnyang] Editor window opened!");
      }

      // Also ensure the desktop pet has taskbar enabled and is centered
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed() && win !== editorWin) {
          try { win.setSkipTaskbar(false); } catch (_) {}
          try { win.show(); } catch (_) {}
          try { win.focus(); } catch (_) {}
          try { win.setAlwaysOnTop(true, "screen-saver"); } catch (_) {}
          try { win.webContents.send("cat-open-chat"); } catch (_) {}
        }
      }
    } catch (e) {
      console.error("[start-agent] failed to open editor:", e);
    }
  }, 1000);
});
