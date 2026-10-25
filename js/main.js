/* main.js — 启动：配置 → 真实数据 + 推荐 → 渲染叠卡 → 语音按钮 → 对话页 */
(function () {
  'use strict';
  var Mai = window.Mai;
  function start() {
    Mai.ui.init();
    var built = Mai.data.build();
    Mai.deck = new Mai.Deck(document.getElementById('deck'), built);
    Mai.built = built;
    Mai.voiceInit();
    Mai.chat.init();
    Mai.shop.init();
    document.body.classList.add('ready');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
