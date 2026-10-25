/* speech.js — 浏览器 Web Speech API（SpeechRecognition / webkitSpeechRecognition）真识别
 *  lang = zh-CN，interimResults = true；按住时 start、松手时 finish（stop + 等最终结果）。
 *  不可用（浏览器不支持 / 非安全来源 / 权限被拒 / 网络错误 / 没有麦克风）时 finish() 返回 {error}，
 *  由 chat.js 降级成「打字输入 + 示例快捷语」。
 *  注意：Chrome 的识别要求 http://localhost 或 https 来源，且需要联网（识别在 Google 服务端完成）。
 *  产品代码里没有任何 mock；测试在 tests/selftest_step2.py 里用 add_init_script 注入假的 SpeechRecognition。 */
(function (root) {
  'use strict';
  var Mai = (root.Mai = root.Mai || {});
  var LANG = 'zh-CN';

  function ctor() { return root.SpeechRecognition || root.webkitSpeechRecognition || null; }
  function support() {
    if (!ctor()) return { ok: false, reason: 'unsupported' };
    if (root.isSecureContext === false || (root.location && root.location.protocol === 'file:')) return { ok: false, reason: 'insecure' };
    return { ok: true, reason: '' };
  }
  var ERR = { 'not-allowed': 'denied', 'service-not-allowed': 'denied', 'network': 'network', 'audio-capture': 'nomic', 'language-not-supported': 'unsupported' };

  /* start(onInterim(text, isFinal)) → session { finish():Promise<{text,error}>, abort(), error }；不可用时 session.error 立即有值 */
  function start(onInterim) {
    var sup = support();
    var S = { text: '', error: sup.ok ? '' : sup.reason, stopping: false, done: false, rec: null, resolve: null, timer: null };
    if (!sup.ok) { return mk(S); }
    var rec;
    try { rec = new (ctor())(); } catch (e) { S.error = 'unsupported'; return mk(S); }
    S.rec = rec;
    rec.lang = LANG; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
    rec.onresult = function (e) {
      var fin = '', interim = '';
      for (var i = 0; i < e.results.length; i++) { var r = e.results[i], t = r[0] ? r[0].transcript : ''; if (r.isFinal) fin += t; else interim += t; }
      S.text = (fin + interim).trim();
      if (onInterim) onInterim(S.text, !interim);
    };
    rec.onerror = function (e) {
      var code = ERR[e && e.error]; if (code && !S.error) S.error = code;     // no-speech / aborted：不算错误，当作没听到
    };
    rec.onend = function () { settle(S); };
    try { rec.start(); } catch (e) { S.error = S.error || 'unsupported'; }
    return mk(S);
  }
  function settle(S) {
    if (S.done) return; S.done = true; clearTimeout(S.timer);
    if (S.resolve) S.resolve({ text: S.text, error: S.text ? '' : S.error });
  }
  function mk(S) {
    return {
      get error() { return S.error; },
      get text() { return S.text; },
      finish: function () {
        return new Promise(function (resolve) {
          S.resolve = resolve;
          if (S.done || !S.rec) { S.done = true; resolve({ text: S.text, error: S.text ? '' : S.error }); return; }
          S.stopping = true;
          try { S.rec.stop(); } catch (_) {}
          S.timer = setTimeout(function () { settle(S); }, 2000);        // 兜底：最多等 2s 的最终结果
        });
      },
      abort: function () { S.done = true; clearTimeout(S.timer); try { S.rec && S.rec.abort(); } catch (_) {} }
    };
  }
  Mai.speech = { support: support, start: start, LANG: LANG };
})(typeof window !== 'undefined' ? window : globalThis);
