"use strict";

const { execFile } = require("node:child_process");
const { spotifyTrack } = require("./agent-shortcuts");
const COMMANDS = { pause: "pause", resume: "play", next: "next track", previous: "previous track", status: "" };

function normalizeMusicAction(value) {
  if (!value || value.type !== "music_control" || !["spotify", "music"].includes(value.player)) return null;
  const { player, command } = value;
  if (command === "play_track" && player === "spotify") {
    const uri = spotifyTrack(value.uri);
    return uri ? { type: "music_control", player, command, uri } : null;
  }
  return Object.hasOwn(COMMANDS, command) ? { type: "music_control", player, command } : null;
}

function buildMusicScript(action) {
  const normalized = normalizeMusicAction(action);
  if (!normalized) throw new Error("Unsupported music action.");
  const app = normalized.player === "spotify" ? "Spotify" : "Music";
  // Only allowlisted app/command literals become source. Track URI is argv data,
  // never interpolated as AppleScript or shell code. Dictionaries verified locally.
  const command = normalized.command === "play_track" ? "play track (item 1 of argv)" : COMMANDS[normalized.command];
  return `on run argv
  if application "${app}" is not running then return "__NOT_RUNNING__"
  tell application "${app}"
    ${command}
    set playbackState to player state as text
    try
      set trackTitle to name of current track as text
      set trackArtist to artist of current track as text
      return playbackState & linefeed & trackTitle & linefeed & trackArtist
    on error
      return playbackState
    end try
  end tell
end run`;
}

async function executeMusicAction(value, { platform = process.platform, run = execFile } = {}) {
  const action = normalizeMusicAction(value);
  if (!action) return { ok: false, reason: "invalid-action", message: "Unsupported music action." };
  if (platform !== "darwin") return { ok: false, reason: "unsupported-platform", message: "Desktop playback controls currently require macOS. Song searches still work in the browser." };
  const app = action.player === "spotify" ? "Spotify" : "Music";
  return new Promise((resolve) => {
    run("/usr/bin/osascript", ["-e", buildMusicScript(action), ...(action.uri ? [action.uri] : [])],
      { timeout: 12_000, maxBuffer: 16_384, encoding: "utf8", shell: false }, (error, stdout, stderr) => {
        if (error) {
          const denied = /-1743|not authorized|not permitted/i.test(String(stderr || ""));
          resolve({ ok: false, reason: denied ? "music-permission" : "music-error", message: denied
            ? `macOS denied control of ${app}. Enable permission for the cat/Electron in System Settings → Privacy & Security → Automation, then retry.`
            : `Could not confirm playback in ${app}. Open the app, sign in, and select a playable track. If macOS asks, allow Automation for the cat.` });
          return;
        }
        const [state, title, artist] = String(stdout || "").trim().split(/\r?\n/);
        if (state === "__NOT_RUNNING__") {
          resolve({ ok: false, reason: "music-not-running", message: `Open ${app} and select a track first, then retry. You can ask “open ${app}”.` });
          return;
        }
        if (!["playing", "paused", "stopped"].includes(state)) {
          resolve({ ok: false, reason: "music-error", message: `No playback status was returned by ${app}. Check the app before retrying.` });
          return;
        }
        const track = title ? ` — ${title}${artist ? ` by ${artist}` : ""}` : "";
        // Report the observed state, not an invented guarantee about a requested song.
        resolve({ ok: true, message: `${app}: ${state}${track}`.slice(0, 500) });
      });
  });
}

module.exports = { normalizeMusicAction, buildMusicScript, executeMusicAction };
