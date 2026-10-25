"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../agent-main.js"), "utf8");

// Exercise the real IPC entry points without touching personal state, opening
// browsers/apps, contacting a model, or sending native playback commands.
function harness(existingFiles = new Map(), options = {}) {
  const handlers = new Map();
  const files = existingFiles;
  const calls = [];
  const fakeFs = {
    mkdirSync() {}, chmodSync() {}, existsSync: (file) => files.has(file),
    readFileSync: (file) => files.get(file), writeFileSync: (file, data) => files.set(file, data),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
  };
  const server = { on() {}, listen() {}, close() {}, listening: false };
  const context = {
    process: { platform: "darwin", env: {}, pid: 1 }, console, URL, Buffer, setTimeout, clearTimeout,
    require: (name) => {
      if (name === "fs") return fakeFs;
      if (name === "http") return { createServer: () => server };
      if (name === "electron") return {
        app: { getPath: () => "/virtual-cat-test", on() {} }, BrowserWindow: {},
        ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, safeStorage: { isEncryptionAvailable: () => false },
        shell: { openExternal: async (url) => { calls.push(["url", url]); }, openPath: async () => "" },
        net: { fetch: options.fetch || (() => assert.fail("unexpected provider request")) },
      };
      if (name === "./agent-shortcuts") return require("../agent-shortcuts");
      if (name === "./app-launcher") return require("../app-launcher");
      if (name === "./google-classroom") return require("../google-classroom");
      if (name === "./gmail-service") return require("../gmail-service");
      if (name === "./calendar-service") return {
        ...require("../calendar-service"),
        isConnected: () => true,
        fetchUpcomingEvents: async () => ({
          ok: true,
          events: [
            { id: "ev-1", title: "CS 301 Lecture", timeFormatted: "Today at 10:00 AM", isToday: true },
            { id: "ev-2", title: "Project Sync", timeFormatted: "Tomorrow at 2:00 PM", isToday: false },
          ],
          todayEvents: [{ id: "ev-1", title: "CS 301 Lecture", timeFormatted: "Today at 10:00 AM", isToday: true }],
          upcomingEvents: [{ id: "ev-2", title: "Project Sync", timeFormatted: "Tomorrow at 2:00 PM", isToday: false }],
        }),
        ...options.calendarService,
      };
      if (name === "./unstop-service") return require("../unstop-service");
      if (name === "./workflow-planner") return require("../workflow-planner");
      if (name === "./agent-music") return {
        ...require("../agent-music"), executeMusicAction: async (action) => { calls.push(["music", action]); return { ok: true, message: "Test player state" }; },
      };
      if (name === "child_process") return {
        execFile: (bin, args, options, done) => { calls.push(["app", bin, args]); done(null); },
        spawn: () => assert.fail("unexpected spawn"),
      };
      if (name === "./agent-model-client") return {
        ...require("../agent-model-client"),
        checkModelAccess: async () => ({ name: "models/mock-model" }),
        requestModel: () => assert.fail("fast commands must bypass model"),
        requestGeminiInteraction: () => assert.fail("fast commands must bypass model"),
        ...options.modelClient,
      };
      return require(name);
    },
  };
  vm.runInNewContext(source, context, { filename: "agent-main.js" });
  const invoke = async (channel, payload) => JSON.parse(JSON.stringify(await handlers.get(channel)({}, payload)));
  return { invoke, calls, context, files };
}

test("fast commands work with no configured API key", async () => {
  const { invoke, calls } = harness();
  const added = await invoke("agent-ask", "add task: Finish project");
  assert.equal(added.ok, true);
  assert.match(added.reply, /Task added: Finish project/);
  const listed = await invoke("agent-ask", "list tasks");
  assert.match(listed.reply, /Finish project/);
  const help = await invoke("agent-ask", "help");
  assert.match(help.reply, /Unstop/);
  assert.equal(calls.length, 0);
});

test("connection test verifies the loaded key without changing conversation history", async () => {
  const configFile = "/virtual-cat-test/agent/config.json";
  const files = new Map([[configFile, JSON.stringify({
    baseUrl: "https://example.test/v1",
    model: "test-model",
    apiKey: "test-only-key",
  })]]);
  const modelCalls = [];
  const h = harness(files, {
    modelClient: {
      getChatEndpoint: () => "https://example.test/v1/chat/completions",
      requestModel: async (request) => {
        modelCalls.push(request);
        return { choices: [{ message: { content: "OK" } }] };
      },
    },
  });
  const before = await h.invoke("agent-state-get");
  const result = await h.invoke("agent-config-test");
  const after = await h.invoke("agent-state-get");
  assert.equal(result.ok, true);
  assert.equal(result.model, "test-model");
  assert.equal(result.reply, "OK");
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].messages.at(-1).role, "user");
  assert.equal(modelCalls[0].messages.at(-1).content, "Reply with exactly OK.");
  assert.equal(after.history.length, before.history.length);
});

