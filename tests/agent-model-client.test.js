"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getChatEndpoint,
  getModelEndpoint,
  getGeminiInteractionsEndpoint,
  requestModel,
  requestGeminiInteraction,
  checkModelAccess,
  TOTAL_TIMEOUT_MS,
} = require("../agent-model-client");

const success = { choices: [{ message: { content: "Hello from the configured model" } }] };
const input = {
  endpoint: "https://provider.invalid/custom/chat/completions?version=test",
  model: "configured-model",
  apiKey: "test-only-placeholder",
  messages: [{ role: "user", content: "Hello" }],
};

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

function clock() {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  const wallStart = Date.UTC(2026, 9, 21);
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  return {
    dependencies: {
      now: () => time,
      wallNow: () => wallStart + time,
      setTimeout: (callback, delay) => {
        const id = ++nextId;
        timers.set(id, { at: time + delay, callback });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    pending: () => timers.size,
    flush,
    async advance(milliseconds) {
      await flush();
      const target = time + milliseconds;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      time = target;
      await flush();
    },
  };
}

function harness(fetchImpl) {
  const timing = clock();
  const calls = [];
  return {
    timing,
    calls,
    run: (request = input) => requestModel(request, {
      ...timing.dependencies,
      fetch: (endpoint, options) => {
        calls.push({ endpoint, options, at: timing.dependencies.now() });
        return fetchImpl(endpoint, options, calls.length, timing);
      },
    }),
  };
}

function hasCode(code, status) {
  return (error) => {
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.match(error.message, /check|try again|trying again|settings/i);
    assert.doesNotMatch(error.message, /This operation was aborted|test-only-placeholder/);
    return true;
  };
}

function pendingUntilAbort(signal) {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
  });
}

test("endpoint construction preserves the configured provider, path, and query", () => {
  assert.equal(getChatEndpoint("https://provider.invalid/custom/"), "https://provider.invalid/custom/chat/completions");
  assert.equal(getChatEndpoint(input.endpoint), input.endpoint);
  assert.equal(getChatEndpoint("http://127.0.0.1:1234/v1/chat/completions/?version=test"), "http://127.0.0.1:1234/v1/chat/completions?version=test");
  assert.throws(() => getChatEndpoint("file:///invalid"), hasCode("AGENT_REQUEST"));
});

test("Gemini model access checks use the provider model endpoint without leaking the key", async () => {
  const endpoint = getChatEndpoint("https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(getModelEndpoint(endpoint, "gemini-3.8-flash"), "https://generativelanguage.googleapis.com/v1beta/openai/models/gemini-3.8-flash");
  let request;
  await checkModelAccess({ endpoint, model: "gemini-3.8-flash", apiKey: "test-only-key" }, {
    fetch: async (url, options) => {
      request = { url, options };
      return response(200, { name: "models/gemini-3.8-flash" });
    },
  });
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.Authorization, "Bearer test-only-key");
  assert.match(request.url, /\/models\/gemini-3\.8-flash$/);
});

test("model-access lookup has a hard deadline even for a stalled body", async () => {
  const timing = clock();
  let signal;
  const result = assert.rejects(checkModelAccess(input, {
    ...timing.dependencies,
    fetch: (_url, options) => {
      signal = options.signal;
      return { ...response(200, {}), text: () => new Promise(() => {}) };
    },
  }), hasCode("AGENT_TIMEOUT"));
  await timing.advance(10_000);
  await result;
  assert.equal(signal.aborted, true);
  assert.equal(timing.pending(), 0);
});

test("model lookup rejects a proxy login page rather than accepting the key", async () => {
  await assert.rejects(checkModelAccess(input, {
    fetch: async () => response(200, "<html>Proxy sign-in required</html>"),
  }), hasCode("AGENT_BAD_RESPONSE"));
});

test("Chromium proxy and certificate errors retain only safe diagnostic codes", async (t) => {
  for (const code of ["ERR_PROXY_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED", "ERR_CERT_AUTHORITY_INVALID"]) {
    await t.test(code, async () => {
      const client = harness(() => { throw new Error(`net::${code}: https://user:test-only-placeholder@proxy.invalid/private`); });
      await assert.rejects(client.run(), (error) => {
        hasCode("AGENT_NETWORK")(error);
        assert.equal(error.networkCode, code);
        assert.doesNotMatch(JSON.stringify(error), /test-only-placeholder|proxy\.invalid|private/);
        return true;
      });
      assert.equal(client.calls.length, 1, "do not retry proxy configuration or TLS failures");
      assert.equal(client.timing.pending(), 0);
    });
  }
});

