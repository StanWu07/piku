const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexClient, ChatGPTService, loginUrl, friendlyError } = require('../src/codex.cjs');

class FakeClient extends EventEmitter {
  constructor() { super(); this.executable = '/fake/codex'; this.directory = '/tmp/fake'; this.calls = []; this.account = null; this.mode = 'success'; }
  async start() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: this.account };
    if (method === 'model/list') return { data: [{ model: 'test-model', displayName: 'Test', isDefault: true }], nextCursor: null };
    if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/authorize?state=opaque' };
    if (method === 'account/logout') this.account = null;
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      if (this.mode === 'success' || this.mode === 'quota') setImmediate(() => {
        this.emit('notification', 'item/completed', { threadId: 'unrelated', item: { type: 'agentMessage', text: '{"wrong":true}' } });
        this.emit('notification', 'item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: '{"answer":"ok"}' } });
        this.emit('notification', 'turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: this.mode === 'quota' ? 'failed' : 'completed', error: this.mode === 'quota' ? { message: 'usageLimitExceeded' } : null, items: [] } });
      });
      if (this.mode === 'disconnect') setImmediate(() => this.emit('disconnected'));
      return { turn: { id: 'turn-1' } };
    }
    return {};
  }
  stop() { this.emit('disconnected'); }
}
const signedIn = () => { const client = new FakeClient(); client.account = { type: 'chatgpt', email: 'test@example.com', planType: 'plus' }; return client; };
test('login launches only official URL, supports cancel, updates account and logs out independently', async () => {
  const client = new FakeClient(); const service = new ChatGPTService({ client }); let opened;
  await service.login(url => { opened = url; }); assert.match(opened, /^https:\/\/auth.openai.com/); assert.equal(service.snapshot().loginPending, true);
  assert.deepEqual(client.calls.find(c => c.method === 'account/login/start').params, { type: 'chatgpt' });
  await assert.rejects(service.login(() => {}), /浏览器/); await service.cancelLogin(); assert.equal(service.snapshot().loginPending, false);
  await service.login(() => {}); client.account = signedIn().account;
  client.emit('notification', 'account/login/completed', { loginId: 'login-1', success: true }); await service.refresh();
  assert.equal(service.snapshot().account.email, 'test@example.com'); assert.equal(service.snapshot().models[0].id, 'test-model');
  await service.logout(); assert.equal(service.snapshot().connected, false); service.stop();
});
test('unsafe login URLs never open and failed browser opening cancels server login', async () => {
  for (const url of ['http://auth.openai.com', 'https://auth.openai.com.evil.test', 'file:///tmp/login', 'https://user:pass@chatgpt.com', 'https://chatgpt.com:444']) assert.throws(() => loginUrl(url));
  const client = new FakeClient(); const service = new ChatGPTService({ client });
  await assert.rejects(service.login(() => { throw new Error('browser unavailable'); }), /browser/);
  assert.equal(service.snapshot().loginPending, false); assert.ok(client.calls.some(c => c.method === 'account/login/cancel')); service.stop();
});
test('login timeout cancels remote session', async () => {
  const client = new FakeClient(); const service = new ChatGPTService({ client, loginTimeout: 10 });
  await service.login(() => {}); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(service.snapshot().loginPending, false); assert.match(service.snapshot().error, /超时/); service.stop();
});
test('cancelling while login is starting prevents a late browser launch', async () => {
  const client = new FakeClient(); const original = client.request.bind(client); let finish;
  client.request = (method, params) => method === 'account/login/start' ? new Promise(resolve => { finish = resolve; }) : original(method, params);
  const service = new ChatGPTService({ client });
  const attempt = service.login(() => assert.fail('cancelled login opened a browser'));
  await new Promise(resolve => setImmediate(resolve)); await service.cancelLogin();
  finish({ loginId: 'late-login', authUrl: 'https://auth.openai.com/authorize' }); await attempt;
  assert.equal(service.snapshot().loginPending, false); assert.ok(client.calls.some(c => c.method === 'account/login/cancel' && c.params.loginId === 'late-login')); service.stop();
});
test('generation requires ChatGPT auth and consumes only its own completed structured message', async () => {
  const client = signedIn(); const service = new ChatGPTService({ client });
  const result = await service.generate({ model: 'test-model', schema: { type: 'object' }, input: 'analyze', instructions: 'instructions' });
  assert.deepEqual(result, { answer: 'ok' });
  const params = client.calls.find(c => c.method === 'thread/start').params;
  assert.equal(params.sandbox, 'read-only'); assert.deepEqual(params.environments, []); assert.equal(params.ephemeral, true);
  assert.ok(client.calls.some(c => c.method === 'thread/unsubscribe'));
  client.account = { type: 'apiKey' }; await assert.rejects(service.generate({}), /登录 ChatGPT/); service.stop();
});
test('image input is attached to the turn and cancellation interrupts only that turn', async () => {
  const client = signedIn(); const service = new ChatGPTService({ client });
  await service.generate({ schema: {}, input: 'read screenshot', imagePath: '/tmp/region.png' });
  const input = client.calls.find(c => c.method === 'turn/start').params.input;
  assert.deepEqual(input[1], { type: 'localImage', path: '/tmp/region.png' });
  client.mode = 'timeout'; const controller = new AbortController();
  const job = service.generate({ schema: {}, input: 'test', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(job, /取消/); assert.ok(client.calls.some(c => c.method === 'turn/interrupt')); service.stop();
});
test('generation handles timeout, disconnection and quota; rejects overlapping jobs', async () => {
  for (const mode of ['timeout', 'disconnect', 'quota']) {
    const client = signedIn(); client.mode = mode; const service = new ChatGPTService({ client, turnTimeout: 15 });
    const first = service.generate({ schema: {}, input: 'test' });
    await assert.rejects(service.generate({}), /上一项/);
    await assert.rejects(first, mode === 'timeout' ? /超时/ : mode === 'quota' ? /额度/ : /断开/);
    assert.equal(service.busy, false); assert.equal(client.listenerCount('notification'), 1); service.stop();
  }
  assert.match(friendlyError({ message: 'secret-token unauthorized' }), /登录状态/);
});
test('stdio transport initializes, isolates environment, rejects server execution and fails pending requests on exit', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'piku-transport-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit('exit', 0);
  let launch; const messages = [];
  child.stdin.on('data', bytes => {
    const message = JSON.parse(bytes.toString()); messages.push(message);
    if (message.method === 'initialize') child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
  });
  const client = new CodexClient({ directory, executable: '/fake/codex', spawnImpl: (...args) => { launch = args; return child; } });
  await client.start(); assert.equal(messages[1].method, 'initialized');
  assert.equal(launch[2].env.CODEX_HOME, directory); assert.equal(launch[2].env.OPENAI_API_KEY, undefined);
  assert.ok(launch[1].includes('forced_login_method="chatgpt"'));
  child.stdout.write(JSON.stringify({ id: 99, method: 'item/commandExecution/requestApproval', params: {} }) + '\n');
  assert.equal(messages.at(-1).error.code, -32601);
  const pending = client.request('account/read'); client.stop(); await assert.rejects(pending, /断开/); assert.equal(client.pending.size, 0);
});
