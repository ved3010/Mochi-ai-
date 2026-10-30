"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const unstopService = require("../unstop-service");
const gmailService = require("../gmail-service");
const workflowPlanner = require("../workflow-planner");

test("unstopService fetches opportunities with required properties", async () => {
  const opps = await unstopService.getAllFeaturedOpportunities();
  assert.ok(Array.isArray(opps.hackathons), "hackathons should be an array");
  assert.ok(Array.isArray(opps.competitions), "competitions should be an array");
  if (opps.hackathons.length > 0) {
    const h = opps.hackathons[0];
    assert.ok(h.title, "hackathon should have title");
    assert.ok(h.url, "hackathon should have url");
    assert.equal(typeof h.daysRemaining, "number");
  }
});

test("workflowPlanner aggregates streams and generates systematic prompt", async () => {
  const mockTasks = [
    { id: "task-1", title: "Complete CS assignment", completed: false },
    { id: "task-2", title: "Clean room", completed: true },
  ];
  const mockReminders = [
    { time: "10:00", message: "Team standup", enabled: true },
  ];

  const aggregated = await workflowPlanner.aggregateUserData(mockTasks, mockReminders);
  assert.ok(aggregated.classroom, "classroom data present");
  assert.ok(Array.isArray(aggregated.gmail), "gmail array present");
  assert.ok(Array.isArray(aggregated.calendar), "calendar array present");
  assert.ok(aggregated.unstop, "unstop data present");
  assert.equal(aggregated.tasks.length, 2);

  const contextText = workflowPlanner.buildContextString(aggregated);
  assert.match(contextText, /### 1\. GOOGLE CLASSROOM/);
  assert.match(contextText, /### 2\. GMAIL INBOX/);
  assert.match(contextText, /### 3\. LIVE UNSTOP HACKATHONS/);
  assert.match(contextText, /### 4\. USER'S EXISTING TODO TASKS/);
  assert.match(contextText, /### 5\. GOOGLE CALENDAR SCHEDULE/);
  assert.match(contextText, /Complete CS assignment/);

  const prompt = workflowPlanner.buildWorkflowPrompt(contextText, "plan my day");
  assert.match(prompt, /High-Priority & Urgent Deadlines/);
  assert.match(prompt, /Systematic Daily Workflow/);
  assert.match(prompt, /Career & Growth Target/);
  assert.match(prompt, /(?:Kittu|Mochi)'s Tip/);
});
