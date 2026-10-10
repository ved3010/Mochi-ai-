"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const on = (channel, callback) => ipcRenderer.on(channel, (_event, ...args) => callback(...args));
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const send = (channel, ...args) => ipcRenderer.send(channel, ...args);

// The pet renderer caches its own hit-test result. Keep the agent's temporary
// pointer ownership separate so leaving the panel restores that cached result.
let petMouseEventsEnabled = false;
let agentInteractionActive = false;
let mouseEventsEnabled;
function syncMouseEvents() {
  const enabled = petMouseEventsEnabled || agentInteractionActive;
  if (enabled === mouseEventsEnabled) return;
  mouseEventsEnabled = enabled;
  send("set-mouse-events-enabled", enabled);
}

contextBridge.exposeInMainWorld("electronAPI", {
  onCursorPos: (callback) => on("cursor-pos", callback),
  onKeyPressed: (callback) => on("key-pressed", callback),
  onMouseWheel: (callback) => on("mouse-wheel", callback),
  onDoStretch: (callback) => on("do-stretch", callback),
  onCancelStretch: (callback) => on("cancel-stretch", callback),
  onDoJump: (callback) => on("do-jump", callback),
  onShareRecord: (callback) => on("share-record", callback),
  onShareCaptureCancel: (callback) => on("share-capture-cancel", callback),
  onCatNameEdit: (callback) => on("cat-name-edit", callback),
  onCatNameChanged: (callback) => on("cat-name-changed", callback),
  onPetSizeChanged: (callback) => on("pet-size-changed", callback),
  onAiTaskComplete: (callback) => on("ai-task-complete", callback),
  onAiTaskState: (callback) => on("ai-task-state", callback),
  onAiTaskNotification: (callback) => on("ai-task-notification", callback),
  onCatOpenChat: (callback) => on("cat-open-chat", callback),
  remindersGet: () => invoke("reminders-get"),
  reminderAdd: (value) => invoke("reminder-add", value),
  reminderUpdate: (value) => invoke("reminder-update", value),
  reminderDelete: (value) => invoke("reminder-delete", value),
  reminderEnabledSet: (value) => invoke("reminder-enabled-set", value),
  onRemindersChanged: (callback) => on("reminders-changed", callback),
  onReminderTriggered: (callback) => on("reminder-triggered", callback),
  onReminderPanelOpen: (callback) => on("reminder-panel-open", callback),
  onReminderSettingsChanged: (callback) => on("reminder-settings-changed", callback),
  pomodoroGet: () => invoke("pomodoro-get"),
  pomodoroStart: () => invoke("pomodoro-start"),
  pomodoroPause: () => invoke("pomodoro-pause"),
  pomodoroReset: () => invoke("pomodoro-reset"),
  pomodoroFocusSet: (value) => invoke("pomodoro-focus-set", value),
  pomodoroRestSet: (value) => invoke("pomodoro-rest-set", value),
  onPomodoroFocusEdit: (callback) => on("pomodoro-focus-edit", callback),
  onPomodoroRestEdit: (callback) => on("pomodoro-rest-edit", callback),
  onPomodoroState: (callback) => on("pomodoro-state", callback),
  onPomodoroComplete: (callback) => on("pomodoro-complete", callback),
  onPomodoroFocusStart: (callback) => on("pomodoro-focus-start", callback),
  onUpdateState: (callback) => on("update-state", callback),
  onTaskCompleteSoundVolume: (callback) => on("task-complete-sound-volume", callback),
  onSoundMuted: (callback) => on("sound-muted", callback),
  onGentleCheckInShowPaw: (callback) => on("gentle-checkin-show-paw", callback),
  onGentleCheckInShowPrompt: (callback) => on("gentle-checkin-show-prompt", callback),
  onGentleCheckInHide: (callback) => on("gentle-checkin-hide", callback),
  onGentleCheckInPurr: (callback) => on("gentle-checkin-purr", callback),
  gentleCheckInRespond: (action) => send("gentle-checkin-respond", action),
  toggleThinkingMode: (minutes) => invoke("thinking-mode-toggle", minutes),
  getThinkingMode: () => invoke("thinking-mode-get"),
  updateCheck: () => invoke("update-check"),
  updateDownload: () => invoke("update-download"),
  updateInstall: () => invoke("update-install"),
  dragWindow: (x, y) => send("drag-window", x, y),
  dragWindowTo: (screenX, screenY, startX, startY) => send("drag-window-to", screenX, screenY, startX, startY),
  dragWindowEnded: () => send("drag-window-ended"),
  setMouseEventsEnabled: (value) => {
    petMouseEventsEnabled = Boolean(value);
    syncMouseEvents();
  },
  showContextMenu: () => send("show-context-menu"),
  setStretchMode: (value) => send("set-stretch-mode", value),
  setHuntingMode: (value) => send("set-hunting-mode", value),
  shareCaptureOptions: (value) => invoke("share-capture-options", value),
  shareCaptureStarted: () => invoke("share-capture-started"),
  shareCaptureOverlayHide: () => invoke("share-capture-overlay-hide"),
  shareVideoSave: (value) => invoke("share-video-save", value),
  shareErrorDialog: (value) => invoke("share-error-dialog", value),
  userNameGet: () => invoke("user-name-get"),
  userNameSet: (value) => invoke("user-name-set", value),
  onUserNameEdit: (callback) => on("user-name-edit", callback),
  onUserNameChanged: (callback) => on("user-name-changed", callback),
  catNameGet: () => invoke("cat-name-get"),
  catNameSet: (value) => invoke("cat-name-set", value),
  catNameVisibleSet: (value) => invoke("cat-name-visible-set", value),
  onCatNameEdit: (callback) => on("cat-name-edit", callback),
  onCatNameChanged: (callback) => on("cat-name-changed", callback),
  companionGet: () => invoke("companion-get"),
  companionSet: (type) => invoke("companion-set", type),
  onCompanionChanged: (callback) => on("companion-changed", callback),
  hoverSoundGet: () => invoke("hover-sound-get"),
  hoverSoundSet: (type) => invoke("hover-sound-set", type),
  onHoverSoundChanged: (callback) => on("hover-sound-changed", callback),
  fixedMessageGet: () => invoke("fixed-message-get"),
  fixedMessageSet: (value) => invoke("fixed-message-set", value),
  onFixedMessageEdit: (callback) => on("fixed-message-edit", callback),
  onFixedMessageChanged: (callback) => on("fixed-message-changed", callback),
  catNamePromptShown: () => invoke("cat-name-prompt-shown"),
  taskCompleteSoundVolumeGet: () => invoke("task-complete-sound-volume-get"),
  taskCompleteSoundVolumeSet: (value) => invoke("task-complete-sound-volume-set", value),
  soundMutedGet: () => invoke("sound-muted-get"),
  soundMutedSet: (value) => invoke("sound-muted-set", value),
  patternGet: () => invoke("pattern-get"),
  patternSet: (value) => send("pattern-set", value),
  patternPresetsGet: () => invoke("pattern-presets-get"),
  patternCustomPresetSave: (value) => invoke("pattern-custom-preset-save", value),
  patternCustomPresetDelete: (value) => invoke("pattern-custom-preset-delete", value),
  patternCustomPresetRename: (value) => invoke("pattern-custom-preset-rename", value),
  patternCustomPresetsExport: (value) => invoke("pattern-custom-presets-export", value),
  patternCustomPresetsImport: () => invoke("pattern-custom-presets-import"),
  patternConfirmClearAll: (value) => invoke("pattern-confirm-clear-all", value),
  patternConfirmDeletePreset: (value) => invoke("pattern-confirm-delete-preset", value),
  patternConfirmDiscardChanges: (value) => invoke("pattern-confirm-discard-changes", value),
  onPatternChanged: (callback) => on("pattern-changed", callback),
  openPatternEditor: () => send("open-pattern-editor"),
  openMappingEditor: () => send("open-mapping-editor"),
  mappingLoad: () => invoke("mapping-load"),
  mappingSave: (value) => invoke("mapping-save", value),
  svgLoad: (value) => invoke("svg-load", value),
  licenseActivate: (value) => invoke("license-activate", value),
  licenseCurrent: () => invoke("license-current"),
  openLandingPage: () => invoke("open-landing-page"),
  openLicenseResetPage: () => invoke("open-license-reset-page"),
  onLicenseError: (callback) => on("license-error", callback),
  languageGet: () => invoke("language-get"),
  languageSet: (value) => invoke("language-set", value),
  onLanguageChanged: (callback) => on("language-changed", callback),
});

