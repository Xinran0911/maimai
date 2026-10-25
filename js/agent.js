/* agent.js — 前端调用点餐 Agent（POST /api/agent，服务端用 DeepSeek function calling + 麦当劳 MCP 只读工具）。
 *  只负责「问」：失败 / 超时 / 没有服务（静态打开、file://）/ ?llm=0 → 返回 null，由 chat.js 退回本地规则解析，用户无感知。
 *  前端不带任何密钥；推荐的价格/营养仍由本地 recommend.js + sets.js 用服务端给的意图重算，大模型不编造数字。
 *  来源记录在 window.Mai.lastIntentSource = 'llm' | 'rule'（console.debug），界面上没有任何可见元素。 */
(function (root) {
  'use strict';
  var Mai = (root.Mai = root.Mai || {});
  var TIMEOUT = 8500;
  var qs = ''; try { qs = root.location.search || ''; } catch (_) {}
  var off = /[?&]llm=0(&|$)/.test(qs);
  var staticMode = false; try { staticMode = root.location.protocol === 'file:'; } catch (_) {}
  var dead = false;                                   // 这个页面会话里发现没有后端 / 没配 key → 之后直接走规则

  function enabled() { return !off && !staticMode && !dead && typeof root.fetch === 'function' && typeof root.AbortController === 'function'; }

  function readNdjson(resp, onStatus) {
    if (!resp.body || !resp.body.getReader) return resp.text().then(function (t) { return lastResult(t.split('\n'), onStatus); });
    var rd = resp.body.getReader(), dec = new TextDecoder('utf-8'), buf = '', result = null;
    function eat(line) { line = line.trim(); if (!line) return; var o; try { o = JSON.parse(line); } catch (_) { return; } if (o.type === 'status') { if (onStatus) onStatus(o.text); } else if (o.type === 'result') result = o; }
    function pump() {
      return rd.read().then(function (r) {
        if (r.done) { eat(buf); return result; }
        buf += dec.decode(r.value, { stream: true });
        var i; while ((i = buf.indexOf('\n')) >= 0) { eat(buf.slice(0, i)); buf = buf.slice(i + 1); }
        return pump();
      });
    }
    return pump();
  }
  function lastResult(lines, onStatus) { var res = null; lines.forEach(function (l) { try { var o = JSON.parse(l); if (o.type === 'status' && onStatus) onStatus(o.text); else if (o.type === 'result') res = o; } catch (_) {} }); return res; }

  /* messages:[{role:'user'|'assistant',content}]，context:{card,cart,last}；返回 Promise<result|null> */
  function ask(messages, context, onStatus) {
    if (!enabled()) return Promise.resolve(null);
    var ctl = new AbortController(), tm = setTimeout(function () { ctl.abort(); }, TIMEOUT);
    return fetch('/api/agent?stream=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: messages, context: context }), signal: ctl.signal })
      .then(function (r) { if (!r.ok) { dead = true; throw new Error('http ' + r.status); } return readNdjson(r, onStatus); })
      .then(function (res) {
        clearTimeout(tm);
        if (res && res.ok && (res.reply || res.card || (res.actions && res.actions.length))) return res;
        if (res && res.reason === 'no_key') dead = true;
        return null;
      })
      .catch(function (e) { clearTimeout(tm); if (!(e && e.name === 'AbortError')) dead = true; return null; });
  }
  function mark(src) { Mai.lastIntentSource = src; try { console.debug('[maimai] intent source:', src); } catch (_) {} }

  Mai.agent = { ask: ask, enabled: enabled, mark: mark };
  Mai.lastIntentSource = null;
})(typeof window !== 'undefined' ? window : globalThis);