test("all production model requests use Electron networking, including access verification", async () => {
  const client = require("../agent-model-client");
  const networkCalls = [];
  const h = harness(new Map(), {
    modelClient: {
      ...client,
      ...Object.fromEntries(["requestModel", "requestGeminiInteraction", "checkModelAccess"].map((name) => [name, (request, dependencies) => {
        assert.equal(typeof dependencies?.fetch, "function", "provider calls must honor the Electron session proxy");
        return client[name](request, dependencies);
      }])),
    },
    fetch: async (url, options) => {
      networkCalls.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify(options.method === "GET"
        ? { name: "models/gemini-3.8-flash" }
        : url.includes("interactions")
          ? { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "OK" }] }] }
          : { choices: [{ message: { content: "OK" } }] }) };
    },
  });
  await h.invoke("agent-config-set", { apiKey: "test-only-key" });
  const result = await h.invoke("agent-config-test");
  assert.equal(result.ok, true);
  assert.equal(result.modelAccessVerified, true);
  assert.equal(result.transport, "chromium");
  await h.invoke("agent-ask", "Explain binary search simply");
  await h.invoke("agent-config-set", { baseUrl: "https://provider.invalid/v1", apiKey: "test-only-key" });
  await h.invoke("agent-ask", "Explain sorting simply");
  assert.equal(networkCalls.length, 4);
  assert.equal(networkCalls[0].options.method, "GET");
  for (const { options } of networkCalls) {
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
  }
});

test("metadata success cannot turn a failed generation into a verified connection", async () => {
  const h = harness(new Map(), { modelClient: {
    checkModelAccess: async () => ({ name: "models/gemini-3.8-flash" }),
    requestGeminiInteraction: async () => { throw Object.assign(new Error("Model timed out"), { code: "AGENT_TIMEOUT" }); },
  } });
  await h.invoke("agent-config-set", { apiKey: "test-only-key" });
  const result = await h.invoke("agent-config-test");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "AGENT_TIMEOUT");
  assert.equal(result.stage, "generation");
  assert.equal(result.modelAccessVerified, true);
  assert.equal((await h.invoke("agent-state-get")).history.length, 0);
});

test("a blocked model lookup returns its stage without sending a generation request", async () => {
  const h = harness(new Map(), { modelClient: {
    checkModelAccess: async () => { throw Object.assign(new Error("Proxy connection failed"), {
      code: "AGENT_NETWORK", networkCode: "ERR_PROXY_CONNECTION_FAILED",
    }); },
    requestGeminiInteraction: () => assert.fail("do not generate before access is checked"),
  } });
  await h.invoke("agent-config-set", { apiKey: "test-only-key" });
  const result = await h.invoke("agent-config-test");
  assert.equal(result.ok, false);
  assert.equal(result.stage, "model-access");
  assert.equal(result.modelAccessVerified, false);
  assert.equal(result.networkCode, "ERR_PROXY_CONNECTION_FAILED");
});

test("connection test exercises real chat generation instead of only metadata access", async () => {
  const configFile = "/virtual-cat-test/agent/config.json";
  const files = new Map([[configFile, JSON.stringify({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
    apiKey: "test-only-key",
  })]]);
  let request;
  const h = harness(files, {
    modelClient: {
      getChatEndpoint: () => "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      requestGeminiInteraction: async (value) => {
        request = value;
        return { choices: [{ message: { content: "OK" } }] };
      },
    },
  });
  const result = await h.invoke("agent-config-test");
  assert.equal(result.ok, true);
  assert.equal(request.maxTokens, 4_096, "the generation budget must include Gemini thinking tokens");
  assert.ok(request.timeoutMs > 50_000 && request.timeoutMs <= 55_000, "the lookup and generation share one 55-second budget");
});

