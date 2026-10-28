"use strict";

const fs = require("fs");
const path = require("path");

// Load .env automatically if present
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          // Remove wrapping quotes if any
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (key && val) {
            process.env[key] = val;
          }
        }
      }
    } catch (_) {}
  }
}

// Initial load
loadEnv();

function getApiKey() {
  loadEnv(); // Reload in case user just saved the file
  const key = (process.env.GROQ_API_KEY || "").trim();
  if (!key || key === "PASTE_YOUR_GROQ_API_KEY_HERE") {
    return "";
  }
  return key;
}

/**
 * Transcribes audio buffer using Groq Whisper (whisper-large-v3-turbo).
 * @param {Buffer|Uint8Array|ArrayBuffer} audioBuffer
 * @param {string} mimeType - e.g. "audio/webm" or "audio/wav"
 * @returns {Promise<{ text?: string, error?: string, message?: string }>}
 */
async function transcribeAudio(audioBuffer, mimeType = "audio/webm") {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      error: "MISSING_KEY",
      message: "Groq API key not found. Please paste your key in the .env file.",
    };
  }

  try {
    const rawBuffer = Buffer.isBuffer(audioBuffer)
      ? audioBuffer
      : Buffer.from(audioBuffer);

    if (!rawBuffer || rawBuffer.length < 500) {
      return { error: "TOO_SHORT", message: "Audio was too short or empty." };
    }

    const ext = mimeType.includes("wav") ? "wav" : mimeType.includes("mp4") ? "m4a" : "webm";
    const blob = new Blob([rawBuffer], { type: mimeType });
    const formData = new FormData();
    formData.append("file", blob, `speech.${ext}`);
    formData.append("model", "whisper-large-v3-turbo");
    formData.append("temperature", "0");

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorJson = await response.json().catch(() => ({}));
      const errMsg = errorJson?.error?.message || `HTTP ${response.status}: ${response.statusText}`;
      console.error("[GroqWhisper] API error:", errMsg);
      return { error: "API_ERROR", message: errMsg };
    }

    const data = await response.json();
    const text = (data.text || "").trim();
    return { ok: true, text };
  } catch (err) {
    console.error("[GroqWhisper] Request failed:", err);
    return { error: "NETWORK_ERROR", message: err.message };
  }
}

module.exports = {
  getApiKey,
  transcribeAudio,
  loadEnv,
};