test("Chromium transport timeout is classified without retrying generation", async () => {
  const client = harness(() => { throw new Error("net::ERR_TIMED_OUT"); });
  await assert.rejects(client.run(), (error) => {
    hasCode("AGENT_TIMEOUT")(error);
    assert.equal(error.networkCode, "ERR_TIMED_OUT");
    return true;
  });
  assert.equal(client.calls.length, 1);
});

test("Gemini natural-language requests use the native Interactions API", async () => {
  assert.equal(
    getGeminiInteractionsEndpoint("https://generativelanguage.googleapis.com/v1beta/openai"),
    "https://generativelanguage.googleapis.com/v1beta/interactions",
  );
  let request;
  const result = await requestGeminiInteraction({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
    apiKey: "test-only-key",
    messages: [
      { role: "system", content: "Answer clearly." },
      { role: "user", content: "What is 2 + 2?" },
    ],
    timeoutMs: 2_000,
  }, {
    fetch: async (url, options) => {
      request = { url, options };
      return response(200, { output_text: "4" });
    },
  });
  assert.equal(result.choices[0].message.content, "4");
  assert.equal(request.options.headers["x-goog-api-key"], "test-only-key");
  const body = JSON.parse(request.options.body);
  assert.equal(body.system_instruction, "Answer clearly.");
  assert.match(body.input, /\[user\]\nWhat is 2 \+ 2\?/);
  assert.equal(body.generation_config.max_output_tokens, 600);
});

const geminiInput = {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  model: "gemini-3.8-flash",
  apiKey: "test-only-key",
  messages: input.messages,
};

test("Gemini deadline bounds a stuck fetch and response body even when abort is ignored", async (t) => {
  for (const phase of ["fetch", "body"]) {
    await t.test(phase, async () => {
      const timing = clock();
      const calls = [];
      const never = () => new Promise(() => {});
      const request = requestGeminiInteraction({ ...geminiInput, timeoutMs: 100 }, {
        ...timing.dependencies,
        fetch: (_url, options) => {
          calls.push(options);
          return phase === "fetch" ? never() : { ...response(200, {}), text: never };
        },
      });
      // Check settlement without hanging this regression on the broken client.
      let outcome;
      request.then(() => { outcome = "success"; }, (error) => { outcome = error.code; });
      await timing.advance(100);
      assert.equal(outcome, "AGENT_TIMEOUT");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].signal.aborted, true);
      assert.equal(timing.pending(), 0);
    });
  }
});

test("Gemini uses the same bounded transient retry as chat completions", async () => {
  const timing = clock();
  const calls = [];
  const request = requestGeminiInteraction(geminiInput, {
    ...timing.dependencies,
    fetch: (_url, options) => {
      calls.push(options);
      return response(calls.length === 1 ? 503 : 200, { output_text: "OK" });
    },
  });
  const result = request.then((value) => value, (error) => error);
  await timing.advance(500);
  assert.equal((await result).choices?.[0]?.message.content, "OK");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(timing.pending(), 0);
});

test("Gemini only reads final model output, never echoed inputs or tool text", async () => {
  const result = await requestGeminiInteraction(geminiInput, {
    fetch: async () => response(200, {
      status: "completed",
      steps: [
        { type: "user_input", content: [{ type: "text", text: "echoed prompt" }] },
        { type: "tool_result", content: [{ type: "text", text: "tool content" }] },
        { type: "thought", summary: [{ type: "text", text: "thought summary" }] },
        { type: "model_output", content: [{ type: "text", text: "Final " }, { type: "text", text: "answer" }] },
      ],
    }),
  });
  assert.equal(result.choices[0].message.content, "Final answer");
});

test("incomplete Gemini generation is not reported as a successful connection", async () => {
  await assert.rejects(requestGeminiInteraction(geminiInput, {
    fetch: async () => response(200, { status: "incomplete", output_text: "partial" }),
  }), hasCode("AGENT_INCOMPLETE_RESPONSE"));
});

