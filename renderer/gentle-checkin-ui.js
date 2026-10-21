"use strict";

(() => {
  const bubble = document.getElementById("cat-speech-bubble");
  const bubbleContainer = document.getElementById("cat-speech-bubble-container");
  let purrTimeout = null;
  let activePurrAudio = null;
  let isPromptOpen = false;

  function setPromptMouseEvents(active) {
    if (window.agentAPI?.setInteractionActive) {
      window.agentAPI.setInteractionActive(active);
    } else if (window.electronAPI?.setMouseEventsEnabled) {
      window.electronAPI.setMouseEventsEnabled(active);
    }
  }

  function hideCheckInBubble() {
    if (document.body.dataset.speech === "gentle-paw" || document.body.dataset.speech === "gentle-prompt") {
      delete document.body.dataset.speech;
      if (bubble) {
        bubble.textContent = "";
        bubble.removeAttribute("aria-label");
      }
    }
    if (isPromptOpen) {
      isPromptOpen = false;
      setPromptMouseEvents(false);
    }
  }

  function showPawBubble() {
    if (!bubble) return;
    if (isPromptOpen) {
      isPromptOpen = false;
      setPromptMouseEvents(false);
    }
    bubble.innerHTML = `<div class="paw-thought-bubble" aria-label="Cat is thinking of you">🐾</div>`;
    bubble.setAttribute("aria-label", "paw");
    document.body.dataset.speech = "gentle-paw";
  }

  function showPromptBubble(data) {
    if (!bubble) return;
    isPromptOpen = true;
    const text = data?.text || "Mew? Things look quiet. Want one tiny step?";
    const buttons = data?.buttons || [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ];

    bubble.innerHTML = `
      <div class="gentle-checkin-container">
        <div class="gentle-checkin-text">${text}</div>
        <div class="gentle-checkin-buttons">
          ${buttons
            .map(
              (btn) => `
            <button type="button" class="gentle-checkin-btn ${btn.id === "yes" || btn.id === "yes_help_me" ? "btn-yes btn-accent" : "btn-no"}" data-action="${btn.id}">
              ${btn.label}
            </button>
          `
            )
            .join("")}
        </div>
      </div>
    `;

    bubble.setAttribute("aria-label", text);
    document.body.dataset.speech = "gentle-prompt";

    // Enable mouse events so buttons are immediately visible, hoverable, and clickable
    setPromptMouseEvents(true);

    // Bind click events on buttons
    const btnElements = bubble.querySelectorAll(".gentle-checkin-btn");
    btnElements.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const action = btn.getAttribute("data-action");
        hideCheckInBubble();
        if (window.electronAPI?.gentleCheckInRespond) {
          window.electronAPI.gentleCheckInRespond(action);
        }
      });

      btn.addEventListener("mouseenter", () => {
        setPromptMouseEvents(true);
      });
    });

    if (bubbleContainer) {
      bubbleContainer.addEventListener("mouseenter", () => {
        if (isPromptOpen) setPromptMouseEvents(true);
      });
    }
  }

  function playPurr() {
    document.body.dataset.purring = "1";
    if (purrTimeout) {
      clearTimeout(purrTimeout);
      purrTimeout = null;
    }

    try {
      if (activePurrAudio) {
        activePurrAudio.pause();
        activePurrAudio.currentTime = 0;
      }
      activePurrAudio = new Audio("../assets/sound/purring.m4a");
      activePurrAudio.volume = 0.15;
      activePurrAudio.play().catch(() => {});
    } catch (_) {}

    purrTimeout = setTimeout(() => {
      delete document.body.dataset.purring;
      if (activePurrAudio) {
        try {
          activePurrAudio.pause();
        } catch (_) {}
        activePurrAudio = null;
      }
    }, 4000);
  }

  // Register Electron IPC listeners
  window.electronAPI?.onGentleCheckInShowPaw?.(() => {
    showPawBubble();
  });

  window.electronAPI?.onGentleCheckInShowPrompt?.((data) => {
    showPromptBubble(data);
  });

  window.electronAPI?.onGentleCheckInHide?.(() => {
    hideCheckInBubble();
  });

  window.electronAPI?.onGentleCheckInPurr?.(() => {
    playPurr();
  });
})();
