"use strict";

const { performance } = require("node:perf_hooks");

const TOTAL_TIMEOUT_MS = 55_000;
const RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5_000;
const MIN_RETRY_BUDGET_MS = 5_000;
// Request/gateway timeouts are deliberately excluded: generation may still be running.
const RETRYABLE_STATUSES = new Set([425, 429, 500, 502, 503]);
const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET",
  "ERR_CONNECTION_RESET", "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_CLOSED",
  "ERR_NAME_NOT_RESOLVED", "ERR_NETWORK_CHANGED", "ERR_INTERNET_DISCONNECTED",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT",
]);
const NETWORK_GUIDANCE = new Map([
  ["ERR_PROXY_CONNECTION_FAILED", "Could not connect through the system proxy. Check system network proxy settings and whether the proxy is running, then try again."],
  ["ERR_TUNNEL_CONNECTION_FAILED", "The system proxy could not open a secure connection to the provider. Check proxy authentication and access to the API host, then try again."],
  ["ERR_PROXY_AUTH_REQUESTED", "The system proxy requires authentication. Check the proxy sign-in in your system network settings, then try again."],
  ["ERR_NAME_NOT_RESOLVED", "The API hostname could not be resolved. Check the endpoint, DNS, and network settings, then try again."],
  ["ERR_INTERNET_DISCONNECTED", "The network is disconnected. Check your internet connection, then try again."],
  ["ERR_CERT_AUTHORITY_INVALID", "The provider's TLS certificate is not trusted. Check the system date and your network's certificate configuration; do not disable certificate verification."],
  ["ERR_CERT_DATE_INVALID", "The provider's TLS certificate has a date error. Check your system clock and network certificate configuration."],
  ["ERR_CERT_COMMON_NAME_INVALID", "The provider's TLS certificate does not match the host. Check the endpoint and your network certificate configuration."],
  ["ERR_SSL_PROTOCOL_ERROR", "A secure TLS connection could not be established. Check the provider endpoint and your proxy or firewall settings."],
]);

class ModelRequestError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function timeoutError(status) {
  return new ModelRequestError(
    "AGENT_TIMEOUT",
    "The model request timed out. Try again; if it keeps happening, check your connection and the provider's status.",
    status,
  );
}

function getChatEndpoint(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid protocol");
    const pathname = url.pathname.replace(/\/+$/, "");
    url.pathname = pathname.endsWith("/chat/completions") ? pathname : `${pathname}/chat/completions`;
    return url.toString();
  } catch {
    throw new ModelRequestError("AGENT_REQUEST", "The API base URL is invalid. Set an HTTP or HTTPS chat endpoint in settings.");
  }
}

function getModelEndpoint(chatEndpoint, model) {
  try {
    const url = new URL(chatEndpoint);
    if (!url.pathname.endsWith("/chat/completions")) throw new Error("Not a chat endpoint");
    url.pathname = `${url.pathname.slice(0, -"/chat/completions".length)}/models/${encodeURIComponent(String(model || ""))}`;
    url.search = "";
    return url.toString();
  } catch {
    throw new ModelRequestError("AGENT_REQUEST", "The API model endpoint is invalid. Check the API base URL and model in settings.");
  }
}

function httpError(status, payload) {
  const detail = Array.isArray(payload) ? payload[0]?.error : payload?.error;
  // Inspect provider details for classification only; never expose echoed credentials or URLs.
  const description = [detail?.code, detail?.status, detail?.type, detail?.param, detail?.message, payload?.message]
    .filter((value) => typeof value === "string").join(" ");
  const authFailure = /invalid_api_key|api_key_invalid|unauthenticated|authentication_error|api[ _-]?key.{0,60}(?:invalid|not valid|expired|revoked)|(?:invalid|expired|revoked).{0,40}api[ _-]?key|(?:please\s+)?(?:pass|provide|use|supply)\s+(?:a\s+)?valid\s+api[ _-]?key/i.test(description);
  const modelFailure = /model_not_found|invalid_model|unknown_model|unsupported_model|\bmodel\b.{0,120}(?:does not exist|not found|not supported)|(?:invalid|unknown|unsupported)\s+model\b/i.test(description);
  const billingFailure = /billing|payment|quota|resource.?exhausted|insufficient.?funds|set\s+up\s+billing|enable\s+billing|billing\s+account|generativelanguage\.googleapis\.com.*(?:enable|billing)/i.test(description);
  if (billingFailure || status === 402) {
    return new ModelRequestError("AGENT_BILLING", "The provider accepted the key but blocked generation because billing or quota is not enabled for this project. Check Gemini billing and quota, then try again.", status);
  }
  if (status === 401 || status === 403 || authFailure) {
    return new ModelRequestError("AGENT_AUTH", "The provider rejected authentication or access. Check your API key and permissions for the configured provider and model in settings.", status);
  }
  if (status === 404 || modelFailure
    || ([400, 422].includes(status) && /\bmodel\b|model[_-]/i.test(description))) {
    return new ModelRequestError("AGENT_MODEL", "The configured model or chat endpoint is unavailable. Check the model name, API base URL, and model access in settings.", status);
  }
  if (status === 408 || status === 504) return timeoutError(status);
  if (status === 429) {
    return new ModelRequestError("AGENT_RATE_LIMIT", "The provider's rate limit or quota was reached. Wait before trying again, and check your quota or billing if it continues.", status);
  }
  if (status >= 500 || status === 425) {
    return new ModelRequestError("AGENT_UNAVAILABLE", "The model provider is temporarily unavailable. Try again shortly or check the provider's status.", status);
  }
  return new ModelRequestError("AGENT_REQUEST", `The provider rejected the request (HTTP ${status}). Check the API base URL, model, and provider settings.`, status);
}