test("success preserves the payload, configured model, credentials, and messages", async () => {
  const client = harness(async () => response(200, success));
  assert.deepEqual(await client.run(), success);
  assert.equal(client.calls.length, 1);
  const { endpoint, options } = client.calls[0];
  assert.equal(endpoint, input.endpoint);
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Authorization, `Bearer ${input.apiKey}`);
  assert.equal(options.headers["Content-Type"], "application/json");
   assert.deepEqual(JSON.parse(options.body), { model: input.model, messages: input.messages, temperature: 0.2, max_tokens: 600 });
  assert.equal(client.timing.pending(), 0);

  const local = harness(async () => response(200, success));
  await local.run({ ...input, apiKey: "" });
  assert.equal(Object.hasOwn(local.calls[0].options.headers, "Authorization"), false);
});

test("Gemini 3 requests use low reasoning without changing other providers", async () => {
  const client = harness(async () => response(200, success));
  await client.run({
    ...input,
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-3.8-flash",
  });
  const geminiBody = JSON.parse(client.calls[0].options.body);
  assert.equal(geminiBody.reasoning_effort, "low");
  assert.equal(Object.hasOwn(geminiBody, "temperature"), false);

  const other = harness(async () => response(200, success));
  await other.run({ ...input, model: "gemini-3.8-flash" });
  assert.equal(Object.hasOwn(JSON.parse(other.calls[0].options.body), "reasoning_effort"), false);
  assert.equal(JSON.parse(other.calls[0].options.body).temperature, 0.2);
});

test("custom max token limits are preserved for quick connection checks", async () => {
  const client = harness(async () => response(200, success));
  await client.run({ ...input, maxTokens: 16 });
  assert.equal(JSON.parse(client.calls[0].options.body).max_tokens, 16);
});

test("a response taking more than the old 12-second limit succeeds", async () => {
  const client = harness((_endpoint, _options, _attempt, timing) => new Promise((resolve) => {
    timing.dependencies.setTimeout(() => resolve(response(200, success)), 20_000);
  }));
  const result = client.run();
  await client.timing.advance(12_000);
  assert.equal(client.calls[0].options.signal.aborted, false);
  await client.timing.advance(8_000);
  assert.deepEqual(await result, success);
  assert.equal(client.calls.length, 1);
  assert.equal(client.timing.pending(), 0);
});

test("first-attempt deadline converts AbortError and does not duplicate the request", async () => {
  const client = harness((_endpoint, { signal }) => pendingUntilAbort(signal));
  const result = assert.rejects(client.run(), hasCode("AGENT_TIMEOUT"));
  await client.timing.advance(TOTAL_TIMEOUT_MS);
  await result;
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].options.signal.aborted, true);
  assert.equal(client.timing.pending(), 0);
});

test("final-attempt AbortError is converted within the original total deadline", async () => {
  const client = harness((_endpoint, { signal }, attempt) => attempt === 1
    ? response(503, { error: { message: "busy" } })
    : pendingUntilAbort(signal));
  const result = assert.rejects(client.run(), hasCode("AGENT_TIMEOUT"));
  await client.timing.advance(TOTAL_TIMEOUT_MS - 1);
  assert.deepEqual(client.calls.map((call) => call.at), [0, 500]);
  assert.equal(client.calls[1].options.signal.aborted, false);
  await client.timing.advance(1);
  await result;
  assert.equal(client.calls.length, 2);
  assert.equal(client.timing.pending(), 0);
});

test("an immediate final-attempt AbortError is also converted", async () => {
  const client = harness((_endpoint, _options, attempt) => {
    if (attempt === 1) return response(503, {});
    throw new DOMException("This operation was aborted", "AbortError");
  });
  const result = assert.rejects(client.run(), hasCode("AGENT_TIMEOUT"));
  await client.timing.advance(500);
  await result;
  assert.equal(client.calls.length, 2);
  assert.equal(client.timing.pending(), 0);
});

test("deadline bounds both an abort-ignoring fetch and stalled response body", async (t) => {
  for (const phase of ["fetch", "body"]) {
    await t.test(phase, async () => {
      const never = () => new Promise(() => {});
      const client = harness(() => phase === "fetch" ? never() : { ...response(200, success), text: never });
      const result = assert.rejects(client.run(), hasCode("AGENT_TIMEOUT"));
      await client.timing.advance(TOTAL_TIMEOUT_MS);
      await result;
      assert.equal(client.calls.length, 1);
      assert.equal(client.timing.pending(), 0);
    });
  }
});

