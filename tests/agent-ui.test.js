"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
const source = fs.readFileSync(path.join(root, "renderer/agent-ui.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const publicState = { config: { baseUrl: "https://example.test/v1", model: "existing-model", apiKeyConfigured: true } };
const reminder = { type: "create_reminder", time: "10:00", message: "Stretch", repeat: "none" };
const approvalReply = {
  ok: true, reply: "May I set this reminder?", action: reminder,
  confirmationRequired: true, approvalToken: "test-approval", actionDescription: "Remind me to stretch at 10:00",
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function flush() { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }

// Minimal DOM/event and deterministic timer harness. It loads the actual HTML
// hierarchy so hidden/inert ancestors and focus are exercised without packages.
// Layout/native Electron behavior still needs a visual smoke check.
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type, values = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
}

function makeDocument() {
  const nodes = new Map();
  const document = { getElementById: (id) => nodes.get(id) };
  class Element extends Events {
    constructor(tag, attributes, parent) {
      super();
      this.tag = tag;
      this.attributes = attributes;
      this.parentElement = parent;
      this.children = [];
      this.dataset = {};
      this.value = "";
      this.textContent = "";
      this.disabled = false;
      this.readOnly = false;
      this.style = {};
      this.rect = { left: 16, right: 264, top: 10, bottom: 42, width: 248, height: 32 };
      const classes = new Set();
      this.classList = { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), contains: (name) => classes.has(name) };
      for (const [name, value] of attributes) this.setAttribute(name, value);
      parent?.children.push(this);
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_all, c) => c.toUpperCase())] = String(value);
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    toggleAttribute(name, force = !this.hasAttribute(name)) {
      if (force) this.setAttribute(name, ""); else this.removeAttribute(name);
      return force;
    }
    get hidden() { return this.hasAttribute("hidden"); }
    set hidden(value) { this.toggleAttribute("hidden", value); }
    get inert() { return this.hasAttribute("inert"); }
    set inert(value) { this.toggleAttribute("inert", value); }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    closest(selector) {
      const selectors = selector.split(",").map((part) => part.trim());
      for (let node = this; node; node = node.parentElement) {
        if (selectors.some((part) => part.startsWith("[") ? node.hasAttribute(part.slice(1, -1)) : node.tag === part)) return node;
      }
      return null;
    }
    querySelectorAll(selector) {
      const tags = selector.split(",").map((part) => part.trim());
      return this.children.flatMap((child) => [...(tags.includes(child.tag) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    focus() {
      if (!this.disabled && !this.closest("[hidden], [inert]")) document.activeElement = this;
    }
    blur() { if (document.activeElement === this) document.activeElement = document.body; }
    getBoundingClientRect() { return this.rect; }
  }
  const stack = [];
  const voidTags = new Set(["meta", "link", "input", "br", "hr", "img"]);
  for (const match of html.matchAll(/<(\/)?([a-z][\w-]*)\b([^>]*?)(\/?)>/gi)) {
    const [, closing, tag, rawAttributes, selfClosing] = match;
    if (closing) { stack.pop(); continue; }
    const attributes = new Map();
    for (const attr of rawAttributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes.set(attr[1], attr[2] || "");
    const element = new Element(tag, attributes, stack.at(-1));
    if (attributes.has("id")) nodes.set(attributes.get("id"), element);
    if (tag === "body") document.body = element;
    if (!selfClosing && !voidTags.has(tag)) stack.push(element);
  }
  document.activeElement = document.body;
  nodes.get("agent-search-toggle").rect = { left: 127, right: 153, top: 10, bottom: 36, width: 26, height: 26 };
  nodes.get("agent-settings-popover").rect = { left: 16, right: 264, top: 46, bottom: 240, width: 248, height: 194 };
  nodes.get("agent-response").rect = { left: 16, right: 264, top: 72, bottom: 230, width: 248, height: 158 };
  nodes.get("agent-quick-commands").children.forEach((node, i) => {
    node.rect = { left: 16 + i * 63, right: 75 + i * 63, top: 46, bottom: 68, width: 59, height: 22 };
  });
  return document;
}

function makeClock() {
  let now = 0, next = 0;
  const timers = new Map();
  const add = (fn, delay, repeat = false) => {
    const id = ++next;
    timers.set(id, { fn, at: now + delay, delay, repeat });
    return id;
  };
  return {
    timers, now: () => now,
    setTimeout: (fn, delay) => add(fn, delay), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => add(fn, delay, true), clearInterval: (id) => timers.delete(id),
    async tick(duration) {
      const end = now + duration;
      for (;;) {
        const entry = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, timer] = entry;
        now = timer.at;
        if (timer.repeat) timer.at += timer.delay; else timers.delete(id);
        timer.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

async function setup(options = {}) {
  const document = makeDocument();
  const clock = makeClock();
  const window = new Events();
  const calls = { asks: [], config: [], tests: 0, fetch: [], actions: [], reminders: [], interaction: [], state: 0 };
  const api = {
    getState: () => { calls.state += 1; return options.getState ? options.getState() : publicState; },
    updateConfig: (values) => { calls.config.push(plain(values)); return options.updateConfig ? options.updateConfig(values) : publicState.config; },
    testConnection: () => { calls.tests += 1; return options.testConnection ? options.testConnection() : { ok: true, model: "existing-model", elapsedMs: 12 }; },
    ask: (prompt) => { calls.asks.push(prompt); return options.ask ? options.ask(prompt) : { ok: true, reply: "A useful reply." }; },
    executeAction: (payload) => { calls.actions.push(plain(payload)); return options.executeAction ? options.executeAction(payload) : { ok: false, reason: "renderer-action" }; },
    setInteractionActive: (active) => calls.interaction.push(active),
  };
  window.agentAPI = options.rpcOnly ? undefined : api;
  window.innerWidth = 280;
  window.innerHeight = 250;
  window.electronAPI = {
    reminderAdd: (action) => { calls.reminders.push(plain(action)); return options.reminderAdd ? options.reminderAdd(action) : { ok: true }; },
    onCursorPos: (callback) => { window.cursor = callback; },
  };
  window.voiceAPI = { onVoiceHeard: (callback) => { window.voice = callback; } };
  const context = vm.createContext({
    window, document, console, AbortController,
    Date: { now: clock.now },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    getComputedStyle: (element) => ({
      display: element.hidden || (element === document.getElementById("agent-search-toggle") && !document.getElementById("agent-panel").hidden) ? "none" : "block",
      visibility: "visible", pointerEvents: "auto", opacity: "1", ...element.style,
    }),
    fetch: (url, init) => {
      calls.fetch.push({ url, init });
      return options.fetch ? options.fetch(url, init) : Promise.reject(new Error("Unexpected RPC request"));
    },
  });
  vm.runInContext(source, context, { filename: "renderer/agent-ui.js" });
  await flush();
  const get = (id) => document.getElementById(id);
  const click = async (id) => { get(id).emit("click"); await flush(); };
  const ask = async (prompt) => {
    if (get("agent-panel").hidden) await click("agent-search-toggle");
    get("agent-search-input").value = prompt;
    get("agent-search-form").emit("submit");
    await flush();
  };
  return { document, window, calls, clock, get, click, ask };
}

test("startup is compact, inert, unfocused and uses public IPC state without an RPC token", async () => {
  const h = await setup();
  assert.equal(h.get("agent-panel").hidden, true);
  assert.equal(h.get("agent-panel").inert, true);
  assert.equal(h.get("agent-search-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(h.document.activeElement, h.document.body);
  assert.equal(h.calls.state, 1);
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(h.get("agent-model").value, "existing-model");
  await h.click("agent-search-toggle");
  assert.equal(h.document.activeElement, h.get("agent-search-input"));
  assert.equal(h.get("agent-panel").inert, false);
});

test("in-flight elapsed/wait status, duplicate guard, and friendly abort preserve a retryable prompt", async () => {
  const first = deferred();
  let attempts = 0;
  const h = await setup({ ask: () => ++attempts === 1 ? first.promise : { ok: true, reply: "Recovered answer." } });
  await h.ask("Explain my task");
  assert.equal(h.get("agent-search-input").value, "Explain my task");
  assert.equal(h.get("agent-search-input").readOnly, true);
  assert.equal(h.get("agent-search-send").disabled, true);
  h.get("agent-search-form").emit("submit");
  h.window.voice("Do something else");
  await h.clock.tick(11_000);
  assert.match(h.get("agent-response-status").textContent, /11s/);
  assert.match(h.get("agent-response-text").textContent, /Still waiting/);
  assert.equal(h.calls.asks.length, 1);
  first.reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
  await flush();
  assert.equal(h.get("agent-search-input").readOnly, false);
  assert.equal(h.get("agent-search-input").disabled, false);
  assert.equal(h.get("agent-search-send").disabled, false);
  assert.equal(h.get("agent-search-input").value, "Explain my task");
  assert.equal(h.get("agent-response-retry").hidden, false);
  assert.match(h.get("agent-response-text").textContent, /prompt is saved/);
  assert.doesNotMatch(h.get("agent-response-text").textContent, /This operation was aborted/);
  await h.clock.tick(120_000);
  assert.equal(h.get("agent-response").hidden, false);
  assert.match(h.get("agent-response-text").textContent, /prompt is saved/);
  h.get("agent-search-input").value = "Different unsent draft";
  await h.click("agent-response-retry");
  assert.deepEqual(h.calls.asks, ["Explain my task", "Explain my task"]);
  assert.equal(h.get("agent-response-text").textContent, "Recovered answer.");
  assert.equal(h.get("agent-response-retry").hidden, true);
  assert.equal(h.clock.timers.size, 0);
});

test("persistent results are plain text, survive closing/reopening, and do not steal focus on completion", async () => {
  const pending = deferred();
  const h = await setup({ ask: () => pending.promise });
  const reply = "<img src=x onerror=alert(1)>\n" + "Readable long answer. ".repeat(100);
  await h.ask("Long answer please");
  await h.click("agent-search-hide");
  pending.resolve({ ok: true, reply });
  await flush();
  assert.equal(h.get("agent-panel").hidden, true);
  assert.equal(h.document.activeElement, h.get("agent-search-toggle"));
  assert.equal(h.get("agent-search-toggle").hasAttribute("data-attention"), true);
  await h.clock.tick(600_000);
  await h.click("agent-search-toggle");
  assert.equal(h.get("agent-response-text").textContent, reply);
  assert.equal(h.get("agent-response").hidden, false);
  await h.click("agent-response-close");
  assert.equal(h.get("agent-response").hidden, true);
  assert.equal(h.document.activeElement, h.get("agent-search-input"));
});

test("stale dismissal and progress callbacks cannot clear a newer persistent reply or approval", async () => {
  const pending = deferred();
  let count = 0;
  const h = await setup({ ask: () => ++count === 2 ? pending.promise : approvalReply });
  await h.ask("Set a reminder");
  await h.click("agent-action-reject");
  const dismissal = [...h.clock.timers.values()].find((timer) => timer.delay === 3000).fn;
  await h.ask("Ask again");
  const progress = [...h.clock.timers.values()].find((timer) => timer.repeat).fn;
  dismissal();
  assert.equal(h.get("agent-response").hidden, false);
  pending.resolve({ ok: true, reply: "New persistent answer." });
  await flush();
  dismissal();
  progress();
  await h.clock.tick(30_000);
  assert.equal(h.get("agent-response-text").textContent, "New persistent answer.");
  await h.ask("Approval again");
  dismissal();
  progress();
  await h.clock.tick(60_000);
  assert.equal(h.get("agent-action-confirm").hidden, false);
  assert.equal(h.get("agent-response").hidden, false);
  assert.equal(h.get("agent-response-text").textContent, approvalReply.reply);
});

test("hung IPC releases input after a bounded wait; late results cannot replace a later request", async () => {
  const old = deferred();
  let count = 0;
  const h = await setup({ ask: () => ++count === 1 ? old.promise : { ok: true, reply: "Current result" } });
  await h.ask("Old request");
  await h.clock.tick(90_000);
  assert.equal(h.get("agent-search-input").readOnly, false);
  assert.equal(h.get("agent-response-retry").hidden, false);
  await h.ask("New request");
  old.resolve(approvalReply);
  await flush();
  assert.equal(h.get("agent-response-text").textContent, "Current result");
  assert.equal(h.get("agent-action-confirm").hidden, true);
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(h.clock.timers.size, 0);
});

test("reminderAdd is gated on an explicit validated renderer-action result", async (t) => {
  for (const [name, result, allowed] of [
    ["validated", { ok: false, reason: "renderer-action" }, true],
    ["approval denied", { ok: false, reason: "approval-required" }, false],
    ["action error", { ok: false, reason: "action-error", message: "Failed" }, false],
    ["missing result", undefined, false],
    ["missing ok flag", { reason: "renderer-action" }, false],
    ["already handled", { ok: true, message: "Handled by backend" }, false],
    ["throw", new Error("IPC unavailable"), false],
  ]) {
    await t.test(name, async () => {
      const h = await setup({ ask: () => approvalReply, executeAction: () => { if (result instanceof Error) throw result; return result; } });
      await h.ask("Remind me to stretch");
       await h.click("agent-action-approve");
       await h.click("agent-action-approve");
       assert.equal(h.calls.reminders.length, allowed ? 1 : 0);
       assert.deepEqual(h.calls.actions, [{ action: reminder, approvalToken: "test-approval", decision: "always" }]);
       assert.equal(h.get("agent-search-input").readOnly, false);
       if (allowed) assert.match(h.get("agent-response-text").textContent, /Reminder set for 10:00/);
       if (result?.ok !== true && !allowed) {
         assert.equal(h.get("agent-response-retry").hidden, false);
         assert.equal(h.get("agent-search-input").value, "Remind me to stretch");
         const retryUsesAction = result?.reason !== "approval-required";
         await h.click("agent-response-retry");
         assert.equal(h.calls.asks.length, retryUsesAction ? 1 : 2);
         assert.equal(h.calls.actions.length, retryUsesAction ? 2 : 1);
       }
    });
  }
});

test("failed approved actions retry instantly without another model request", async () => {
  let attempts = 0;
  const h = await setup({
    ask: () => approvalReply,
    executeAction: () => ++attempts === 1
      ? { ok: false, reason: "music-error", message: "Player was not ready" }
      : { ok: true, message: "Spotify: paused" },
  });
  await h.ask("Pause Spotify");
  await h.click("agent-action-approve");
  assert.equal(h.calls.asks.length, 1);
  assert.equal(h.get("agent-response-retry").hidden, false);
  await h.click("agent-response-retry");
  assert.equal(h.calls.asks.length, 1, "Retry should bypass the model");
  assert.equal(h.calls.actions.length, 2);
  assert.equal(h.get("agent-response-text").textContent, "Spotify: paused");
});

test("permission choices are explicit and saved grants can auto-run a validated renderer action", async () => {
  const once = await setup({ ask: () => approvalReply, executeAction: () => ({ ok: false, reason: "renderer-action" }) });
  await once.ask("Remind me once");
  await once.click("agent-action-allow-once");
  assert.deepEqual(once.calls.actions, [{ action: reminder, approvalToken: "test-approval", decision: "once" }]);
  assert.equal(once.calls.reminders.length, 1);

  const saved = await setup({
    ask: () => ({ ok: true, reply: "I will set it up.", action: reminder, confirmationRequired: false, autoExecuteAction: true }),
    executeAction: (payload) => {
      assert.equal(payload.approvalToken, "");
      assert.equal(payload.decision, "always");
      return { ok: false, reason: "renderer-action" };
    },
  });
  await saved.ask("Remind me again");
  assert.equal(saved.get("agent-action-confirm").hidden, true);
  assert.equal(saved.calls.reminders.length, 1);
});

test("late approval validation after timeout never reaches reminderAdd", async () => {
  const pending = deferred();
  const h = await setup({ ask: () => approvalReply, executeAction: () => pending.promise });
  await h.ask("Remind me");
  await h.click("agent-action-approve");
  await h.clock.tick(20_000);
  assert.equal(h.get("agent-search-input").readOnly, false);
  assert.match(h.get("agent-response-text").textContent, /couldn't confirm/);
  pending.resolve({ ok: false, reason: "renderer-action" });
  await flush();
  assert.equal(h.calls.reminders.length, 0);
});

test("malformed approval, declined approval, and failed reminder save stay recoverable", async () => {
  const malformed = await setup({ ask: () => ({ ...approvalReply, approvalToken: "" }) });
  await malformed.ask("Remind me");
  assert.equal(malformed.get("agent-action-confirm").hidden, true);
  assert.equal(malformed.get("agent-response-retry").hidden, false);
  const declined = await setup({ ask: () => approvalReply });
  await declined.ask("Remind me");
  await declined.click("agent-action-reject");
  assert.equal(declined.calls.actions.length, 0);
  assert.equal(declined.calls.reminders.length, 0);
  const failed = await setup({ ask: () => approvalReply, reminderAdd: () => ({ ok: false }) });
  await failed.ask("Remind me");
  await failed.click("agent-action-approve");
  assert.equal(failed.calls.reminders.length, 1);
  assert.equal(failed.get("agent-search-input").readOnly, false);
  assert.equal(failed.get("agent-response-retry").hidden, false);
});

test("quick commands submit the exact requested prompts without asserting connected accounts or playback", async () => {
  const h = await setup();
  await h.click("agent-search-toggle");
  for (const button of h.get("agent-quick-commands").children) {
    button.emit("click");
    await flush();
  }
  assert.deepEqual(h.calls.asks, ["open Unstop", "play music", "list tasks", "help"]);
});

test("hidden/inert hit targets do not intercept clicks; closing restores focus and native cursor polling works", async () => {
  const h = await setup();
  h.window.emit("mousemove", { clientX: 30, clientY: 25 });
  assert.deepEqual(h.calls.interaction, []);
  h.window.cursor({ dx: 0, dy: -105 });
  assert.deepEqual(h.calls.interaction, [true]);
  h.window.cursor({ dx: -135, dy: 120 });
  assert.deepEqual(h.calls.interaction, [true, false]);
  await h.click("agent-search-toggle");
  h.window.emit("mousemove", { clientX: 30, clientY: 25 });
  assert.equal(h.calls.interaction.at(-1), true);
  await h.click("agent-search-hide");
  assert.equal(h.calls.interaction.at(-1), false);
  assert.equal(h.document.activeElement, h.get("agent-search-toggle"));
  h.get("agent-search-input").focus();
  assert.equal(h.document.activeElement, h.get("agent-search-toggle"));
  const escape = h.window.emit("keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, false);
  await h.ask("Show a response");
  await h.click("agent-search-settings");
  assert.equal(h.get("agent-response").inert, true);
  assert.equal(h.get("agent-quick-commands").inert, true);
  h.window.emit("keydown", { key: "Escape" });
  assert.equal(h.get("agent-settings-popover").hidden, true);
  assert.equal(h.get("agent-response").inert, false);
  assert.equal(h.document.activeElement, h.get("agent-search-settings"));
  h.window.emit("keydown", { key: "Escape" });
  assert.equal(h.get("agent-panel").hidden, true);
});

test("config saves/forgets use narrow IPC, preserve endpoint/model choice, and surface returned failures", async () => {
  let fail = false;
  const h = await setup({ updateConfig: () => fail ? { ok: false, message: "Save rejected" } : publicState.config });
  await h.click("agent-search-toggle");
  await h.click("agent-search-settings");
  h.get("agent-api-key").value = "test-key";
  h.get("agent-config-form").emit("submit");
  await flush();
  assert.deepEqual(h.calls.config[0], { baseUrl: publicState.config.baseUrl, model: publicState.config.model, apiKey: "test-key" });
  assert.equal(h.get("agent-api-key").value, "");
  await h.click("agent-api-key-clear");
  assert.deepEqual(h.calls.config[1], { baseUrl: publicState.config.baseUrl, model: publicState.config.model, clearApiKey: true });
  fail = true;
  h.get("agent-api-key").value = "retry-key";
  h.get("agent-config-form").emit("submit");
  await flush();
  assert.equal(h.get("agent-config-status").textContent, "Save rejected");
  assert.equal(h.get("agent-api-key").value, "retry-key");
  assert.equal(h.get("agent-api-key").disabled, false);
  assert.equal(h.calls.fetch.length, 0);
});

test("connection test reports accepted keys and actionable provider failures", async () => {
  let result = { ok: true, model: "existing-model", elapsedMs: 12 };
  const h = await setup({ testConnection: () => result });
  await h.click("agent-search-toggle");
  await h.click("agent-search-settings");
  await h.click("agent-connection-test");
  assert.equal(h.calls.tests, 1);
  assert.match(h.get("agent-config-status").textContent, /Connected to existing-model.*API key accepted/);
  result = { ok: false, reason: "AGENT_AUTH", message: "provider rejected authentication" };
  await h.click("agent-connection-test");
  assert.match(h.get("agent-config-status").textContent, /API key was rejected/);
});

test("connection test gives immediate visible progress while the provider is pending", async () => {
  const pending = deferred();
  const h = await setup({ testConnection: () => pending.promise });
  await h.click("agent-search-toggle");
  await h.click("agent-search-settings");
  const click = h.get("agent-connection-test").emit("click");
  await flush();
  assert.equal(click.defaultPrevented, true);
  assert.equal(h.get("agent-config-status").textContent, "Checking the API connection…");
  assert.equal(h.get("agent-connection-test").disabled, true);
  pending.resolve({ ok: true, model: "existing-model", elapsedMs: 4 });
  await flush();
  assert.match(h.get("agent-config-status").textContent, /API key accepted/);
  assert.equal(h.get("agent-connection-test").textContent, "Check API connection");
});

test("late startup state cannot overwrite a completed connection result", async () => {
  const startup = deferred();
  const h = await setup({
    getState: () => startup.promise,
    testConnection: () => ({ ok: true, model: "existing-model", elapsedMs: 4 }),
  });
  await h.click("agent-search-toggle");
  await h.click("agent-search-settings");
  await h.click("agent-connection-test");
  startup.resolve({ ...publicState, config: { ...publicState.config, apiKeyStatus: "late state" } });
  await flush();
  assert.match(h.get("agent-config-status").textContent, /API key accepted/);
});

test("connection checks allow slow generation beyond the old 20-second UI cutoff", async () => {
  const pending = deferred();
  const h = await setup({ testConnection: () => pending.promise });
  await h.click("agent-connection-test");
  await h.clock.tick(30_000);
  assert.equal(h.get("agent-connection-test").disabled, true);
  assert.match(h.get("agent-config-status").textContent, /30s/);
  pending.resolve({ ok: true, model: "existing-model", elapsedMs: 30_000 });
  await flush();
  assert.match(h.get("agent-config-status").textContent, /Connected to existing-model/);
  assert.equal(h.get("agent-connection-test").disabled, false);
  assert.equal(h.clock.timers.size, 0);
});

test("provider timeout in settings is not mislabeled as a saved chat prompt or billing failure", async () => {
  const h = await setup({ testConnection: () => ({ ok: false, reason: "AGENT_TIMEOUT", elapsedMs: 55_000 }) });
  await h.click("agent-connection-test");
  const text = h.get("agent-config-status").textContent;
  assert.match(text, /provider.*timed out/i);
  assert.match(text, /Check API connection/);
  assert.doesNotMatch(text, /prompt is saved|please Retry|enable billing|API key was rejected/i);
  assert.equal(h.get("agent-connection-test").disabled, false);
  assert.equal(h.clock.timers.size, 0);
});

test("settings distinguishes failed key lookup from verified lookup and stalled generation", async () => {
  let result = { ok: false, reason: "AGENT_TIMEOUT", stage: "model-access", modelAccessVerified: false, elapsedMs: 10000 };
  const h = await setup({ testConnection: () => result });
  await h.click("agent-connection-test");
  assert.match(h.get("agent-config-status").textContent, /lookup timed out.*before any generation/);
  result = { ...result, stage: "generation", modelAccessVerified: true, elapsedMs: 55000 };
  await h.click("agent-connection-test");
  assert.match(h.get("agent-config-status").textContent, /accepted the key for model lookup.*generation timed out/);
  assert.match(h.get("agent-config-status").textContent, /Chat is not ready/);
  assert.doesNotMatch(h.get("agent-config-status").textContent, /Connected to/);
  result = { ok: false, reason: "AGENT_NETWORK", networkCode: "ERR_PROXY_CONNECTION_FAILED", message: "Check system proxy settings." };
  await h.click("agent-connection-test");
  assert.match(h.get("agent-config-status").textContent, /system proxy settings.*ERR_PROXY_CONNECTION_FAILED/);
});

test("the blank secret field explains that an existing saved key is retained", async () => {
  const h = await setup();
  assert.equal(h.get("agent-api-key").value, "");
  assert.match(h.get("agent-api-key").placeholder, /Saved key.*leave blank/);
  await h.click("agent-connection-test");
  assert.equal(Object.hasOwn(h.calls.config[0], "apiKey"), false);
  assert.match(h.get("agent-api-key").placeholder, /Saved key/);
});

test("unresponsive backend is bounded and distinguished from a provider timeout", async () => {
  const pending = deferred();
  const h = await setup({ testConnection: () => pending.promise });
  await h.click("agent-connection-test");
  await h.clock.tick(65_000);
  assert.equal(h.get("agent-connection-test").disabled, false);
  assert.match(h.get("agent-config-status").textContent, /cat.*did not respond/i);
  assert.doesNotMatch(h.get("agent-config-status").textContent, /prompt is saved/i);
  const failure = h.get("agent-config-status").textContent;
  pending.resolve({ ok: true, model: "stale-result" });
  await flush();
  await h.clock.tick(5000);
  assert.equal(h.get("agent-config-status").textContent, failure);
  assert.equal(h.clock.timers.size, 0);
});

test("late startup state never overwrites edited settings", async () => {
  const pending = deferred();
  const h = await setup({ getState: () => pending.promise });
  await h.click("agent-search-toggle");
  await h.click("agent-search-settings");
  h.get("agent-model").value = "my-choice";
  h.get("agent-config-form").emit("input");
  pending.resolve(publicState);
  await flush();
  assert.equal(h.get("agent-model").value, "my-choice");
});

test("RPC fallback waits briefly for its token and bounds a hanging response body", async () => {
  const h = await setup({ rpcOnly: true, fetch: async (_url, init) => {
    const { method } = JSON.parse(init.body);
    return { ok: true, json: () => method === "state-get" ? publicState : new Promise(() => {}) };
  } });
  assert.equal(h.calls.fetch.length, 0);
  await h.clock.tick(100);
  h.window.__COMNYANG_AGENT_TOKEN = "test-rpc-token";
  await h.clock.tick(50);
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.fetch[0].init.headers["X-Comnyang-Agent-Token"], "test-rpc-token");
  await h.ask("Bounded RPC question");
  await h.clock.tick(90_000);
  assert.equal(h.get("agent-search-input").readOnly, false);
  assert.equal(h.get("agent-response-retry").hidden, false);
  assert.equal(h.calls.fetch[1].init.signal.aborted, true);
  assert.equal(h.clock.timers.size, 0);
});

test("missing RPC token stops polling and leaves a usable retry", async () => {
  const h = await setup({ rpcOnly: true });
  await h.ask("Question before startup");
  await h.clock.tick(2000);
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(h.get("agent-response-retry").hidden, false);
  assert.equal(h.get("agent-search-input").readOnly, false);
  assert.equal(h.clock.timers.size, 0);
});

test("preload exposes narrow contracts and arbitrates agent/pet click-through independently", async () => {
  const exposed = {}, invokes = [], sends = [];
  vm.runInNewContext(preload, {
    require: (name) => {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
        ipcRenderer: {
          invoke: (...args) => { invokes.push(args); return Promise.resolve({ ok: true }); },
          send: (...args) => sends.push(args), on() {},
        },
      };
    },
  }, { filename: "preload.js" });
  await exposed.agentAPI.getState();
  await exposed.agentAPI.updateConfig({ model: "existing-model" });
  await exposed.agentAPI.testConnection();
  await exposed.agentAPI.ask("help");
  await exposed.agentAPI.executeAction({ action: reminder, approvalToken: "test" });
  assert.deepEqual(plain(invokes), [
    ["agent-state-get"], ["agent-config-set", { model: "existing-model" }], ["agent-config-test"], ["agent-ask", "help"],
    ["agent-action-execute", { action: reminder, approvalToken: "test" }],
  ]);
  exposed.electronAPI.setMouseEventsEnabled(false);
  exposed.agentAPI.setInteractionActive(true);
  exposed.electronAPI.setMouseEventsEnabled(false);
  exposed.agentAPI.setInteractionActive(false);
  exposed.electronAPI.setMouseEventsEnabled(true);
  exposed.agentAPI.setInteractionActive(true);
  exposed.agentAPI.setInteractionActive(false);
  exposed.electronAPI.setMouseEventsEnabled(false);
  assert.deepEqual(sends, [false, true, false, true, false].map((active) => ["set-mouse-events-enabled", active]));
  assert.equal(exposed.agentAPI.invoke, undefined);
});
