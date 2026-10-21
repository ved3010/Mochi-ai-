"use strict";

const stuckDetector = require("./stuck-detector");

// Configuration constants
const NORMAL_STAGE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const DEMO_STAGE_INTERVAL_MS = 10 * 1000;        // 10 seconds
const BUBBLE_AUTOHIDE_MS = 15 * 1000;            // 15 seconds
const MIN_INTERVAL_BETWEEN_CHECKINS_MS = 30 * 60 * 1000; // 30 minutes
const SILENCE_NOT_NOW_MS = 45 * 60 * 1000;       // 45 minutes
const SILENCE_JUST_THINKING_MS = 90 * 60 * 1000; // 90 minutes
const MAX_CHECKINS_PER_DAY = 3;
const MAX_CONSECUTIVE_IGNORES = 2;

const STAGES = {
  NONE: 0,
  STAGE_PROMPT: 1,
  // Aliases for compatibility
  STAGE_1_PAW: 1,
  STAGE_1_PROMPT: 1,
  STAGE_2_PROMPT: 1,
  STAGE_1_PAW_BUBBLE: 1,
  STAGE_2_PAW_BUBBLE: 1,
  STAGE_3_PROMPT: 1,
};

class GentleCheckIn {
  constructor(options = {}) {
    this.stuckDetector = options.stuckDetector || stuckDetector;
    this.onShowPawBubble = options.onShowPawBubble || (() => {});
    this.onShowPromptBubble = options.onShowPromptBubble || (() => {});
    this.onHideBubble = options.onHideBubble || (() => {});
    this.onPurr = options.onPurr || (() => {});
    this.customTimeProvider = options.timeProvider || null;
    this.isDemoModeFn = options.isDemoMode || (() => this.stuckDetector?.isDemoMode?.() || false);

    // State tracking
    this.currentStage = STAGES.NONE;
    this.stageTimer = null;
    this.autoHideTimer = null;

    // Daily limits & counters
    this.currentDay = this.getTodayString();
    this.checkInsToday = 0;
    this.lastCheckInTime = -1;
    this.consecutiveIgnoredCount = 0;
    this.silenceUntil = 0;
    this.silenceForRestOfDay = false;

    // Mocked time tracking for testing
    this._mockedNow = null;
  }

  now() {
    if (typeof this._mockedNow === "number") {
      return this._mockedNow;
    }
    if (typeof this.customTimeProvider === "function") {
      return this.customTimeProvider();
    }
    return Date.now();
  }

