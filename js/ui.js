/* ui.js — 舞台缩放、状态栏时钟、toast、购物车角标、门店胶囊 */
(function () {
  'use strict';
  var Mai = (window.Mai = window.Mai || {});
  var CFG = window.MAIMAI_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var BASE_W = 390, BASE_H = 844;
  var state = { scale: 1, cart: {}, count: 0 };

  /* 画布固定 390×844；真机/窗口小于它时整体等比缩放（保证和设计稿一致），桌面居中显示手机框 */
  function fit() {
    var vw = window.innerWidth, vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    var desktop = vw > 520 && vh > 600;
    document.body.classList.toggle('desktop', desktop);
    var k = desktop ? Math.min(1, (vh - 32) / BASE_H) : Math.min(vw / BASE_W, vh / BASE_H);
    state.scale = k;
    var f = $('frame'), p = $('phone');
    f.style.width = BASE_W * k + 'px';
    f.style.height = BASE_H * k + 'px';
    p.style.transform = 'scale(' + k + ')';
  }

  function tick() {
    var d = new Date(), h = d.getHours(), m = d.getMinutes();
    $('clock').textContent = h + ':' + (m < 10 ? '0' : '') + m;
  }

  var toastTimer;
  function toast(html, ms) {
    var t = $('toast');
    t.innerHTML = html;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 1600);
  }

  /* 购物车：数据在 Mai.cart（localStorage 共享 store），这里只负责角标（首页 + 对话页两个）*/
  function renderBadges(cart) {
    var n = cart.count();
    state.count = n;
    ['cartCount', 'chatCartCount'].forEach(function (id) {
      var el = $(id); if (!el) return;
      var had = !el.hidden && el.textContent;
      el.hidden = n === 0;
      el.textContent = n > 99 ? '99+' : n;
      if (n && String(n) !== had) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    });
  }
  function addToCart(card) {          // 首页单品「加购」
    Mai.cart.addDish(card);
    return state.count;
  }

  /* 加购飞入动画：一颗小圆点从按钮飞到购物车 */
  function flyToCart(fromEl, toId) {
    var to = $(toId || 'cartBtn').getBoundingClientRect(), from = fromEl.getBoundingClientRect();
    var dot = document.createElement('div');
    dot.className = 'fly';
    var sx = from.left + from.width / 2, sy = from.top + from.height / 2;
    var ex = to.left + to.width / 2, ey = to.top + to.height / 2;
    dot.style.left = sx - 9 + 'px'; dot.style.top = sy - 9 + 'px';
    document.body.appendChild(dot);
    var a = dot.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: 'translate(' + (ex - sx) * 0.5 + 'px,' + ((ey - sy) * 0.5 - 40) + 'px) scale(1.1)', opacity: 1, offset: 0.55 },
      { transform: 'translate(' + (ex - sx) + 'px,' + (ey - sy) + 'px) scale(.35)', opacity: 0.2 }
    ], { duration: 520, easing: 'cubic-bezier(.4,.1,.3,1)' });
    a.onfinish = function () { dot.remove(); };
  }

  function initStatic() {
    $('storeName').textContent = CFG.store.shortName;
    if (CFG.avatar && CFG.avatar.src) {
      Array.prototype.forEach.call(document.querySelectorAll('.avatar-slot'), function (slot) {
        slot.classList.add('has');
        slot.style.backgroundImage = 'url("' + CFG.avatar.src + '")';
      });
    }
    $('storeBtn').addEventListener('click', function () {
      toast('当前门店：麦当劳上海陆家嘴明珠环餐厅');
    });
    function cartTap() { if (Mai.shop) Mai.shop.openCart(); }
    $('cartBtn').addEventListener('click', cartTap);
    $('chatCartBtn').addEventListener('click', cartTap);
    Mai.cart.subscribe(renderBadges);
  }

  function init() {
    fit(); tick(); setInterval(tick, 15000);
    window.addEventListener('resize', fit);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);
    initStatic();
    // 不允许橡皮筋/缩放/长按菜单
    document.addEventListener('touchmove', function (e) { if (e.target.closest && e.target.closest('.cscroll')) return; e.preventDefault(); }, { passive: false });
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('dragstart', function (e) { e.preventDefault(); });
  }

  Mai.ui = { init: init, toast: toast, addToCart: addToCart, flyToCart: flyToCart, state: state, scale: function () { return state.scale; } };
})();
