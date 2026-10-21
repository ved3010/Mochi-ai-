"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GentleCheckIn,
  STAGES,
  NORMAL_STAGE_INTERVAL_MS,
  DEMO_STAGE_INTERVAL_MS,
  BUBBLE_AUTOHIDE_MS,
  MIN_INTERVAL_BETWEEN_CHECKINS_MS,
  SILENCE_NOT_NOW_MS,
  SILENCE_JUST_THINKING_MS,
  MAX_CHECKINS_PER_DAY,
} = require("../gentle-checkin");

// Mock stuck detector helper
function createMockStuckDetector(initialState = "active", isDemo = false) {
  let state = initialState;
  let demo = isDemo;
  let markJustThinkingCalls = 0;
  return {
    getState: () => state,
    setState: (s) => { state = s; },
    isDemoMode: () => demo,
    setDemoMode: (d) => { demo = d; },
    markJustThinking: () => { markJustThinkingCalls++; },
    getMarkJustThinkingCalls: () => markJustThinkingCalls,
  };
}

test("gentle-checkin: When maybe_stuck or stuck is reached, it directly asks question without paw bubble", (t) => {
  let pawBubbleShown = false;
  let promptPayload = null;

  const mockDetector = createMockStuckDetector("active");
  const checkIn = new GentleCheckIn({
    stuckDetector: mockDetector,
    onShowPawBubble: () => { pawBubbleShown = true; },
    onShowPromptBubble: (payload) => { promptPayload = payload; },
  });

  mockDetector.setState("maybe_stuck");
  checkIn.handleStateChange("maybe_stuck", "active");

  assert.equal(checkIn.getStage(), STAGES.STAGE_PROMPT, "Should immediately be in prompt stage");
  assert.equal(pawBubbleShown, false, "Paw thought bubble should NOT be shown");
  assert.ok(promptPayload, "Prompt asking question should be shown immediately");
  assert.equal(promptPayload.text, "Mew? Things look quiet. Want one tiny step?");
  assert.equal(promptPayload.buttons.length, 2, "Only 2 buttons must be present");

  const btnLabels = promptPayload.buttons.map((b) => b.label);
  assert.deepEqual(btnLabels, ["Yes", "No"]);
  const btnIds = promptPayload.buttons.map((b) => b.id);
  assert.deepEqual(btnIds, ["yes", "no"]);

  // Verify no shame words
  const allText = (promptPayload.text + " " + btnLabels.join(" ")).toLowerCase();
  const shameWords = ["lazy", "stuck", "fail", "slow", "waste", "shame", "bad", "guilt", "procrastinat"];
  for (const word of shameWords) {
    assert.equal(allText.includes(word), false, `Text must not contain shame word '${word}'`);
  }

  checkIn.cancelStage();
});

test("gentle-checkin: Directly asks question immediately on stuck state without waiting for delay", (t) => {
  let promptShown = false;
  const mockDetector = createMockStuckDetector("stuck", false);
  const checkIn = new GentleCheckIn({
    stuckDetector: mockDetector,
    onShowPromptBubble: () => { promptShown = true; },
  });

  checkIn.handleStateChange("stuck", "active");
  assert.equal(checkIn.getStage(), STAGES.STAGE_PROMPT);
  assert.equal(promptShown, true, "Prompt must be shown immediately on stuck detection");

  checkIn.cancelStage();
});

test("gentle-checkin: State returning to active cancels stage and hides bubble", (t) => {
  let hideBubbleCalled = false;
  const mockDetector = createMockStuckDetector("stuck");
  const checkIn = new GentleCheckIn({
    stuckDetector: mockDetector,
    onHideBubble: () => { hideBubbleCalled = true; },
  });

  checkIn.handleStateChange("stuck", "active");
  assert.equal(checkIn.getStage(), STAGES.STAGE_1_PAW);

  // State changes back to active (e.g. user resumes coding/work)
  mockDetector.setState("active");
  checkIn.handleStateChange("active", "stuck");

  assert.equal(checkIn.getStage(), STAGES.NONE, "Stage should be reset to NONE");
  assert.equal(hideBubbleCalled, true, "Bubble should be hidden");
});

