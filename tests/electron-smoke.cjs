"use strict";

// Optional live-window check, not part of npm test. Start the app with
// --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 first.
// Does not grant approvals, modify credentials, or print saved conversation data.
const assert = require("node:assert/strict");

async function main() {
  const targets = await (await fetch("http://127.0.0.1:9222/json", { signal: AbortSignal.timeout(5000) })).json();
  const target = targets.find((item) => item.url.endsWith("/cattt/renderer/index.html"));
  assert.ok(target, "Cat renderer must be running with temporary local debugging");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Local debugging handshake timed out")); }, 5000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = (error) => { clearTimeout(timer); reject(error); };
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timed out: ${method}`)); }, 65000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const value = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await call("Page.reload");
    await wait(1000);
    const initial = await evaluate(`({hidden: document.getElementById("agent-panel").hidden,
      toggleVisible: getComputedStyle(document.getElementById("agent-search-toggle")).display !== "none",
      ipc: typeof window.agentAPI?.ask === "function"})`);
    assert.deepEqual(initial, { hidden: true, toggleVisible: true, ipc: true });
    console.log("Live startup: collapsed button and IPC ready.");
    await evaluate('document.getElementById("agent-search-toggle").click(); document.querySelector("[data-agent-prompt=help]").click();');
    await wait(300);
    const help = await evaluate(`(() => { const panel=document.getElementById("agent-panel"), r=panel.getBoundingClientRect();
      return {text:document.getElementById("agent-response-text").textContent, busy:document.getElementById("agent-search-form").getAttribute("aria-busy"),
      inside:r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight,
      monochrome:getComputedStyle(document.getElementById("agent-search-shell")).backgroundColor}; })()`);
    assert.match(help.text, /Unstop/);
    assert.equal(help.busy, "false");
    assert.equal(help.inside, true);
    assert.equal(help.monochrome, "rgb(255, 255, 255)");
    await evaluate(`document.querySelector('[data-agent-prompt="open Unstop"]').click();`);
    await wait(300);
    const approval = await evaluate('({shown:!document.getElementById("agent-action-confirm").hidden,text:document.getElementById("agent-action-description").textContent})');
    assert.equal(approval.shown, true);
    assert.match(approval.text, /https:\/\/unstop.com\//);
    await evaluate('document.getElementById("agent-action-reject").click();');
    const music = await evaluate(`(async () => { const start=performance.now(); const reply=await window.agentAPI.ask("play Yellow on Spotify");
      return {ok:reply.ok, action:reply.action, needsApproval:reply.confirmationRequired, elapsed:Math.round(performance.now()-start)}; })()`);
    assert.equal(music.ok, true);
    assert.equal(music.needsApproval, true);
    assert.equal(music.action.url, "https://open.spotify.com/search/Yellow");
    console.log(`Live UI passed: collapsed button, IPC, help, monochrome layout, Unstop approval, Spotify search (${music.elapsed}ms).`);
    if (process.argv.includes("--live-model")) {
      await evaluate('document.getElementById("agent-search-input").value="Explain binary search in one short sentence."; document.getElementById("agent-search-form").requestSubmit();');
      let outcome;
      for (let seconds = 0; seconds < 62; seconds++) {
        await wait(1000);
        outcome = await evaluate(`({busy:document.getElementById("agent-search-form").getAttribute("aria-busy")==="true",
          status:document.getElementById("agent-response-status").textContent,
          length:document.getElementById("agent-response-text").textContent.length,
          rawAbort:document.getElementById("agent-response-text").textContent.includes("This operation was aborted"),
          retryVisible:!document.getElementById("agent-response-retry").hidden,
          promptPreserved:document.getElementById("agent-search-input").value==="Explain binary search in one short sentence."})`);
        if (!outcome.busy) break;
      }
      assert.equal(outcome.busy, false, "Provider request must finish within the budget");
      assert.equal(outcome.rawAbort, false);
      if (outcome.status === "Reply") assert.ok(outcome.length > 0);
      else { assert.equal(outcome.retryVisible, true); assert.equal(outcome.promptPreserved, true); }
      console.log("Live provider outcome (no conversation contents):", JSON.stringify(outcome));
    }
    // Show only public help content for an optional window-only screenshot.
    await evaluate('document.querySelector("[data-agent-prompt=help]").click();');
    await wait(200);
    if (process.env.CAT_SMOKE_SCREENSHOT) {
      const screenshot = await call("Page.captureScreenshot", { format: "png" });
      require("node:fs").writeFileSync(process.env.CAT_SMOKE_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
    }
    await evaluate('document.getElementById("agent-search-hide").click();');
  } finally { socket.close(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