function validatePayload(payload) {
  const message = payload?.choices?.[0]?.message;
  const invalid = () => new ModelRequestError("AGENT_BAD_RESPONSE", "The provider returned an invalid chat response. Check that the API base URL and model support chat completions, then try again.");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !Array.isArray(payload.choices) || !message || typeof message !== "object" || Array.isArray(message)
    || !Object.prototype.hasOwnProperty.call(message, "content")) throw invalid();

  const content = message.content;
  let text;
  if (content === null) text = "";
  else if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    if (!content.every((part) => typeof part === "string" || (part && typeof part.text === "string"))) throw invalid();
    text = content.map((part) => typeof part === "string" ? part : part.text).join("");
  } else throw invalid();

  if (!text.trim()) {
    throw new ModelRequestError("AGENT_EMPTY_RESPONSE", "The provider returned no assistant text. Try again or select a model that supports text chat in settings.");
  }
  return payload;
}

function retryDelay(value, wallNow) {
  if (!value || !value.trim()) return RETRY_DELAY_MS;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1_000;
  // Do not interpret malformed numeric delays as calendar dates.
  const date = /[a-z]/i.test(trimmed) ? Date.parse(trimmed) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - wallNow) : RETRY_DELAY_MS;
}

function transportCode(error) {
  return error?.cause?.code || error?.code || String(error?.message || "").match(/\bnet::(ERR_[A-Z_]+)\b/)?.[1];
}

function networkError(cause) {
  return new ModelRequestError("AGENT_NETWORK", NETWORK_GUIDANCE.get(transportCode(cause))
    || "Could not reach the model provider. Check your internet connection, API base URL, and proxy or firewall settings, then try again.");
}

function isTimeout(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError" || TIMEOUT_CODES.has(transportCode(error));
}

function isTransientNetworkError(error) {
  const code = transportCode(error);
  return NETWORK_CODES.has(code) || (!code && ["TypeError", "NetworkError"].includes(error?.name));
}

function supportsLowReasoning(endpoint, model) {
  try {
    return new URL(endpoint).hostname === "generativelanguage.googleapis.com"
      && /^gemini-3(?:\.|$)/i.test(String(model || ""));
  } catch {
    return false;
  }
}

function shouldOmitTemperature(endpoint, model) {
  try {
    if (new URL(endpoint).hostname !== "generativelanguage.googleapis.com") return false;
    const name = String(model || "").toLowerCase();
    if (/^gemini-4(?:[.-]|$)/.test(name)) return true;
    const match = name.match(/^gemini-3\.(\d+)(?:[.-]|$)/);
    return Boolean(match && Number(match[1]) >= 6);
  } catch {
    return false;
  }
}

function getGeminiInteractionsEndpoint(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.hostname !== "generativelanguage.googleapis.com") throw new Error("Not Gemini");
    return `${url.origin}/v1beta/interactions`;
  } catch {
    throw new ModelRequestError("AGENT_REQUEST", "The Gemini API endpoint is invalid. Check the API base URL in settings.");
  }
}

function interactionText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  // REST returns typed steps, not the SDK's output_text convenience property.
  // Never treat echoed user input, thoughts, or tool results as an answer.
  const output = Array.isArray(payload?.steps)
    ? payload.steps.filter((step) => step?.type === "model_output").at(-1)
    : null;
  return Array.isArray(output?.content)
    ? output.content.filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text).join("")
    : "";
}

function validateInteraction(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ModelRequestError("AGENT_BAD_RESPONSE", "Gemini returned an invalid response. Check the endpoint and try again.");
  }
  if (payload.status === "incomplete") {
    throw new ModelRequestError("AGENT_INCOMPLETE_RESPONSE", "Gemini reached its generation limit before finishing an answer. Try a shorter question or check the model settings.");
  }
  if (payload.status && payload.status !== "completed") {
    throw new ModelRequestError("AGENT_BAD_RESPONSE", "Gemini did not complete the generation. Check the model settings and try again.");
  }
  const text = interactionText(payload);
  if (!text.trim()) throw new ModelRequestError("AGENT_EMPTY_RESPONSE", "Gemini returned no assistant text. Try again or check the model settings.");
  return { choices: [{ message: { content: text } }] };
}

