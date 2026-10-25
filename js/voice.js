/* voice.js — 按住说话（微信式）：首页黄色「按住说，帮我点」+ 对话页底部「按住说话」共用一个全屏遮罩。
 *   按下 → 遮罩 + 收音气泡(波形/计时) + 真·语音识别开始（Web Speech API，interim 文本实时显示在遮罩里）
 *   上滑超过阈值 → 红色“松开手指，取消发送”，放弃识别；滑回来恢复
 *   松手 → 发送：stop 识别 → 把结果交给 Mai.chat.handleVoice（进入/留在对话页）
 *   识别不可用时遮罩里提示“语音识别不可用”，松手后对话页给出「打字输入 + 示例快捷语」 */
(function () {
  'use strict';
  var Mai = (window.Mai = window.Mai || {});
  var CFG = window.MAIMAI_CONFIG.voice;
  var $ = function (id) { return document.getElementById(id); };
  var HINT_HOME = '比如：今天健身了，来点高蛋白的';

  function init() {
    var layer = $('voiceLayer'), wave = $('vWave'), timer = $('vTimer'), tr = $('vTr'), tr2 = $('vTr2');
    var H = [10, 35, 45, 36, 18, 15, 16, 11, 16, 10, 27, 42, 41, 22, 24, 43, 43, 27, 10, 18, 14, 13, 14, 18, 35, 43, 33, 12];
    wave.innerHTML = H.map(function (h, i) { return '<i style="--h:' + h + 'px;--d:' + ((i * 83) % 700) + 'ms;height:' + h + 'px"></i>'; }).join('');

    var st = null, tmr = null, api = { state: 'idle', hint: HINT_HOME };

    function hint() { return (Mai.chat && Mai.chat.voiceHint && Mai.chat.voiceHint()) || HINT_HOME; }
    function idleSub(sup) { return sup.ok ? hint() : '语音识别不可用，松手后可改用打字输入'; }
    function setMode(cancel) {
      layer.classList.toggle('cancel', cancel);
      tr2.textContent = cancel ? '将不会发送' : idleSub(Mai.speech.support());
      $('vXLabel').textContent = cancel ? '松开手指，取消发送' : '↑ 上滑取消';
      api.state = cancel ? 'cancel' : 'hold';
    }
    function show() {
      layer.classList.add('on'); layer.setAttribute('aria-hidden', 'false');
      st.btn.classList.add('pressing'); setMode(false);
      tr.textContent = ''; tr.classList.remove('has');
      var t0 = st.t0;
      timer.textContent = '麦麦正在听… 0:00';
      tmr = setInterval(function () {
        var s = Math.floor((performance.now() - t0) / 1000);
        timer.textContent = '麦麦正在听… ' + Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
      }, 250);
      // 真识别：按下就开始
      st.sess = Mai.speech.start(function (text) {
        if (!st) return;
        tr.textContent = text; tr.classList.toggle('has', !!text);
      });
      if (st.sess.error) tr.textContent = '';
    }
    function hide(btn) {
      clearInterval(tmr);
      layer.classList.remove('on', 'cancel'); layer.setAttribute('aria-hidden', 'true');
      if (btn) btn.classList.remove('pressing'); api.state = 'idle';
    }

    function bind(btn, source) {
      btn.addEventListener('pointerdown', function (e) {
        if (st || e.button > 0) return;
        e.preventDefault();
        try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        st = { id: e.pointerId, y0: e.clientY, t0: performance.now(), cancel: false, btn: btn, src: source };
        show();
      });
      btn.addEventListener('pointermove', function (e) {
        if (!st || e.pointerId !== st.id) return;
        var dy = (st.y0 - e.clientY) / Mai.ui.scale();
        var cancel = dy > CFG.cancelDistance;
        if (cancel !== st.cancel) { st.cancel = cancel; setMode(cancel); }
      });
      function release(e, forceCancel) {
        if (!st || (e && e.pointerId !== st.id)) return;
        var s = st; st = null;
        try { btn.releasePointerCapture(s.id); } catch (_) {}
        var held = performance.now() - s.t0;
        hide(btn);
        if (forceCancel || s.cancel) { s.sess && s.sess.abort(); Mai.ui.toast('已取消发送'); return; }
        if (held < CFG.minHoldMs) { s.sess && s.sess.abort(); Mai.ui.toast('说话时间太短，请按住说话'); return; }
        if (s.sess.error) { Mai.chat.handleVoice({ text: '', error: s.sess.error }, s.src); return; }
        Mai.ui.toast('识别中…', 1200);
        s.sess.finish().then(function (res) { Mai.chat.handleVoice(res, s.src); });
      }
      btn.addEventListener('pointerup', function (e) { release(e, false); });
      btn.addEventListener('pointercancel', function (e) { release(e, true); });
      // 键盘：按住空格 = 按住说话（桌面预览/无障碍）
      btn.addEventListener('keydown', function (e) {
        if ((e.key === ' ' || e.key === 'Enter') && !st && !e.repeat) {
          e.preventDefault(); st = { id: -1, y0: 0, t0: performance.now(), cancel: false, btn: btn, src: source }; show();
        }
      });
      btn.addEventListener('keyup', function (e) {
        if ((e.key === ' ' || e.key === 'Enter') && st && st.id === -1) release(null, false);
      });
    }
    bind($('voiceBtn'), 'home');
    bind($('chatVoiceBtn'), 'chat');
    Mai.voice = api;
  }
  Mai.voiceInit = init;
})();