test("503 retries once after 500ms and then succeeds with the same request", async () => {
  const client = harness((_endpoint, _options, attempt) => response(attempt === 1 ? 503 : 200, success));
  const result = client.run();
  await client.timing.advance(499);
  assert.equal(client.calls.length, 1);
  await client.timing.advance(1);
  assert.deepEqual(await result, success);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].options.body, client.calls[1].options.body);
  assert.equal(client.calls[0].endpoint, client.calls[1].endpoint);
  assert.equal(client.timing.pending(), 0);
});

test("retry exhaustion returns a stable unavailable error after only two attempts", async () => {
  const client = harness(() => response(503, "upstream failure"));
  const result = assert.rejects(client.run(), hasCode("AGENT_UNAVAILABLE", 503));
  await client.timing.advance(500);
  await result;
  assert.equal(client.calls.length, 2);
  assert.equal(client.timing.pending(), 0);
});

test("network failures retry once and normalize exhaustion without leaking details", async (t) => {
  for (const recover of [true, false]) {
    await t.test(recover ? "recovery" : "exhaustion", async () => {
      const client = harness((_endpoint, _options, attempt) => {
        if (recover && attempt === 2) return response(200, success);
        throw new TypeError(`fetch failed: ${input.apiKey}`, { cause: { code: "ECONNRESET" } });
      });
      const result = recover ? client.run() : assert.rejects(client.run(), hasCode("AGENT_NETWORK"));
      await client.timing.advance(500);
      if (recover) assert.deepEqual(await result, success);
      else await result;
      assert.equal(client.calls.length, 2);
      assert.equal(client.timing.pending(), 0);
    });
  }
});

test("401/403, invalid models, and other permanent request failures never retry", async (t) => {
  const cases = [
    [401, { error: { message: input.apiKey } }, "AGENT_AUTH"],
    [403, {}, "AGENT_AUTH"],
    [400, { error: { code: "API_KEY_INVALID" } }, "AGENT_AUTH"],
    [400, { error: { message: "API key not valid. Please pass a valid API key." } }, "AGENT_AUTH"],
    [400, { error: { message: "Please pass a valid API key" } }, "AGENT_AUTH"],
    [403, { error: { message: "Billing account is not enabled for this project" } }, "AGENT_BILLING"],
    [429, { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for this project" } }, "AGENT_BILLING"],
    [403, { error: { message: "Set up billing to continue using this API" } }, "AGENT_BILLING"],
    [404, {}, "AGENT_MODEL"],
    [400, { error: { message: "This model is not supported" } }, "AGENT_MODEL"],
    [503, { error: { code: "model_not_found" } }, "AGENT_MODEL"],
    [500, { error: { message: "The model configured-model does not exist" } }, "AGENT_MODEL"],
    [422, { error: { message: "Invalid message format" } }, "AGENT_REQUEST"],
  ];
  for (const [status, payload, code] of cases) {
    await t.test(`${status} ${code}`, async () => {
      const client = harness(() => response(status, payload));
      await assert.rejects(client.run(), hasCode(code, status));
      assert.equal(client.calls.length, 1);
      assert.equal(client.timing.pending(), 0);
    });
  }
});

test("an interrupted authentication response body cannot trigger a network retry", async () => {
  const client = harness(() => ({
    ...response(401, {}),
    text: async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); },
  }));
  await assert.rejects(client.run(), hasCode("AGENT_AUTH", 401));
  assert.equal(client.calls.length, 1);
  assert.equal(client.timing.pending(), 0);
});

