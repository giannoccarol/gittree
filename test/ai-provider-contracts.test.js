const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requestOpenAiCompatible,
  requestAnthropic
} = require('../src/main/ai/ai-providers.mts');
const { generateWithOpencode, collectOpencodeText } = require('../src/main/ai/ai-opencode.mts');

test('openai-compatible request posts chat completions and returns the content', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'TITLE: feat: test\nBODY: details' } }]
      })
    };
  };
  const content = await requestOpenAiCompatible({
    fetch,
    baseUrl: 'https://api.deepseek.com/v1/',
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    prompt: 'write a commit message',
    timeoutMs: 5000
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.messages[0].content, 'write a commit message');
  assert.equal(content, 'TITLE: feat: test\nBODY: details');
});

test('openai-compatible request surfaces provider error messages', async () => {
  const fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'Invalid API key' } })
  });
  await assert.rejects(
    () => requestOpenAiCompatible({
      fetch, baseUrl: 'https://api.example.test', apiKey: 'sk-x',
      model: 'm', prompt: 'p', timeoutMs: 5000
    }),
    /Invalid API key/
  );
});

test('openai-compatible request rejects empty content', async () => {
  const fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [] })
  });
  await assert.rejects(
    () => requestOpenAiCompatible({
      fetch, baseUrl: 'https://api.example.test', apiKey: 'sk-x',
      model: 'm', prompt: 'p', timeoutMs: 5000
    }),
    /empty response/
  );
});

test('anthropic request uses x-api-key and joins content blocks', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        content: [
          { type: 'text', text: 'TITLE: feat: ' },
          { type: 'text', text: 'done\nBODY: ' },
          { type: 'text', text: 'summary' }
        ]
      })
    };
  };
  const content = await requestAnthropic({
    fetch,
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet',
    prompt: 'write',
    timeoutMs: 5000
  });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].options.headers['x-api-key'], 'sk-ant-test');
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(content, 'TITLE: feat: done\nBODY: summary');
});

test('anthropic request surfaces error body messages', async () => {
  const fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: 'Bad model' } })
  });
  await assert.rejects(
    () => requestAnthropic({
      fetch, apiKey: 'sk-ant', model: 'm', prompt: 'p', timeoutMs: 5000
    }),
    /Bad model/
  );
});

function createFakePty(outputText, exitCode = 0) {
  const handlers = { data: [], exit: [] };
  const pty = {
    killed: false,
    onData(listener) { handlers.data.push(listener); return { dispose() {} }; },
    onExit(listener) { handlers.exit.push(listener); return { dispose() {} }; },
    kill() { this.killed = true; },
    emit() {
      for (const listener of handlers.data) listener(outputText);
      for (const listener of handlers.exit) listener({ exitCode });
    }
  };
  return pty;
}

function events(...lines) {
  return lines.map(text => JSON.stringify({
    type: 'text', part: { type: 'text', text }
  })).join('\n');
}

test('opencode generation collects text parts from JSON events over a PTY', async () => {
  const spawn = (executable, args, options) => {
    assert.equal(executable, 'opencode.exe');
    assert.deepEqual(args, ['run', 'write a message', '--format', 'json']);
    assert.ok(options.cols > 0 && options.rows > 0);
    const pty = createFakePty([
      '\u001b[?9001h\u001b[?25l',
      JSON.stringify({ type: 'step_start' }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'TITLE: feat: x' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'BODY: y' } }),
      '\u001b]0;opencode\u0007'
    ].join('\r\n'));
    setImmediate(() => pty.emit());
    return pty;
  };
  const content = await generateWithOpencode({
    spawn, executable: 'opencode.exe', prompt: 'write a message', timeoutMs: 5000
  });
  assert.equal(content, 'TITLE: feat: x\nBODY: y');
});

test('opencode generation forwards an explicit model override', async () => {
  let receivedArgs = null;
  const spawn = (_executable, args) => {
    receivedArgs = args;
    const pty = createFakePty(events('OK'));
    setImmediate(() => pty.emit());
    return pty;
  };
  await generateWithOpencode({
    spawn,
    executable: 'opencode',
    prompt: 'write',
    model: 'opencode-go/deepseek-v4-pro',
    timeoutMs: 5000
  });
  assert.deepEqual(receivedArgs, [
    'run', '--model', 'opencode-go/deepseek-v4-pro', 'write', '--format', 'json'
  ]);
});

test('opencode generation still accepts legacy message-part events', async () => {
  const spawn = () => {
    const pty = createFakePty(JSON.stringify({
      type: 'message', part: { type: 'text', text: 'legacy text' }
    }));
    setImmediate(() => pty.emit());
    return pty;
  };
  const content = await generateWithOpencode({
    spawn, executable: 'opencode', prompt: 'write', timeoutMs: 5000
  });
  assert.equal(content, 'legacy text');
});

test('opencode generation surfaces provider API errors from error events', async () => {
  const spawn = () => {
    const pty = createFakePty(JSON.stringify({
      type: 'error',
      error: { name: 'APIError', data: { message: 'Model unavailable' } }
    }), 1);
    setImmediate(() => pty.emit());
    return pty;
  };
  await assert.rejects(
    () => generateWithOpencode({ spawn, executable: 'opencode', prompt: 'p', timeoutMs: 5000 }),
    /Model unavailable/
  );
});

test('opencode generation normalizes timeouts and missing text', async () => {
  const hangingSpawn = () => createFakePty('');
  await assert.rejects(
    () => generateWithOpencode({ spawn: hangingSpawn, executable: 'opencode', prompt: 'p', timeoutMs: 50 }),
    /timed out/
  );
  const emptySpawn = () => {
    const pty = createFakePty('not json at all');
    setImmediate(() => pty.emit());
    return pty;
  };
  await assert.rejects(
    () => generateWithOpencode({ spawn: emptySpawn, executable: 'opencode', prompt: 'p', timeoutMs: 5000 }),
    /did not return any text/
  );
  const failingSpawn = () => {
    const pty = createFakePty('', 1);
    setImmediate(() => pty.emit());
    return pty;
  };
  await assert.rejects(
    () => generateWithOpencode({ spawn: failingSpawn, executable: 'opencode', prompt: 'p', timeoutMs: 5000 }),
    /exited with code 1/
  );
});

test('opencode generation kills the PTY when the spawn throws', async () => {
  const spawn = () => { throw new Error('cannot spawn'); };
  await assert.rejects(
    () => generateWithOpencode({ spawn, executable: 'opencode', prompt: 'p', timeoutMs: 5000 }),
    /cannot spawn/
  );
});

test('opencode event collection tolerates malformed lines', () => {
  const output = [
    'garbage line',
    JSON.stringify({ type: 'message', part: { type: 'text', text: 'hello' } }),
    ''
  ].join('\n');
  assert.equal(collectOpencodeText(output), 'hello');
});
