"use strict";

// Run with Electron, not node:
// ./node_modules/.bin/electron tests/electron-connection-smoke.cjs
// Linux CI/root: xvfb-run -a ./node_modules/.bin/electron tests/electron-connection-smoke.cjs --no-sandbox
// Uses the actual agent backend, preload and renderer with an isolated profile.
// Never loads personal settings or runs pet hooks. --live-network additionally
// checks Google's HTTP responses with a deliberately invalid test key only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { app, BrowserWindow, net, session } = require("electron");

const root = path.join(__dirname, "..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cat-connection-smoke-"));
app.setPath("userData", profile);
process.env.COMNYANG_AGENT_PORT = "0";
process.env.AGENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
process.env.AGENT_MODEL = "gemini-3.8-flash";
process.env.AGENT_API_KEY = "smoke-test-placeholder";

let window;
let requestCount = 0;
let lookupCount = 0;
let proxyCount = 0;
let mockError;
const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET") {
      assert.equal(request.url, "/models/gemini-3.8-flash");
      assert.equal(request.headers.authorization, "Bearer smoke-test-placeholder");
      lookupCount += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ name: "models/gemini-3.8-flash" }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(request.url, "/interactions");
    assert.equal(request.headers["x-goog-api-key"], "smoke-test-placeholder");
    assert.equal(body.model, "gemini-3.8-flash");
    assert.equal(body.store, false);
    assert.equal(body.generation_config.max_output_tokens, 4096);
    requestCount += 1;
    if (requestCount === 1) {
      assert.match(body.input, /Reply with exactly OK/);
      // Cross BOTH the old 15s backend and 20s renderer cutoffs in real time.
      await new Promise((resolve) => setTimeout(resolve, 21_000));
    } else {
      assert.match(body.input, /Explain binary search simply/);
    }
    const text = requestCount === 1 ? "OK"
      : JSON.stringify({ reply: "Binary search halves a sorted search range each step.", action: null });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text }] }],
    }));
  } catch (error) {
    mockError = error;
    response.writeHead(500);
    response.end("Mock validation failed");
  }
});

