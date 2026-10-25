#!/usr/bin/env node
'use strict';
/* server.js — 麦麦：零依赖 Node 服务（内置 http + fetch）
 *   · 静态托管本目录（index.html / js / css / data / assets）
 *   · POST /api/agent  {messages:[{role,content}], context:{card,cart,last}}  → 点餐 Agent（DeepSeek function calling + 麦当劳 MCP 只读工具）
 *       加 ?stream=1 时返回 NDJSON：先若干 {"type":"status","text":…}，最后一行 {"type":"result",…}
 *   · GET  /api/health → {llm:boolean, mcp:boolean}（只告诉有没有配置，不返回任何密钥）
 * 启动：DEEPSEEK_API_KEY=… node server.js        （PORT 默认 18090）
 * 没有 key / 离线 / 出错：/api/agent 返回 {ok:false}（HTTP 200），前端自动退回本地规则解析。
 * 密钥只从环境变量（或 MCP token 文件）读取，不写日志、不下发前端。 */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = __dirname, PORT = +process.env.PORT || 18090;
const agent = require('./lib/agent'), tools = require('./lib/tools'), mcp = require('./lib/mcp');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };
const HIDDEN = /^\/(lib|tests|tools|shots|node_modules|server\.js|serve\.sh|README\.md)(\/|$)|\/\./;

/* 简单限流：每 IP 每分钟 30 次 */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60e3);
  a.push(now); hits.set(ip, a); if (hits.size > 500) hits.clear();
  return a.length > 30;
}
function readBody(req, max) {
  return new Promise((res, rej) => { let n = 0; const ch = []; req.on('data', c => { n += c.length; if (n > max) { rej(new Error('too_large')); req.destroy(); } else ch.push(c); }); req.on('end', () => res(Buffer.concat(ch).toString('utf8'))); req.on('error', rej); });
}
function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); }

async function handleAgent(req, res, url) {
  const stream = url.searchParams.get('stream') === '1';
  let input;
  try { input = JSON.parse(await readBody(req, 64 * 1024)); } catch (_) { return json(res, 200, { ok: false, reason: 'bad_json' }); }
  const ip = req.socket.remoteAddress || '?';
  if (limited(ip)) return json(res, 200, { ok: false, reason: 'rate_limited' });
  if (!process.env.DEEPSEEK_API_KEY) return json(res, 200, { ok: false, reason: 'no_key' });
  if (stream) { res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }); }
  const send = o => { if (stream && !res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
  let out;
  try { out = await agent.run(input, text => send({ type: 'status', text })); }
  catch (e) { out = { ok: false, reason: 'server_error' }; }
  if (stream) { send(Object.assign({ type: 'result' }, out)); res.end(); } else json(res, 200, out);
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  if (HIDDEN.test(p) || p.includes('..')) { res.writeHead(404); return res.end('not found'); }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) { res.writeHead(404); return res.end('not found'); }
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/agent' && req.method === 'POST') return void handleAgent(req, res, url);
  if (url.pathname === '/api/health') return json(res, 200, { llm: !!process.env.DEEPSEEK_API_KEY, mcp: mcp.available() });
  if (url.pathname.startsWith('/api/')) return json(res, 404, { ok: false });
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
});
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log('麦麦 server: http://localhost:' + PORT + '/  · LLM ' + (process.env.DEEPSEEK_API_KEY ? 'on' : 'off（无 DEEPSEEK_API_KEY → 自动用规则解析）') + ' · MCP ' + (mcp.available() ? 'on' : 'off（用缓存数据）'));
  tools.nutList().catch(() => {});          // 预热营养数据（MCP），之后查询免等待
});