  getTodayString() {
    const d = new Date(this.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  checkDayReset() {
    const today = this.getTodayString();
    if (this.currentDay !== today) {
      this.currentDay = today;
      this.checkInsToday = 0;
      this.lastCheckInTime = -1;
      this.consecutiveIgnoredCount = 0;
      this.silenceUntil = 0;
      this.silenceForRestOfDay = false;
    }
  }

  isSilenced() {
    this.checkDayReset();
    if (this.silenceForRestOfDay) return true;
    return this.now() < this.silenceUntil;
  }

  getStageInterval() {
    return this.isDemoModeFn() ? DEMO_STAGE_INTERVAL_MS : NORMAL_STAGE_INTERVAL_MS;
  }

  clearTimers() {
    if (this.stageTimer) {
      clearTimeout(this.stageTimer);
      this.stageTimer = null;
    }
    if (this.autoHideTimer) {
      clearTimeout(this.autoHideTimer);
      this.autoHideTimer = null;
    }
  }

  cancelStage() {
    this.clearTimers();
    if (this.currentStage !== STAGES.NONE) {
      this.currentStage = STAGES.NONE;
      this.onHideBubble();
    }
  }

  handleStateChange(newState, previousState, meta = {}) {
    this.checkDayReset();

    // Never show in watching or thinking states
    if (newState === "watching" || newState === "thinking") {
      this.cancelStage();
      return;
    }

    // If the state returns to active, cancel the current stage
    if (newState === "active") {
      this.cancelStage();
      return;
    }

    // When state becomes maybe_stuck or stuck
    if (newState === "maybe_stuck" || newState === "stuck") {
      // If already in prompt / question stage, do not restart
      if (this.currentStage !== STAGES.NONE) {
        return;
      }

      // Check silence rules and limits
      if (this.isSilenced()) {
        return;
      }
      if (this.checkInsToday >= MAX_CHECKINS_PER_DAY) {
        return;
      }

      // Check min 30 minutes interval since last check-in
      if (this.lastCheckInTime >= 0 && this.now() - this.lastCheckInTime < MIN_INTERVAL_BETWEEN_CHECKINS_MS) {
        return;
      }

      // Directly ask question (skip intermediate paw bubble)
      this.startPrompt();
    }
  }

  startPrompt() {
    this.checkDayReset();
    if (this.isSilenced()) {
      this.cancelStage();
      return;
    }

    const currentState = this.stuckDetector?.getState?.();
    if (currentState && currentState !== "maybe_stuck" && currentState !== "stuck") {
      this.cancelStage();
      return;
    }

    // Verify daily limits
    if (this.checkInsToday >= MAX_CHECKINS_PER_DAY) {
      this.cancelStage();
      return;
    }

    if (this.lastCheckInTime >= 0 && this.now() - this.lastCheckInTime < MIN_INTERVAL_BETWEEN_CHECKINS_MS) {
      this.cancelStage();
      return;
    }

    this.currentStage = STAGES.STAGE_PROMPT;
    this.clearTimers();

    // Record check-in count and timestamp
    this.checkInsToday++;
    this.lastCheckInTime = this.now();

    // Directly show prompt with 2 buttons: "Yes" and "No"
    this.onShowPromptBubble({
      text: "Mew? Things look quiet. Want one tiny step?",
      buttons: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    });

    // The bubble hides itself after 15 seconds with no message
    this.autoHideTimer = setTimeout(() => {
      this.handleBubbleTimeout();
    }, BUBBLE_AUTOHIDE_MS);
  }

  startStage1() {
    this.startPrompt();
  }

  startStage2() {
    this.startPrompt();
  }

  handleBubbleTimeout() {
    // If user didn't click anything in 15 seconds, that's an ignore
    this.consecutiveIgnoredCount++;

    // "ignoring it twice in a row means silence for the day"
    if (this.consecutiveIgnoredCount >= MAX_CONSECUTIVE_IGNORES) {
      this.silenceForRestOfDay = true;
    }

    this.cancelStage();
  }

  respondYes() {
    console.log("user accepted");
    this.consecutiveIgnoredCount = 0;
    this.cancelStage();
  }

  respondNo() {
    // Silent for 45 minutes
    this.silenceUntil = this.now() + SILENCE_NOT_NOW_MS;
    this.consecutiveIgnoredCount = 0;
    this.cancelStage();
  }

  // Compatibility aliases
  respondYesHelpMe() {
    this.respondYes();
  }

  respondNotNow() {
    this.respondNo();
  }

  respondJustThinking() {
    this.silenceUntil = this.now() + SILENCE_JUST_THINKING_MS;
    this.consecutiveIgnoredCount = 0;
    this.onPurr();
    if (typeof this.stuckDetector?.markJustThinking === "function") {
      this.stuckDetector.markJustThinking();
    }
    this.cancelStage();
  }

  respondFine() {
    this.silenceForRestOfDay = true;
    this.consecutiveIgnoredCount = 0;
    this.cancelStage();
  }

  // Testing and inspection helpers
  getStage() {
    return this.currentStage;
  }

  getCheckInsToday() {
    this.checkDayReset();
    return this.checkInsToday;
  }

  getConsecutiveIgnoredCount() {
    this.checkDayReset();
    return this.consecutiveIgnoredCount;
  }

  getSilenceUntil() {
    return this.silenceUntil;
  }

  isSilencedForRestOfDay() {
    this.checkDayReset();
    return this.silenceForRestOfDay;
  }

  _setTestTime(timestamp) {
    this._mockedNow = timestamp;
    this.checkDayReset();
  }

  _advanceTime(ms) {
    if (typeof this._mockedNow !== "number") {
      this._mockedNow = Date.now();
    }
    this._mockedNow += ms;
    this.checkDayReset();
  }

  _resetState() {
    this.clearTimers();
    this.currentStage = STAGES.NONE;
    this.checkInsToday = 0;
    this.lastCheckInTime = -1;
    this.consecutiveIgnoredCount = 0;
    this.silenceUntil = 0;
    this.silenceForRestOfDay = false;
    this._mockedNow = null;
    this.currentDay = this.getTodayString();
  }
}

// Default singleton instance
const defaultInstance = new GentleCheckIn();

module.exports = {
  GentleCheckIn,
  STAGES,
  NORMAL_STAGE_INTERVAL_MS,
  DEMO_STAGE_INTERVAL_MS,
  BUBBLE_AUTOHIDE_MS,
  MIN_INTERVAL_BETWEEN_CHECKINS_MS,
  SILENCE_NOT_NOW_MS,
  SILENCE_JUST_THINKING_MS,
  MAX_CHECKINS_PER_DAY,
  MAX_CONSECUTIVE_IGNORES,
  // Singleton methods
  init: (options) => {
    Object.assign(defaultInstance, options);
    if (defaultInstance.stuckDetector && typeof defaultInstance.stuckDetector.onStateChange === "function") {
      defaultInstance.stuckDetector.onStateChange((newState, oldState, meta) => {
        defaultInstance.handleStateChange(newState, oldState, meta);
      });
    }
    return defaultInstance;
  },
  getInstance: () => defaultInstance,
  handleStateChange: (...args) => defaultInstance.handleStateChange(...args),
  respondYes: () => defaultInstance.respondYes(),
  respondNo: () => defaultInstance.respondNo(),
  respondYesHelpMe: () => defaultInstance.respondYesHelpMe(),
  respondNotNow: () => defaultInstance.respondNotNow(),
  respondJustThinking: () => defaultInstance.respondJustThinking(),
  respondFine: () => defaultInstance.respondFine(),
  cancelStage: () => defaultInstance.cancelStage(),
  getStage: () => defaultInstance.getStage(),
  isSilenced: () => defaultInstance.isSilenced(),
  getCheckInsToday: () => defaultInstance.getCheckInsToday(),
  getConsecutiveIgnoredCount: () => defaultInstance.getConsecutiveIgnoredCount(),
};
