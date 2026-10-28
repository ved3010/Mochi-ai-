const http = require('http');
const WebSocket = require('ws');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function runTest() {
  try {
    console.log('Fetching DevTools targets...');
    const targets = await getJson('http://localhost:9222/json');
    const pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget) {
      throw new Error('No page target found');
    }
    const wsUrl = pageTarget.webSocketDebuggerUrl;
    console.log('Connecting to WebSocket:', wsUrl);
    
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const pending = {};

    const send = (method, params = {}) => {
      return new Promise((resolve, reject) => {
        const msgId = id++;
        pending[msgId] = { resolve, reject };
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    };

    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.method === 'Console.messageAdded') {
        console.log('Console Log:', msg.params.message.text);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        console.error('Console Exception:', JSON.stringify(msg.params.exceptionDetails, null, 2));
      }
      if (pending[msg.id]) {
        if (msg.error) {
          pending[msg.id].reject(msg.error);
        } else {
          pending[msg.id].resolve(msg.result);
        }
        delete pending[msg.id];
      }
    });

    await new Promise((resolve) => ws.on('open', resolve));
    console.log('Connected. Enabling Console and Runtime...');
    await send('Console.enable');
    await send('Runtime.enable');

    console.log('Checking initial speech bubble content...');
    let result = await send('Runtime.evaluate', {
      expression: "document.getElementById('cat-speech-bubble').textContent",
      returnByValue: true
    });
    console.log('Initial bubble text:', JSON.stringify(result.result.value));

    console.log('Clicking the microphone button...');
    const clickResult = await send('Runtime.evaluate', {
      expression: "document.getElementById('voice-mic-button').click()"
    });
    if (clickResult.exceptionDetails) {
      console.error('Click threw exception:', clickResult.exceptionDetails);
    }

    console.log('Waiting 1500ms for visual feedback...');
    await new Promise(r => setTimeout(r, 1500));

    result = await send('Runtime.evaluate', {
      expression: "document.getElementById('cat-speech-bubble').textContent",
      returnByValue: true
    });
    const bubbleTextAfterClick = result.result.value;
    console.log('Bubble text after click:', JSON.stringify(bubbleTextAfterClick));
    
    if (bubbleTextAfterClick === 'Listening... 🎙️') {
      console.log('SUCCESS: Visual feedback verified ("Listening... 🎙️")');
    } else {
      console.error('FAILURE: Unexpected bubble text after click:', JSON.stringify(bubbleTextAfterClick));
    }

    console.log('Waiting 7500ms to test timeout (should be 7 seconds)...');
    await new Promise(r => setTimeout(r, 7500));

    result = await send('Runtime.evaluate', {
      expression: "document.getElementById('cat-speech-bubble').textContent",
      returnByValue: true
    });
    const bubbleTextAfterTimeout = result.result.value;
    console.log('Bubble text after timeout:', JSON.stringify(bubbleTextAfterTimeout));

    if (!bubbleTextAfterTimeout || bubbleTextAfterTimeout.trim() === '') {
      console.log('SUCCESS: Timeout verified (bubble is cleared)');
    } else {
      console.error('FAILURE: Speech bubble not cleared after timeout:', JSON.stringify(bubbleTextAfterTimeout));
    }

    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
}

runTest();
