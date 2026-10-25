"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { inferShortcut, spotifyTrack } = require("../agent-shortcuts");

for (const text of ["help", "what can you do?", "hello", "hi!"]) {
  test(`${text} works locally`, () => assert.ok(inferShortcut(text).reply));
}
test("common natural-language greetings and identity questions work without provider latency", () => {
  assert.match(inferShortcut("yo").reply, /ready to help/i);
  assert.match(inferShortcut("who are you?").reply, /personal desktop cat assistant/i);
  assert.match(inferShortcut("thanks").reply, /welcome/i);
});
test("task and memory shortcuts preserve content", () => {
  assert.deepEqual(inferShortcut("list tasks").action, { type: "list_tasks" });
  assert.deepEqual(inferShortcut("list reminders").action, { type: "list_reminders" });
  assert.deepEqual(inferShortcut("add task: Finish AI project").action, { type: "create_task", title: "Finish AI project" });
  assert.deepEqual(inferShortcut("remember project: AI cat").action, { type: "remember", key: "project", value: "AI cat" });
});
test("Unstop public shortcuts do not imply an account connection", () => {
  assert.equal(inferShortcut("open Unstop").action.url, "https://unstop.com/");
  assert.match(inferShortcut("open Unstop").reply, /not signed in/);
  assert.equal(inferShortcut("find hackathons on Unstop").action.url, "https://unstop.com/hackathons");
  assert.equal(inferShortcut("show internships on Unstop").action.url, "https://unstop.com/internships");
  const result = inferShortcut("find AI & ML hackathons on Unstop");
  assert.equal(new URL(result.action.url).searchParams.get("q"), "site:unstop.com AI & ML hackathons");
  assert.match(result.reply, /Google site search/);
  assert.deepEqual(inferShortcut("open Unstop SmartHire").action, { type: "open_app", name: "Unstop SmartHire" });
});
test("song queries keep titles before provider names and encode punctuation", () => {
  assert.equal(inferShortcut("play music").action.url, "https://music.youtube.com/");
  const title = "Love & War / तू";
  for (const provider of ["Spotify", "YouTube", "YouTube Music", "Apple Music"]) {
    const answer = inferShortcut(`play ${title} on ${provider}`);
    assert.equal(answer.action.type, "open_url");
    assert.ok(decodeURIComponent(answer.action.url).includes(title));
    assert.match(answer.reply, /does not start playback automatically/);
  }
  assert.equal(new URL(inferShortcut("play yellow").action.url).searchParams.get("search_query"), "yellow");
});
test("native playback needs an explicit player", () => {
  assert.equal(inferShortcut("pause music").action, null);
  for (const command of ["pause", "resume", "next", "previous"]) {
    assert.deepEqual(inferShortcut(`${command} song on Spotify`).action, { type: "music_control", player: "spotify", command });
  }
  assert.deepEqual(inferShortcut("resume music on Apple Music").action, { type: "music_control", player: "music", command: "resume" });
  assert.equal(inferShortcut("what is playing on Spotify?").action.command, "status");
});
test("Spotify links and URIs are validated", () => {
  const id = "0123456789012345678901";
  assert.equal(spotifyTrack(`https://open.spotify.com/track/${id}?si=share`), `spotify:track:${id}`);
  assert.equal(inferShortcut(`play https://open.spotify.com/track/${id}`).action.command, "play_track");
  for (const value of ["spotify:track:x", `https://evil.test/track/${id}`, `https://user:pass@open.spotify.com/track/${id}`, "spotify:track:foo\" & do shell script"]) {
    assert.equal(spotifyTrack(value), null);
  }
});
for (const text of [
  "explain https://example.com", "don't open YouTube", "what does open Spotify mean?",
  "do not play Yellow on Spotify", 'he said "play music"', "open https://user:password@example.com",
  "play Yellow on SomeOtherMusicApp", "next steps", "open Spotify and delete my files",
]) {
  test(`not a fast action: ${text}`, () => assert.equal(inferShortcut(text), null));
}
test("opening a URL requires an explicit intent and returns canonical action", () => {
  assert.equal(inferShortcut("open https://example.com").action.url, "https://example.com/");
  assert.equal(inferShortcut("please open Chrome").action.name, "Google Chrome");
});
test("connectivity and workflow shortcuts are recognized", () => {
  assert.deepEqual(inferShortcut("plan my day").action, { type: "generate_workflow" });
  assert.deepEqual(inferShortcut("give me a workflow").action, { type: "generate_workflow" });
  assert.deepEqual(inferShortcut("what is remaining").action, { type: "generate_workflow" });
  assert.deepEqual(inferShortcut("check my status").action, { type: "generate_workflow" });
  assert.deepEqual(inferShortcut("check my gmail").action, { type: "check_gmail" });
  assert.deepEqual(inferShortcut("check unread emails").action, { type: "check_gmail" });
  assert.deepEqual(inferShortcut("check calendar").action, { type: "check_calendar" });
  assert.deepEqual(inferShortcut("my schedule").action, { type: "check_calendar" });
  assert.deepEqual(inferShortcut("fetch hackathons").action, { type: "check_unstop" });
  assert.deepEqual(inferShortcut("check competitions on unstop").action, { type: "check_unstop" });
});