test("gentle-checkin: Never shows in watching or thinking states", (t) => {
  let pawShown = false;
  let promptShown = false;
  const mockDetector = createMockStuckDetector("watching");
  const checkIn = new GentleCheckIn({
    stuckDetector: mockDetector,
    onShowPawBubble: () => { pawShown = true; },
    onShowPromptBubble: () => { promptShown = true; },
  });

  // When user is seeing video or lecture
  checkIn.handleStateChange("watching", "active");
  assert.equal(checkIn.getStage(), STAGES.NONE);
  assert.equal(pawShown, false);
  assert.equal(promptShown, false);

  // When user is in thinking mode
  mockDetector.setState("thinking");
  checkIn.handleStateChange("thinking", "watching");
  assert.equal(checkIn.getStage(), STAGES.NONE);
  assert.equal(pawShown, false);
  assert.equal(promptShown, false);
});

test("gentle-checkin: Button 'Yes' logs 'user accepted' and resets stage", (t) => {
  const mockDetector = createMockStuckDetector("stuck");
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    const checkIn = new GentleCheckIn({ stuckDetector: mockDetector });
    checkIn.currentStage = STAGES.STAGE_2_PROMPT;
    checkIn.respondYes();

    assert.equal(checkIn.getStage(), STAGES.NONE);
    assert.ok(logs.some((l) => l.includes("user accepted")), "Must log 'user accepted'");
  } finally {
    console.log = origLog;
  }
});

test("gentle-checkin: Button 'No' sets 45-minute silence", (t) => {
  const baseTime = 1700000000000;
  const mockDetector = createMockStuckDetector("stuck");
  const checkIn = new GentleCheckIn({ stuckDetector: mockDetector });
  checkIn._setTestTime(baseTime);

  checkIn.currentStage = STAGES.STAGE_2_PROMPT;
  checkIn.respondNo();

  assert.equal(checkIn.getStage(), STAGES.NONE);
  assert.equal(checkIn.getSilenceUntil(), baseTime + SILENCE_NOT_NOW_MS);
  assert.equal(checkIn.isSilenced(), true);

  // Advance time by 44 minutes: still silenced
  checkIn._advanceTime(44 * 60 * 1000);
  assert.equal(checkIn.isSilenced(), true);

  // Advance by 2 more minutes (46 total): no longer silenced
  checkIn._advanceTime(2 * 60 * 1000);
  assert.equal(checkIn.isSilenced(), false);
});

test("gentle-checkin: Limit - Maximum 3 check-ins per day", (t) => {
  t.mock.timers.enable();
  const mockDetector = createMockStuckDetector("stuck", true); // demo mode for fast testing
  const checkIn = new GentleCheckIn({ stuckDetector: mockDetector });

  // 1st check-in
  checkIn.handleStateChange("stuck", "active");
  t.mock.timers.tick(DEMO_STAGE_INTERVAL_MS); // Stage 2 prompt
  assert.equal(checkIn.getStage(), STAGES.STAGE_2_PROMPT);
  assert.equal(checkIn.getCheckInsToday(), 1);
  checkIn.respondYes();

  // Advance 31 minutes
  t.mock.timers.tick(31 * 60 * 1000);

  // 2nd check-in
  checkIn.handleStateChange("stuck", "active");
  t.mock.timers.tick(DEMO_STAGE_INTERVAL_MS);
  assert.equal(checkIn.getStage(), STAGES.STAGE_2_PROMPT);
  assert.equal(checkIn.getCheckInsToday(), 2);
  checkIn.respondYes();

  // Advance 31 minutes
  t.mock.timers.tick(31 * 60 * 1000);

  // 3rd check-in
  checkIn.handleStateChange("stuck", "active");
  t.mock.timers.tick(DEMO_STAGE_INTERVAL_MS);
  assert.equal(checkIn.getStage(), STAGES.STAGE_2_PROMPT);
  assert.equal(checkIn.getCheckInsToday(), 3);
  checkIn.respondYes();

  // Advance 31 minutes
  t.mock.timers.tick(31 * 60 * 1000);

  // 4th check-in attempt: MUST NOT be allowed today
  checkIn.handleStateChange("stuck", "active");
  assert.equal(checkIn.getStage(), STAGES.NONE, "4th check-in must be blocked");
  assert.equal(checkIn.getCheckInsToday(), 3);
});

