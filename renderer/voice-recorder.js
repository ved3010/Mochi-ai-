"use strict";

(() => {
  const micButton = document.getElementById("voice-mic-button");
  const speechBubble = document.getElementById("cat-speech-bubble");

  let mediaStream = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let recordingTimeout = null;
  let vadInterval = null;
  let audioContext = null;
  let isRecording = false;

  function showBubble(text, durationMs = 2500) {
    if (!speechBubble) return;
    speechBubble.textContent = text;
    speechBubble.setAttribute("aria-label", text);
    document.body.dataset.speech = "notice";
    if (durationMs > 0) {
      setTimeout(() => {
        if (speechBubble.textContent === text) {
          speechBubble.textContent = "";
          delete document.body.dataset.speech;
        }
      }, durationMs);
    }
  }

  async function startRecording() {
    if (isRecording) {
      stopRecording();
      return;
    }

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        showBubble("Microphone not supported", 3000);
        return;
      }

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });

      audioChunks = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      mediaRecorder = new MediaRecorder(mediaStream, { mimeType });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        cleanupAudio();

        if (audioChunks.length === 0) return;

        const audioBlob = new Blob(audioChunks, { type: mimeType });
        if (audioBlob.size < 400) {
          showBubble("Too short to hear 😿", 2000);
          return;
        }

        showBubble("Thinking... ✨", 4000);

        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          if (window.voiceAPI?.transcribeAudio) {
            const result = await window.voiceAPI.transcribeAudio(arrayBuffer, mimeType);
            if (result?.ok && result.text) {
              showBubble(`"${result.text}" 🐾`, 3000);
            } else if (result?.error === "MISSING_KEY") {
              showBubble("Paste Groq key in .env file! 🔑", 4500);
            } else if (result?.error) {
              showBubble(result.message || "Couldn't hear clearly 😿", 3000);
            }
          }
        } catch (err) {
          console.error("[VoiceRecorder] Transcription failed:", err);
          showBubble("Voice error 😿", 2500);
        }
      };

      mediaRecorder.start(200);
      isRecording = true;
      if (micButton) micButton.classList.add("is-listening");
      showBubble("Listening... 🎙️ (tap mic to stop)", 0);

      // Voice Activity Detection (silence detection)
      setupVad(mediaStream);

      // Safety timeout after 5 seconds max (fast response)
      if (recordingTimeout) clearTimeout(recordingTimeout);
      recordingTimeout = setTimeout(() => {
        if (isRecording) {
          stopRecording();
        }
      }, 5000);
    } catch (err) {
      console.error("[VoiceRecorder] getUserMedia error:", err);
      showBubble("Mic permission needed 🎙️", 3000);
      cleanupAudio();
    }
  }

  function setupVad(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      audioContext = new AudioCtx();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      let hasSpoken = false;
      let silenceStartTime = null;
      let baselineSum = 0;
      let baselineTicks = 0;
      let speechThreshold = 18;

      if (vadInterval) clearInterval(vadInterval);
      vadInterval = setInterval(() => {
        if (!isRecording) {
          clearInterval(vadInterval);
          vadInterval = null;
          return;
        }

        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avgVolume = sum / bufferLength;

        // Sample background noise in the first 250ms to set an adaptive speech threshold
        if (baselineTicks < 3) {
          baselineSum += avgVolume;
          baselineTicks++;
          speechThreshold = Math.max(16, (baselineSum / baselineTicks) + 6);
          return;
        }

        if (avgVolume > speechThreshold) {
          hasSpoken = true;
          silenceStartTime = null;
        } else if (hasSpoken) {
          if (!silenceStartTime) {
            silenceStartTime = Date.now();
          } else if (Date.now() - silenceStartTime > 850) {
            // User paused speaking for ~850ms -> stop and transcribe immediately
            clearInterval(vadInterval);
            vadInterval = null;
            stopRecording();
          }
        }
      }, 80);
    } catch (err) {
      console.warn("[VoiceRecorder] VAD setup skipped:", err);
    }
  }

  function cleanupAudio() {
    isRecording = false;
    if (recordingTimeout) {
      clearTimeout(recordingTimeout);
      recordingTimeout = null;
    }
    if (vadInterval) {
      clearInterval(vadInterval);
      vadInterval = null;
    }
    if (audioContext) {
      try {
        audioContext.close();
      } catch (_) {}
      audioContext = null;
    }
    if (mediaStream) {
      try {
        mediaStream.getTracks().forEach((track) => track.stop());
      } catch (_) {}
      mediaStream = null;
    }
    if (micButton) micButton.classList.remove("is-listening");
  }

  function stopRecording() {
    isRecording = false;
    if (recordingTimeout) {
      clearTimeout(recordingTimeout);
      recordingTimeout = null;
    }
    if (vadInterval) {
      clearInterval(vadInterval);
      vadInterval = null;
    }
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch (_) {
        cleanupAudio();
      }
    } else {
      cleanupAudio();
    }
  }

  // Bind click listener on microphone button
  if (micButton) {
    micButton.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (isRecording) {
          stopRecording();
        } else {
          startRecording();
        }
      },
      true
    );
  }

  // Auto-recording trigger from main process (e.g. when user says "Hey Bheduu")
  if (window.voiceAPI?.onStartRecord) {
    window.voiceAPI.onStartRecord(() => {
      startRecording();
    });
  }

  // Global custom event
  window.addEventListener("voice-start-record", () => {
    startRecording();
  });

  window.startVoiceRecording = startRecording;
})();
