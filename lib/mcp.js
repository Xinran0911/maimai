'use strict';
/* mcp.js — 麦当劳 MCP 只读客户端（服务端专用）。
 * token：环境变量 MCD_MCP_TOKEN，或 MCD_MCP_TOKEN_FILE 指向的文件；只在内存里用，不打印、不下发前端、不写日志。
 * 白名单：只允许只读 tool；绝不调用 create-order / cancel-order / mall-create-order 等会真实下单/扣款的接口。 */
const fs = require('fs');
const URL_ = process.env.MCD_MCP_URL || 'https://mcp.mcd.cn';
const TOKEN_FILE = process.env.MCD_MCP_TOKEN_FILE || '';
const ALLOWED = new Set(['list-nutrition-foods', 'calculate-price', 'query-store-coupons', 'available-coupons', 'query-nearby-stores', 'now-time-info', 'campaign-calendar']);
let _tok;
function token() {
  if (_tok !== undefined) return _tok;
  _tok = (process.env.MCD_MCP_TOKEN || '').trim();
  if (!_tok) { try { _tok = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) { _tok = ''; } }
  return _tok;
}
let rid = 1000;
async function post(payload, timeoutMs) {
  const t = token(); if (!t) throw new Error('mcp: no token');
  const r = await fetch(URL_, { method: 'POST', signal: AbortSignal.timeout(timeoutMs || 4000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + t }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error('mcp http ' + r.status);
  let body = await r.text();
  if ((r.headers.get('content-type') || '').includes('event-stream')) { const l = body.split('\n').find(x => x.startsWith('data:')); body = l ? l.slice(5).trim() : ''; }
  return body.trim() ? JSON.parse(body) : {};
}
/* 返回 {ok, data, msg}；data 为 MCP 响应里的 data 字段 */
async function call(tool, args, timeoutMs) {
  if (!ALLOWED.has(tool)) throw new Error('blocked tool: ' + tool);
  const r = await post({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name: tool, arguments: args || {} } }, timeoutMs);
  const res = r.result || {};
  let sc = res.structuredContent;
  if (sc == null) { try { sc = JSON.parse(res.content[0].text.split('## Original Response').pop().trim()); } catch (_) { sc = null; } }
  if (!sc) throw new Error('mcp: bad response');
  return { ok: !!sc.success, data: sc.data, msg: sc.message, code: sc.code };
}
module.exports = { call, available: () => !!token() };