// Resolves to the original, validated chat-completion payload. No config or key lookup.
// Dependencies are injectable for offline tests; production limits are fixed.
async function requestModel({ endpoint, model, apiKey, messages, maxTokens = 600, timeoutMs = TOTAL_TIMEOUT_MS }, dependencies = {}) {
  const requestBody = { model, messages, max_tokens: maxTokens };
  if (!shouldOmitTemperature(endpoint, model)) requestBody.temperature = 0.2;
  if (supportsLowReasoning(endpoint, model)) requestBody.reasoning_effort = "low";
  return requestJson({
    endpoint,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: JSON.stringify(requestBody),
    timeoutMs,
    validate: validatePayload,
  }, dependencies);
}

// Both provider paths share a single deadline, including body reads and retries.
async function requestJson({ endpoint, headers, body, timeoutMs, validate, method = "POST" }, {
  fetch: fetchImpl = globalThis.fetch,
  now = () => performance.now(),
  wallNow = Date.now,
  setTimeout: schedule = setTimeout,
  clearTimeout: cancel = clearTimeout,
} = {}) {
  const controller = new AbortController();
  const deadlineAt = now() + timeoutMs;
  let deadlineTimer;
  let retryTimer;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = schedule(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  // The race also bounds a stalled body read or a fetch implementation ignoring abort.
  const withinDeadline = async (operation) => {
    const result = await Promise.race([operation, deadline]);
    if (now() >= deadlineAt) {
      controller.abort();
      throw timeoutError();
    }
    return result;
  };

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response;
      try {
        response = await withinDeadline(fetchImpl(endpoint, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body,
          signal: controller.signal,
        }));
        const text = await withinDeadline(response.text());
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
        if (!response.ok) throw httpError(response.status, payload);
        return validate(payload);
      } catch (cause) {
        // Normalize before considering the attempt count, including the final attempt.
        const error = isTimeout(cause) || controller.signal.aborted || now() >= deadlineAt
          ? timeoutError(response?.status)
          : cause instanceof ModelRequestError
            ? cause
            : response && !response.ok
              ? httpError(response.status, null)
              : networkError(cause);
        // Only expose known error identifiers, never raw network messages which
        // may include URLs, proxy credentials, or provider response bodies.
        const networkCode = transportCode(cause);
        if (NETWORK_CODES.has(networkCode) || TIMEOUT_CODES.has(networkCode) || NETWORK_GUIDANCE.has(networkCode)) {
          error.networkCode = networkCode;
        }
        const retryable = error.code === "AGENT_NETWORK"
          ? isTransientNetworkError(cause)
          : ["AGENT_RATE_LIMIT", "AGENT_UNAVAILABLE"].includes(error.code) && RETRYABLE_STATUSES.has(error.status);
        if (attempt === 1 || !retryable) throw error;

        const delay = retryDelay(response?.headers?.get("retry-after"), wallNow());
        // Never retry earlier than Retry-After or spend the remaining budget waiting.
        if (delay > MAX_RETRY_DELAY_MS || deadlineAt - now() - delay < MIN_RETRY_BUDGET_MS) throw error;
        await withinDeadline(new Promise((resolve) => {
          retryTimer = schedule(resolve, delay);
        }));
        if (deadlineAt - now() < MIN_RETRY_BUDGET_MS) throw error;
      }
    }
  } finally {
    cancel(deadlineTimer);
    if (retryTimer !== undefined) cancel(retryTimer);
  }
}

async function checkModelAccess({ endpoint, model, apiKey, timeoutMs = 10_000 }, dependencies = {}) {
  return requestJson({
    endpoint: getModelEndpoint(endpoint, model),
    method: "GET",
    headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    timeoutMs,
    validate: (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || !(typeof payload.name === "string" || typeof payload.id === "string")) {
        throw new ModelRequestError("AGENT_BAD_RESPONSE", "The model lookup returned an invalid response. Check the API endpoint and model in settings.");
      }
      return payload;
    },
  }, dependencies);
}

// Gemini keeps its native schema/auth while sharing the bounded HTTP transport.
async function requestGeminiInteraction({ baseUrl, model, apiKey, messages, maxTokens = 600, timeoutMs = TOTAL_TIMEOUT_MS }, dependencies = {}) {
  const endpoint = getGeminiInteractionsEndpoint(baseUrl);
  const system = messages.find((message) => message.role === "system")?.content || "";
  const input = messages
    .filter((message) => message.role !== "system")
    .map((message) => `[${message.role}]\n${message.content}`)
    .join("\n\n");
  const body = JSON.stringify({
    model,
    system_instruction: system,
    input,
    store: false,
    generation_config: {
      thinking_level: "low",
      thinking_summaries: "none",
      max_output_tokens: maxTokens,
    },
  });
  return requestJson({
    endpoint,
    headers: { "x-goog-api-key": apiKey },
    body,
    timeoutMs,
    validate: validateInteraction,
  }, dependencies);
}

module.exports = {
  getChatEndpoint,
  getModelEndpoint,
  getGeminiInteractionsEndpoint,
  requestModel,
  requestGeminiInteraction,
  checkModelAccess,
  TOTAL_TIMEOUT_MS,
};