test("real Gemini client completes slow connection checks and questions through IPC", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = require("../agent-model-client");
  const calls = [];
  const files = new Map([["/virtual-cat-test/agent/config.json", JSON.stringify({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
    apiKey: "test-only-key",
  })]]);
  const h = harness(files, { modelClient: client, fetch: (url, options) => {
    if (options.method === "GET") return { ok: true, status: 200, text: async () => JSON.stringify({ name: "models/gemini-3.8-flash" }) };
    calls.push({ url, options });
    const text = calls.length === 1 ? "OK" : JSON.stringify({ reply: "A slow but complete answer.", action: null });
    return new Promise((resolve) => setTimeout(() => resolve({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text }] }],
      }),
    }), 40_000));
  } });
  const check = h.invoke("agent-config-test");
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  t.mock.timers.tick(40_000);
  const checked = await check;
  assert.equal(checked.ok, true);
  assert.equal(checked.reply, "OK");
  assert.equal((await h.invoke("agent-state-get")).history.length, 0);
  const ask = h.invoke("agent-ask", "Explain binary search simply");
  t.mock.timers.tick(40_000);
  const answered = await ask;
  assert.equal(answered.ok, true);
  assert.equal(answered.reply, "A slow but complete answer.");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(call.options.signal.aborted, false);
    assert.equal(JSON.parse(call.options.body).generation_config.max_output_tokens, 4_096);
  }
});

test("ordinary questions use conversation context and the personal-agent response contract", async () => {
  const configFile = "/virtual-cat-test/agent/config.json";
  const files = new Map([[configFile, JSON.stringify({
    baseUrl: "https://example.test/v1",
    model: "test-model",
    apiKey: "test-only-key",
  })]]);
  const modelCalls = [];
  const h = harness(files, {
    modelClient: {
      getChatEndpoint: () => "https://example.test/v1/chat/completions",
      requestModel: async (request) => {
        modelCalls.push(request);
        return { choices: [{ message: { content: JSON.stringify({ reply: "I can help with that.", action: null }) } }] };
      },
    },
  });
  const first = await h.invoke("agent-ask", "Help me plan my study session");
  const second = await h.invoke("agent-ask", "Make that plan shorter");
  assert.equal(first.reply, "I can help with that.");
  assert.equal(second.reply, "I can help with that.");
  assert.ok(modelCalls[1].messages.some((message) => message.content === "Help me plan my study session"));
  assert.ok(modelCalls[1].messages.some((message) => message.content === "I can help with that."));
});
test("music controls require fresh matching single-use approval", async () => {
  const { invoke, calls } = harness();
  const reply = await invoke("agent-ask", "pause music on Spotify");
  assert.equal(reply.confirmationRequired, true);
  assert.equal(calls.length, 0);
  const noToken = await invoke("agent-action-execute", { action: reply.action });
  assert.equal(noToken.reason, "approval-required");
  const tampered = await invoke("agent-action-execute", { action: { ...reply.action, command: "resume" }, approvalToken: reply.approvalToken });
  assert.equal(tampered.reason, "approval-required");
  assert.equal(calls.length, 0);
  const allowed = await invoke("agent-action-execute", { action: reply.action, approvalToken: reply.approvalToken });
  assert.equal(allowed.ok, true);
  assert.equal(calls.length, 1);
  const replay = await invoke("agent-action-execute", { action: reply.action, approvalToken: reply.approvalToken });
  assert.equal(replay.reason, "approval-required");
  assert.equal(calls.length, 1);
});
test("always approval is persisted for the exact action and reused without prompting", async () => {
  const { invoke, calls, files } = harness();
  const first = await invoke("agent-ask", "pause music on Spotify");
  const allowed = await invoke("agent-action-execute", {
    action: first.action,
    approvalToken: first.approvalToken,
    decision: "always",
  });
  assert.equal(allowed.ok, true);
  assert.equal(calls.length, 1);

  const approvalFile = [...files.entries()].find(([file]) => file.endsWith("approvals.json"));
  assert.ok(approvalFile, "approval grant should be saved");
  assert.doesNotMatch(approvalFile[1], /test-approval/);
  const stored = JSON.parse(approvalFile[1]);
  assert.equal(stored.version, 1);
  assert.equal(stored.grants.length, 1);
  assert.equal(stored.grants[0].scope, "music_control:spotify");

  const second = await invoke("agent-ask", "pause music on Spotify");
  assert.equal(second.confirmationRequired, false);
  assert.equal(calls.length, 2);
  const different = await invoke("agent-ask", "resume music on Spotify");
  assert.equal(different.confirmationRequired, false, "one Spotify control approval should cover the player");
  const otherPlayer = await invoke("agent-ask", "pause music on Apple Music");
  assert.equal(otherPlayer.confirmationRequired, true, "a Spotify grant must not control Music");

  const restarted = harness(files);
  const afterRestart = await restarted.invoke("agent-ask", "pause music on Spotify");
  assert.equal(afterRestart.confirmationRequired, false, "saved permissions should survive an agent restart");
  assert.equal(restarted.calls.length, 1);
});
test("links and app launches open immediately without repeated approval", async () => {
  const { invoke, calls } = harness();
  for (const prompt of ["find hackathons on Unstop", "play Yellow on Spotify", "open Notion"]) {
    const before = calls.length;
    const reply = await invoke("agent-ask", prompt);
    assert.equal(reply.confirmationRequired, false);
    assert.equal(reply.action, null);
    assert.equal(calls.length, before + 1);
  }
});
test("expired actions cannot be performed", async () => {
  const { invoke, calls, context } = harness();
  const reply = await invoke("agent-ask", "pause music on Spotify");
  vm.runInNewContext('for (const entry of pendingActions.values()) entry.expiresAt = 0;', context);
  const result = await invoke("agent-action-execute", { action: reply.action, approvalToken: reply.approvalToken });
  assert.equal(result.reason, "approval-required");
  assert.equal(calls.length, 0);
});