test("gentle-checkin: Limit - Minimum 30 minutes between check-ins", (t) => {
  t.mock.timers.enable();
  const mockDetector = createMockStuckDetector("stuck", true);
  const checkIn = new GentleCheckIn({ stuckDetector: mockDetector });

  // 1st check-in
  checkIn.handleStateChange("stuck", "active");
  t.mock.timers.tick(DEMO_STAGE_INTERVAL_MS);
  assert.equal(checkIn.getStage(), STAGES.STAGE_2_PROMPT);
  checkIn.respondYes();

  // Try again after only 15 minutes (< 30 minutes)
  t.mock.timers.tick(15 * 60 * 1000);
  checkIn.handleStateChange("stuck", "active");
  assert.equal(checkIn.getStage(), STAGES.NONE, "Check-in before 30 minutes must be blocked");

  // Advance to 31 minutes total (>= 30 minutes)
  t.mock.timers.tick(16 * 60 * 1000);
  checkIn.handleStateChange("stuck", "active");
  assert.equal(checkIn.getStage(), STAGES.STAGE_1_PAW, "Check-in allowed after 30 minutes");

  checkIn.cancelStage();
});

test("gentle-checkin: Auto-hide after 15s and ignoring twice in a row silences for the day", (t) => {
  t.mock.timers.enable();
  let hideCalledCount = 0;
  const mockDetector = createMockStuckDetector("stuck", true);
  const checkIn = new GentleCheckIn({
    stuckDetector: mockDetector,
    onHideBubble: () => { hideCalledCount++; },
  });

  // 1st prompt appears
  checkIn.handleStateChange("stuck", "active");
  t.mock.timers.tick(DEMO_STAGE_INTERVAL_MS);
  assert.equal(checkIn.getStage(), STAGES.STAGE_2_PROMPT);

  // 15 seconds elapse without user response
  t.mock.timers.tick(BUBBLE_AUTOHIDE_MS);
  assert.equal(checkIn.getStage(), STAGES.NONE, "Bubble hides after 15 seconds");
  assert.equal(checkIn.getConsecutiveIgnoredCount(), 1, "Ignored count should be 1");
  assert.equal(checkIn.isSilencedForRestOfDay(), false, "Not yet silenced for the day after 1 ignore");

  // Advance 31 minutes for next check-in
  t.mock.timers.tick(31 * 60 * 1000);

  // 2nd prompt appears
  checkIn.handleStateChange("stuck", "active");
  t.mock.timers.tick(DEMO_STAGE_INTERVAL_MS);
  assert.equal(checkIn.getStage(), STAGES.STAGE_2_PROMPT);

  // 15 seconds elapse again without response (second ignore in a row)
  t.mock.timers.tick(BUBBLE_AUTOHIDE_MS);
  assert.equal(checkIn.getStage(), STAGES.NONE);
  assert.equal(checkIn.getConsecutiveIgnoredCount(), 2, "Ignored count should be 2");
  assert.equal(checkIn.isSilencedForRestOfDay(), true, "Ignoring twice in a row must silence for the day");
  assert.equal(checkIn.isSilenced(), true);

  // Further check-ins today are blocked
  t.mock.timers.tick(60 * 60 * 1000);
  checkIn.handleStateChange("stuck", "active");
  assert.equal(checkIn.getStage(), STAGES.NONE);
});
