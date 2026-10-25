"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeMusicAction, executeMusicAction, buildMusicScript } = require("../agent-music");
const pause = { type: "music_control", player: "spotify", command: "pause" };

test("only fixed players and commands are supported", () => {
  for (const action of [{ ...pause, player: 'Music" & do shell script' }, { ...pause, command: "delete" }, { ...pause, command: "constructor" }]) {
    assert.equal(normalizeMusicAction(action), null);
    assert.throws(() => buildMusicScript(action));
  }
});
test("track URI is data, not script source", async () => {
  const uri = "spotify:track:0123456789012345678901";
  const action = { ...pause, command: "play_track", uri };
  assert.ok(!buildMusicScript(action).includes(uri));
  const answer = await executeMusicAction(action, { platform: "darwin", run: (executable, args, options, done) => {
    assert.equal(executable, "/usr/bin/osascript");
    assert.equal(args.at(-1), uri);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 12000);
    done(null, "playing\nTest Song\nTest Artist");
  } });
  assert.deepEqual(answer, { ok: true, message: "Spotify: playing — Test Song by Test Artist" });
});
test("unsupported platform never spawns", async () => {
  const answer = await executeMusicAction(pause, { platform: "linux", run: () => assert.fail("must not spawn") });
  assert.equal(answer.reason, "unsupported-platform");
});
test("denied Automation and stopped apps are actionable failures", async () => {
  const denied = await executeMusicAction(pause, { platform: "darwin", run: (_bin, _args, _options, done) => done(new Error("Denied"), "", "Not authorized (-1743)") });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "music-permission");
  const stopped = await executeMusicAction(pause, { platform: "darwin", run: (_bin, _args, _options, done) => done(null, "__NOT_RUNNING__") });
  assert.equal(stopped.reason, "music-not-running");
});
test("observed state is reported, never invented playback success", async () => {
  const answer = await executeMusicAction({ ...pause, command: "resume" }, {
    platform: "darwin", run: (_bin, _args, _options, done) => done(null, "stopped"),
  });
  assert.equal(answer.message, "Spotify: stopped");
  const empty = await executeMusicAction(pause, { platform: "darwin", run: (_bin, _args, _options, done) => done(null, "") });
  assert.equal(empty.ok, false);
});
