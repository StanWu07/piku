const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');

function findCodex() {
  const candidates = ['/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex', path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'), path.join(os.homedir(), 'Applications/Codex.app/Contents/Resources/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex', ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'codex'))];
  return candidates.find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
}
function loginUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('登录服务返回的地址不属于受信任的官方登录页面');
  return url.href;
}
function friendlyError(error) {
  const message = String(error?.message || error || '');
  if (/usage.?limit|rate.?limit|quota|额度|429/i.test(message)) return 'ChatGPT 账号额度已用尽或请求过于频繁，请稍后重试';
  if (/unauthorized|authentication|401|token.*expired/i.test(message)) return '登录状态已失效，请重新登录 ChatGPT';
  if (/model.*(not|unavailable|support)/i.test(message)) return '当前账号暂不支持所选模型，请在设置中刷新模型列表';
  if (/keyring|keychain/i.test(message)) return '系统钥匙串不可用，请解锁后重试登录';
  if (/timeout|timed out|超时/i.test(message)) return '连接超时，请检查网络后重试';
  return 'ChatGPT 服务暂时不可用，请检查网络和登录状态后重试';
}
class CodexClient extends EventEmitter {
  constructor({ directory, executable = findCodex(), spawnImpl = spawn, requestTimeout = 30000 }) {
    super(); this.directory = directory; this.executable = executable; this.spawnImpl = spawnImpl; this.requestTimeout = requestTimeout;
    this.pending = new Map(); this.sequence = 0; this.child = null; this.starting = null;
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.child) return;
    if (!this.executable) throw new Error('未找到 Codex 运行组件。请安装官方 ChatGPT / Codex 桌面版后重新打开 Piku。');
    this.starting = (async () => {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const work = path.join(this.directory, 'workspace'); fs.mkdirSync(work, { recursive: true, mode: 0o700 });
      const env = {};
      for (const name of ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) if (process.env[name]) env[name] = process.env[name];
      // This child has its own official Codex configuration/auth home. Never inherit API credentials or the host app's Codex session.
      env.CODEX_HOME = this.directory;
      const config = ['forced_login_method="chatgpt"', 'cli_auth_credentials_store="keyring"', 'model_provider="openai"', 'web_search="disabled"', 'project_doc_max_bytes=0', 'features.shell_tool=false', 'features.apps=false', 'features.plugins=false', 'features.hooks=false', 'features.multi_agent=false', 'features.remote_plugin=false', 'features.shell_snapshot=false', 'analytics.enabled=false'];
      const child = this.spawnImpl(this.executable, ['app-server', '--listen', 'stdio://', ...config.flatMap(value => ['-c', value])], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stderr.on('data', () => {}); // Runtime diagnostics may include sensitive material; never relay them to UI/logs.
      child.stdin.on('error', () => this.disconnect(child));
      child.once('error', () => this.disconnect(child)); child.once('exit', () => this.disconnect(child));
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => { try { this.receive(JSON.parse(line)); } catch { /* Ignore non-protocol diagnostics. */ } });
      await this.request('initialize', { clientInfo: { name: 'piku', title: 'Piku 日常助手', version: '0.2.0' }, capabilities: { experimentalApi: true } });
      this.send({ method: 'initialized', params: {} });
    })();
    try { await this.starting; } catch (error) { this.stop(); throw error; } finally { this.starting = null; }
  }
  send(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('ChatGPT 连接已断开，请重试');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('请求超时')); }, this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    if (message.method && message.id !== undefined) {
      // Piku's model is an analyst only. No server-initiated command, permission, or tool call may bypass Piku's approval center.
      this.send({ id: message.id, error: { code: -32601, message: 'Piku does not permit runtime tool execution or permission requests.' } }); return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(friendlyError(message.error))); else pending.resolve(message.result);
    } else if (message.method) this.emit('notification', message.method, message.params || {});
  }
  disconnect(child) {
    if (this.child !== child) return;
    this.child = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('ChatGPT 连接已断开，请重试')); }
    this.pending.clear(); this.emit('disconnected');
  }
  stop() { const child = this.child; if (!child) return; this.disconnect(child); child.kill(); }
}
class ChatGPTService {
  constructor({ client, onChange = () => {}, turnTimeout = 150000, loginTimeout = 600000 }) {
    this.client = client; this.onChange = onChange; this.turnTimeout = turnTimeout; this.loginTimeout = loginTimeout;
    this.status = { connected: false, account: null, models: [], loginPending: false, error: null, runtimeAvailable: Boolean(client.executable) };
    this.loginId = null; this.loginTimer = null; this.loginEpoch = 0; this.busy = false; this.active = null; this.refreshing = null;
    client.on('notification', (method, params) => {
      if (method === 'account/login/completed' && params.loginId === this.loginId) {
        this.clearLogin();
        if (params.success) this.refresh().catch(() => {});
        else { this.status.error = params.error ? friendlyError(params.error) : '登录未完成，请重新登录'; this.changed(); }
      }
      if (method === 'account/updated') this.refresh().catch(() => {});
    });
    client.on('disconnected', () => { this.clearLogin(); this.status.connected = false; this.status.account = null; this.status.models = []; this.status.error = 'ChatGPT 连接已断开，请刷新连接'; this.changed(); });
  }
  changed() { this.onChange(this.snapshot()); }
  snapshot() { return structuredClone(this.status); }
  clearLogin() { clearTimeout(this.loginTimer); this.loginTimer = null; this.loginId = null; this.status.loginPending = false; }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        await this.client.start();
        const { account } = await this.client.request('account/read', { refreshToken: false });
        this.status.connected = account?.type === 'chatgpt';
        this.status.account = this.status.connected ? { email: account.email, plan: account.planType } : null;
        this.status.models = []; this.status.error = null;
        if (this.status.connected) {
          let cursor = null;
          do {
            const result = await this.client.request('model/list', { includeHidden: false, limit: 100, cursor });
            this.status.models.push(...result.data.map(m => ({ id: m.model, name: m.displayName || m.model, isDefault: m.isDefault })));
            cursor = result.nextCursor;
          } while (cursor && this.status.models.length < 300);
        }
      } catch (error) { this.status.error = error.message; throw error; } finally { this.changed(); }
      return this.snapshot();
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  async login(openBrowser) {
    if (this.status.loginPending) throw new Error('请先完成浏览器中的登录，或取消后重试');
    const epoch = ++this.loginEpoch;
    this.status.loginPending = true; this.status.error = null; this.changed();
    try {
      await this.client.start();
      const result = await this.client.request('account/login/start', { type: 'chatgpt' });
      if (epoch !== this.loginEpoch) { await this.client.request('account/login/cancel', { loginId: result.loginId }).catch(() => {}); return; }
      this.loginId = result.loginId;
      if (!this.loginId) throw new Error('登录服务未返回有效会话，请重试');
      const url = loginUrl(result.authUrl);
      this.loginTimer = setTimeout(() => { this.cancelLogin().catch(() => {}).finally(() => { this.status.error = '登录等待已超时，请重新登录'; this.changed(); }); }, this.loginTimeout);
      await openBrowser(url);
    } catch (error) {
      if (epoch !== this.loginEpoch) return;
      if (this.loginId) await this.client.request('account/login/cancel', { loginId: this.loginId }).catch(() => {});
      this.clearLogin(); this.status.error = error.message; this.changed(); throw error;
    }
  }
  async cancelLogin() {
    ++this.loginEpoch;
    const loginId = this.loginId;
    if (loginId) await this.client.request('account/login/cancel', { loginId });
    this.clearLogin(); this.changed();
  }
  async logout() {
    if (this.busy) throw new Error('正在分析，请等待完成后退出登录');
    await this.cancelLogin(); await this.client.start(); await this.client.request('account/logout');
    this.status.connected = false; this.status.account = null; this.status.models = []; this.status.error = null; this.changed();
  }
  async generate({ model, schema, input, instructions }) {
    if (this.busy) throw new Error('正在处理上一项请求，请稍候');
    this.busy = true; let threadId, listener, disconnected, timer;
    try {
      await this.refresh();
      if (!this.status.connected) throw new Error('请先在设置中登录 ChatGPT 账号');
      if (model && !this.status.models.some(m => m.id === model)) throw new Error('所选模型不可用，请在设置中重新选择');
      const thread = await this.client.request('thread/start', { ...(model ? { model } : {}), modelProvider: 'openai', cwd: path.join(this.client.directory, 'workspace'), ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', environments: [], selectedCapabilityRoots: [], baseInstructions: instructions, developerInstructions: '只根据提供的文本返回符合 JSON Schema 的最终结果。不得使用工具、读取文件、执行命令或访问外部服务；所有现实操作由 Piku 单独获得用户授权后执行。' });
      threadId = thread.thread.id; let finalText = '', turnId;
      const completion = new Promise((resolve, reject) => {
        listener = (method, params) => {
          if (params.threadId !== threadId) return;
          if (method === 'item/completed' && params.item?.type === 'agentMessage') finalText = params.item.text;
          if (method === 'turn/completed') {
            if (turnId && params.turn.id !== turnId) return;
            if (params.turn.status !== 'completed') return reject(new Error(friendlyError(params.turn.error || params.turn.status)));
            const messages = (params.turn.items || []).filter(item => item.type === 'agentMessage');
            resolve(messages.at(-1)?.text || finalText);
          }
        };
        disconnected = () => reject(new Error('ChatGPT 连接已断开，请重试'));
        this.client.on('notification', listener); this.client.once('disconnected', disconnected);
        timer = setTimeout(() => {
          if (turnId) this.client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
          else this.client.stop();
          reject(new Error('分析超时，请稍后重试'));
        }, this.turnTimeout);
      });
      completion.catch(() => {});
      const turn = await this.client.request('turn/start', { threadId, input: [{ type: 'text', text: input }], outputSchema: schema, environments: [] });
      turnId = turn.turn.id; this.active = { threadId, turnId };
      const output = await completion;
      try { return JSON.parse(output); } catch { throw new Error('模型返回的结果格式不正确，请重新分析'); }
    } finally {
      clearTimeout(timer);
      if (listener) this.client.removeListener('notification', listener);
      if (disconnected) this.client.removeListener('disconnected', disconnected);
      if (threadId) this.client.request('thread/unsubscribe', { threadId }).catch(() => {});
      this.active = null; this.busy = false;
    }
  }
  stop() { clearTimeout(this.loginTimer); this.client.stop(); }
}
module.exports = { CodexClient, ChatGPTService, findCodex, loginUrl, friendlyError };