test("HTTP and transport timeouts never retry; TLS errors are actionable without retry", async (t) => {
  for (const status of [408, 504]) {
    await t.test(`HTTP ${status}`, async () => {
      const client = harness(() => response(status, {}));
      await assert.rejects(client.run(), hasCode("AGENT_TIMEOUT", status));
      assert.equal(client.calls.length, 1);
    });
  }
  for (const code of ["ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "CERT_HAS_EXPIRED"]) {
    await t.test(code, async () => {
      const client = harness(() => { throw new TypeError("fetch failed", { cause: { code } }); });
      await assert.rejects(client.run(), hasCode(code === "CERT_HAS_EXPIRED" ? "AGENT_NETWORK" : "AGENT_TIMEOUT"));
      assert.equal(client.calls.length, 1);
      assert.equal(client.timing.pending(), 0);
    });
  }
});

test("Retry-After supports seconds and HTTP dates within the bounded retry window", async (t) => {
  for (const header of ["2", new Date(Date.UTC(2026, 9, 21, 0, 0, 2)).toUTCString()]) {
    await t.test(header, async () => {
      const client = harness((_endpoint, _options, attempt) => attempt === 1
        ? response(429, {}, { "Retry-After": header }) : response(200, success));
      const result = client.run();
      await client.timing.advance(1_999);
      assert.equal(client.calls.length, 1);
      await client.timing.advance(1);
      assert.deepEqual(await result, success);
      assert.deepEqual(client.calls.map((call) => call.at), [0, 2_000]);
      assert.equal(client.timing.pending(), 0);
    });
  }
});

test("long Retry-After returns rate-limit guidance without waiting or retrying early", async () => {
  const client = harness(() => response(429, {}, { "Retry-After": "120" }));
  await assert.rejects(client.run(), hasCode("AGENT_RATE_LIMIT", 429));
  assert.equal(client.calls.length, 1);
  assert.equal(client.timing.pending(), 0);
});

test("invalid Retry-After uses the bounded default delay", async () => {
  const client = harness((_endpoint, _options, attempt) => attempt === 1
    ? response(503, {}, { "Retry-After": "-1" }) : response(200, success));
  const result = client.run();
  await client.timing.advance(500);
  assert.deepEqual(await result, success);
  assert.deepEqual(client.calls.map((call) => call.at), [0, 500]);
  assert.equal(client.timing.pending(), 0);
});

test("rate-limit retry exhaustion stays actionable", async () => {
  const client = harness(() => response(429, {}, { "Retry-After": "0" }));
  const result = assert.rejects(client.run(), hasCode("AGENT_RATE_LIMIT", 429));
  await client.timing.advance(0);
  await result;
  assert.equal(client.calls.length, 2);
  assert.equal(client.timing.pending(), 0);
});

test("late transient failures leave a minimum useful budget instead of launching a retry", async () => {
  const client = harness((_endpoint, _options, _attempt, timing) => new Promise((resolve) => {
    timing.dependencies.setTimeout(() => resolve(response(503, {}, { "Retry-After": "2" })), 49_000);
  }));
  const result = assert.rejects(client.run(), hasCode("AGENT_UNAVAILABLE", 503));
  await client.timing.advance(49_000);
  await result;
  assert.equal(client.calls.length, 1);
  assert.equal(client.timing.pending(), 0);
});

test("malformed JSON, invalid success shapes, and empty text fail without retries", async (t) => {
  const cases = [
    ["not JSON", "AGENT_BAD_RESPONSE"],
    [null, "AGENT_BAD_RESPONSE"],
    [{}, "AGENT_BAD_RESPONSE"],
    [{ choices: [] }, "AGENT_BAD_RESPONSE"],
    [{ choices: [{ message: {} }] }, "AGENT_BAD_RESPONSE"],
    [{ choices: [{ message: { content: 42 } }] }, "AGENT_BAD_RESPONSE"],
    [{ choices: [{ message: { content: [{ text: 42 }] } }] }, "AGENT_BAD_RESPONSE"],
    ...["", " \n ", null, [], [{ text: " " }]].map((content) => [
      { choices: [{ message: { content } }] }, "AGENT_EMPTY_RESPONSE",
    ]),
  ];
  for (const [index, [payload, code]] of cases.entries()) {
    await t.test(`${index}: ${code}`, async () => {
      const client = harness(() => response(200, payload));
      await assert.rejects(client.run(), hasCode(code));
      assert.equal(client.calls.length, 1);
      assert.equal(client.timing.pending(), 0);
    });
  }
});

test("multipart text content remains compatible with the existing extractor", async () => {
  const payload = { choices: [{ message: { content: ["Hello", { type: "text", text: " world" }] } }] };
  const client = harness(() => response(200, payload));
  assert.deepEqual(await client.run(), payload);
  assert.equal(client.timing.pending(), 0);
});
