"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { inferShortcut } = require("../agent-shortcuts");
const googleClassroom = require("../google-classroom");

test("Classroom: inferShortcut routes check/sync and subject queries to check_classroom", () => {
  const checkQueries = [
    "Can you check my Google Classroom and save all the details?",
    "check my Google Classroom",
    "check classroom",
    "fetch assignments from google classroom",
    "sync google classroom",
    "show my classroom assignments",
    "google classroom deadlines",
    "what are my classroom assignments?",
    "please import assignments from classroom",
    "how many subjects in classroom",
    "how many assignments in google classroom",
    "show classroom subjects",
  ];

  for (const query of checkQueries) {
    const res = inferShortcut(query);
    assert.ok(res, `Expected shortcut match for: ${query}`);
    assert.equal(res.action?.type, "check_classroom", `Expected check_classroom for: ${query}`);
  }
});

test("Classroom: inferShortcut preserves 'open google classroom' as open_app", () => {
  const openRes = inferShortcut("open google classroom");
  assert.ok(openRes);
  assert.equal(openRes.action?.type, "open_app");
  assert.equal(openRes.action?.name, "Google Classroom");
});

test("Classroom: isConnected, fetchAssignments, and summary return structured results", async () => {
  const connected = googleClassroom.isConnected();
  assert.equal(typeof connected, "boolean");

  if (connected) {
    const result = await googleClassroom.fetchAssignments();
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.assignments));
    assert.ok(Array.isArray(result.courses));
    assert.ok(Array.isArray(result.pendingAssignments));
    assert.ok(Array.isArray(result.submittedAssignments));
    assert.equal(typeof result.totalCount, "number");
    assert.equal(typeof result.upcomingCount, "number");

    const summary = googleClassroom.getClassroomSummaryText();
    assert.equal(typeof summary, "string");
    assert.ok(summary.includes("Google Classroom"));
  }
});

test("Classroom: agent-ask responds accurately to subjects, assignment counts, and all assignments", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../agent-main.js"), "utf8");

  const handlers = new Map();
  const mockClassroom = {
    isConnected: () => true,
    fetchAssignments: async () => ({
      ok: true,
      courses: [
        { id: "101", name: "Operating Systems", subject: "OS", section: "D" },
        { id: "102", name: "Computer Networks", subject: "CN", section: "B" },
      ],
      pendingAssignments: [
        { id: "a1", courseName: "Operating Systems", title: "Project 1", dueDateFormatted: "No due date", isOverdue: false },
        { id: "a2", courseName: "Computer Networks", title: "Lab 2", dueDateFormatted: "Nov 5, 2026", isOverdue: false },
      ],
      submittedAssignments: [
        { id: "a3", courseName: "Operating Systems", title: "Lab 1", isSubmitted: true },
      ],
      allAssignments: [{}, {}, {}],
      totalCount: 3,
      pendingCount: 2,
      submittedCount: 1,
      upcomingCount: 1,
      coursesCount: 2,
    }),
    getClassroomSummaryText: () => "Google Classroom is connected.",
  };

  const configFile = path.join("/virtual-cat-test", "config.json");
  const files = new Map([[configFile, JSON.stringify({
    baseUrl: "https://example.test/v1",
    model: "test-model",
    apiKey: "test-only-key",
  })]]);

  const context = {
    process: { platform: "win32", env: {}, pid: 1 }, console, URL, Buffer, setTimeout, clearTimeout,
    require: (name) => {
      if (name === "fs") return {
        mkdirSync() {}, chmodSync() {}, existsSync: (f) => files.has(f),
        readFileSync: (f) => files.get(f) || "{}", writeFileSync: (f, d) => files.set(f, d),
        renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
      };
      if (name === "http") return { createServer: () => ({ on() {}, listen() {}, close() {}, listening: false }) };
      if (name === "electron") return {
        app: { getPath: () => "/virtual-cat-test", on() {} }, BrowserWindow: {},
        ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, safeStorage: { isEncryptionAvailable: () => false },
        shell: { openExternal: async () => {}, openPath: async () => "" },
      };
      if (name === "./agent-shortcuts") return require("../agent-shortcuts");
      if (name === "./app-launcher") return require("../app-launcher");
      if (name === "./google-classroom") return mockClassroom;
      if (name === "./gmail-service") return { getUrgentEmailsText: () => "", getRecentEmailsText: () => "" };
      if (name === "./calendar-service") return { getCalendarSummaryText: () => "" };
      if (name === "./unstop-service") return { getUnstopSummaryText: () => "" };
      if (name === "./workflow-planner") return require("../workflow-planner");
      if (name === "./agent-music") return require("../agent-music");
      if (name === "child_process") return { execFile: (b, a, o, done) => done(null) };
      if (name === "./agent-model-client") return {
        ...require("../agent-model-client"),
        getChatEndpoint: () => "https://example.test/v1/chat/completions",
        requestModel: async () => ({
          choices: [{ message: { content: JSON.stringify({ reply: "Checking your classroom", action: { type: "check_classroom" } }) } }],
        }),
      };
      return require(name);
    },
  };

  vm.runInNewContext(source, context, { filename: "agent-main.js" });
  const invoke = async (channel, payload) => handlers.get(channel)({}, payload);

  // 1. Subject query
  const resSubjects = await invoke("agent-ask", "how many subjects in classroom");
  assert.ok(resSubjects.reply.includes("2 active subjects"));
  assert.ok(resSubjects.reply.includes("Operating Systems"));
  assert.ok(resSubjects.reply.includes("Computer Networks"));

  // 2. Count query
  const resCount = await invoke("agent-ask", "how many assignments in google classroom");
  assert.ok(resCount.reply.includes("3 assignments"));
  assert.ok(resCount.reply.includes("in total"));
  assert.ok(resCount.reply.includes("Pending (2)"));
  assert.ok(resCount.reply.includes("Project 1"));
  assert.ok(resCount.reply.includes("Lab 2"));
  assert.ok(resCount.reply.includes("Completed / Submitted (1)"));

  // 3. Regular check query
  const resCheck = await invoke("agent-ask", "check classroom");
  assert.ok(resCheck.reply.includes("Found **2 pending assignments**"));
  assert.ok(resCheck.reply.includes("Project 1"));
  assert.ok(resCheck.reply.includes("Lab 2"));
});