contextBridge.exposeInMainWorld("agentAPI", {
  getState: () => invoke("agent-state-get"),
  updateConfig: (values) => invoke("agent-config-set", values),
  testConnection: () => invoke("agent-config-test"),
  ask: (prompt) => invoke("agent-ask", prompt),
  executeAction: (payload) => invoke("agent-action-execute", payload),
  clearApprovals: () => invoke("agent-approvals-clear"),
  getTasks: () => invoke("agent-tasks-get"),
  addTask: (data) => invoke("agent-task-add", data),
  toggleTask: (id) => invoke("agent-task-toggle", id),
  deleteTask: (id) => invoke("agent-task-delete", id),
  setTaskPriority: (id, priority) => invoke("agent-task-set-priority", { id, priority }),
  getCalendarEvents: () => invoke("calendar-fetch-events"),
  setInteractionActive: (value) => {
    agentInteractionActive = Boolean(value);
    syncMouseEvents();
  },
});

contextBridge.exposeInMainWorld("voiceAPI", {
  onPlaySong: (callback) => on("play-song", callback),
  onStopSong: (callback) => on("stop-song", callback),
  onVoiceHeard: (callback) => on("voice-heard", callback),
  onStartRecord: (callback) => on("voice-start-record", callback),
  startListening: () => send("voice-start-listening"),
  transcribeAudio: (buffer, mimeType) => invoke("voice-transcribe-audio", buffer, mimeType),
});

contextBridge.exposeInMainWorld("classroomAPI", {
  isConnected: () => invoke("classroom-is-connected"),
  connect: () => invoke("classroom-connect"),
  disconnect: () => invoke("classroom-disconnect"),
  fetchAssignments: () => invoke("classroom-fetch-assignments"),
});

contextBridge.exposeInMainWorld("calendarAPI", {
  isConnected: () => invoke("calendar-is-connected"),
  fetchEvents: () => invoke("calendar-fetch-events"),
});
