// Test support only; never embedded in review.html. Uses installed Chromium.
import { readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(30); }
  throw new Error('Timed out: ' + label);
}
async function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const root of ['/opt/ms-playwright', join(process.env.HOME || '', '.cache/ms-playwright')]) {
    for (const name of await readdir(root).catch(() => [])) {
      if (name.startsWith('chromium-')) for (const platform of ['chrome-linux-arm64', 'chrome-linux64', 'chrome-linux']) candidates.push(join(root, name, platform, 'chrome'));
    }
  }
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  throw new Error('No installed Chromium found. Set CHROMIUM_PATH; no packages or browsers will be installed.');
}
class CDP {
  constructor(ws, sessionId) {
    this.ws = ws; this.sessionId = sessionId; this.pending = new Map(); this.listeners = new Map();
    this.receive = event => {
      const message = JSON.parse(event.data);
      if (message.sessionId !== this.sessionId) return;
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
      } else for (const listener of this.listeners.get(message.method) || []) listener(message.params);
    };
    ws.addEventListener('message', this.receive);
  }
  session(sessionId) { return new CDP(this.ws, sessionId); }
  static async open(url) {
    const ws = new WebSocket(url); await once(ws, 'open'); return new CDP(ws);
  }
  on(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
  send(method, params = {}) {
    const id = this.ws.nextCommandId = (this.ws.nextCommandId || 0) + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params, ...(this.sessionId ? { sessionId: this.sessionId } : {}) }));
    });
  }
  close() { this.ws.removeEventListener('message', this.receive); if (!this.sessionId) this.ws.close(); }
}


export { CDP, chromiumPath, until, delay };