test("task management IPC endpoints handle priority, toggle, delete, and retrieval", async () => {
  const { invoke } = harness();
  // Add urgent task
  const add1 = await invoke("agent-task-add", { title: "Submit Lab 4", priority: "urgent" });
  assert.equal(add1.ok, true);
  assert.equal(add1.task.priority, "urgent");
  assert.equal(add1.task.title, "Submit Lab 4");

  // Add high task
  const add2 = await invoke("agent-task-add", { title: "Study Networks", priority: "high" });
  assert.equal(add2.ok, true);
  assert.equal(add2.task.priority, "high");

  // Fetch tasks
  const tasks = await invoke("agent-tasks-get");
  assert.equal(tasks.length, 2);

  // Toggle completion
  const toggled = await invoke("agent-task-toggle", add1.task.id);
  assert.equal(toggled.ok, true);
  assert.equal(toggled.task.completed, true);

  // Update priority
  const updatedPrio = await invoke("agent-task-set-priority", { id: add2.task.id, priority: "urgent" });
  assert.equal(updatedPrio.ok, true);
  assert.equal(updatedPrio.task.priority, "urgent");

  // Delete task
  const deleted = await invoke("agent-task-delete", add1.task.id);
  assert.equal(deleted.ok, true);
  const remaining = await invoke("agent-tasks-get");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, add2.task.id);
});

test("natural language priority task shortcuts categorize tasks properly", async () => {
  const { invoke } = harness();
  // Natural language add with urgent prefix
  const urgentRes = await invoke("agent-ask", "add urgent task: Fix critical bug");
  assert.equal(urgentRes.ok, true);
  assert.match(urgentRes.reply, /Task added: Fix critical bug \[URGENT\]/i);

  // Natural language add with trailing priority tag
  const highRes = await invoke("agent-ask", "create task: Review PR [priority: high]");
  assert.equal(highRes.ok, true);
  assert.match(highRes.reply, /Task added: Review PR \[HIGH\]/i);

  // List tasks groups by priority
  const listRes = await invoke("agent-ask", "list tasks");
  assert.equal(listRes.ok, true);
  assert.match(listRes.reply, /\*\*Urgent Priority:\*\*/);
  assert.match(listRes.reply, /\*\*High Priority:\*\*/);
  assert.match(listRes.reply, /Fix critical bug/);
  assert.match(listRes.reply, /Review PR/);
});

test("task add supports optional dueDate", async () => {
  const { invoke } = harness();
  const res = await invoke("agent-task-add", { title: "Exam Prep", priority: "urgent", dueDate: "2026-11-05" });
  assert.equal(res.ok, true);
  assert.equal(res.task.dueDate, "2026-11-05");
  assert.equal(res.task.priority, "urgent");

  const list = await invoke("agent-tasks-get");
  assert.equal(list[0].dueDate, "2026-11-05");
});

test("calendar shortcut and IPC handlers operate cleanly without emojis", async () => {
  const { invoke } = harness();
  const isConn = await invoke("calendar-is-connected");
  assert.equal(isConn, true);

  const calEvents = await invoke("calendar-fetch-events");
  assert.equal(calEvents.ok, true);
  assert.equal(calEvents.events.length, 2);
  assert.equal(calEvents.events[0].title, "CS 301 Lecture");

  const askRes = await invoke("agent-ask", "check calendar");
  assert.equal(askRes.ok, true);
  assert.match(askRes.reply, /CS 301 Lecture/);
  assert.match(askRes.reply, /Project Sync/);
  // Ensure no emojis in the response
  assert.doesNotMatch(askRes.reply, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/u);
});