// A real HTTP proxy for a deliberately unresolvable provider hostname. No
// internet access is needed; only Chromium's session proxy can reach this mock.
const proxy = http.createServer(async (request, response) => {
  try {
    assert.equal(request.url, "http://cat-proxy-provider.invalid/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer smoke-test-placeholder");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    assert.ok(JSON.parse(raw).messages.length);
    proxyCount += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "Proxy-backed answer." } }] }));
  } catch (error) {
    mockError = error;
    response.writeHead(500);
    response.end("Proxy mock validation failed");
  }
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (expression) => window.webContents.executeJavaScript(expression);
async function waitFor(expression, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (mockError) throw mockError;
    if (await evaluate(expression)) return;
    await wait(100);
  }
  throw new Error(`Smoke condition timed out: ${expression}`);
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const nodeFetch = globalThis.fetch;
  const nativeFetch = net.fetch.bind(net);
  globalThis.fetch = () => assert.fail("Production must not use Node fetch for provider calls");
  net.fetch = (url, options) => {
    if (url === "https://generativelanguage.googleapis.com/v1beta/interactions") {
      return nativeFetch(`http://127.0.0.1:${server.address().port}/interactions`, options);
    }
    if (url === "https://generativelanguage.googleapis.com/v1beta/openai/models/gemini-3.8-flash") {
      return nativeFetch(`http://127.0.0.1:${server.address().port}/models/gemini-3.8-flash`, options);
    }
    assert.equal(url, "http://cat-proxy-provider.invalid/v1/chat/completions", "Unexpected network request");
    return nativeFetch(url, options);
  };
  // Register the production handlers before creating the real renderer window.
  require("../agent-main");
  await app.whenReady();
  window = new BrowserWindow({
    show: false, width: 420, height: 650,
    webPreferences: { preload: path.join(root, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  await window.loadFile(path.join(root, "renderer/index.html"));
  await waitFor('document.getElementById("agent-model").value === "gemini-3.8-flash"');
  await evaluate('document.getElementById("agent-search-toggle").click(); document.getElementById("agent-search-settings").click(); document.getElementById("agent-connection-test").click();');
  await waitFor('document.getElementById("agent-config-status").textContent.includes("Checking the API connection")');
  await waitFor('document.getElementById("agent-config-status").textContent.includes("20s")', 25_000);
  assert.equal(await evaluate('document.getElementById("agent-connection-test").disabled'), true);
  await waitFor('document.getElementById("agent-config-status").textContent.includes("Connected to")');
  assert.equal(requestCount, 1);
  assert.equal(lookupCount, 1);
  assert.equal(await evaluate('(async () => (await window.agentAPI.getState()).history.length)()'), 0);
  console.log("PASS: settings connection check renders a real 21-second reply with no duplicate request or chat history.");
  await evaluate('document.getElementById("agent-search-input").value = "Explain binary search simply"; document.getElementById("agent-search-form").requestSubmit();');
  await waitFor('document.getElementById("agent-response-status").textContent === "Reply"');
  assert.equal(await evaluate('document.getElementById("agent-response-text").textContent'), "Binary search halves a sorted search range each step.");
  assert.equal(await evaluate('document.getElementById("agent-search-send").disabled'), false);
  assert.equal(requestCount, 2);
  console.log("PASS: natural-language prompt travels through renderer → IPC → native Gemini client → mock HTTP → visible reply.");
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  await session.defaultSession.setProxy({ mode: "fixed_servers", proxyRules: `http=127.0.0.1:${proxy.address().port}` });
  await assert.rejects(nodeFetch("http://cat-proxy-provider.invalid/v1/chat/completions", { signal: AbortSignal.timeout(2000) }));
  assert.equal(proxyCount, 0, "Node fetch bypasses the configured proxy");
  await evaluate('(async () => { await window.agentAPI.updateConfig({baseUrl:"http://cat-proxy-provider.invalid/v1",model:"proxy-test-model",apiKey:"smoke-test-placeholder"}); })()');
  const proxied = await evaluate('window.agentAPI.ask("Explain sorting simply")');
  assert.equal(proxied.ok, true);
  assert.equal(proxied.reply, "Proxy-backed answer.");
  assert.equal(proxyCount, 1);
  console.log("PASS: Node fetch fails with a proxy-only provider; the production Electron backend succeeds through the same session proxy.");
  if (process.argv.includes("--live-network")) {
    await session.defaultSession.setProxy({ mode: "system" });
    net.fetch = nativeFetch;
    const client = require("../agent-model-client");
    const input = {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      model: "gemini-3.8-flash", apiKey: "invalid-test-key", timeoutMs: 10_000,
      messages: [{ role: "user", content: "Reply OK" }],
    };
    for (const name of ["checkModelAccess", "requestGeminiInteraction"]) {
      const started = Date.now();
      await assert.rejects(client[name](input, { fetch: (url, options) => nativeFetch(url, { ...options, credentials: "omit", cache: "no-store", redirect: "error" }) }),
        (error) => error.code === "AGENT_AUTH" && error.status === 400);
      console.log(`PASS: live Google ${name} rejects a dummy key via Chromium in ${Date.now() - started}ms (no real key used).`);
    }
  }
}

const watchdog = setTimeout(() => {
  console.error("Electron connection smoke exceeded its 60-second budget.");
  finish(1);
}, 60_000);
main().then(() => finish(0), (error) => { console.error(error); finish(1); });
let finishing = false;
function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  window?.destroy();
  server.closeAllConnections();
  proxy.closeAllConnections();
  proxy.close();
  server.close(() => {
    fs.rmSync(profile, { recursive: true, force: true });
    app.exit(code);
  });
}
