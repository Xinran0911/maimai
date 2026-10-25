/* data.js — 把真实菜单 + 推荐算法变成首页要渲染的“卡片视图模型”
 * 依赖：window.MEALS（data/meals.js，真实菜单 1450127）、window.MaiRec（js/recommend.js） */
(function () {
  'use strict';
  var Mai = (window.Mai = window.Mai || {});
  var CFG = window.MAIMAI_CONFIG;

  var KIND_LABEL = { combo: '套餐', main: '主食', share: '分享装', side: '小食', dessert: '甜品', drink: '饮品' };

  function money(n) { // 24 → "24"；9.95 → "9.95"；11.9 → "11.9"
    return String(Math.round(n * 100) / 100);
  }
  function imgLocal(url) { return 'assets/img/' + url.split('/').pop(); } // 菜品图已下载到本地 assets/img

  function nowCtx() { return CFG.USE_REAL_NOW ? new Date() : CFG.DEMO_NOW; }

  /* 算法结果 r（MaiRec.createDeck 的一张） → 卡片视图模型 */
  function toCard(r, rail) {
    var it = r.item, hasCoupon = !!r.coupon;
    var limited = !hasCoupon && it.originalPrice > it.currentPrice + 0.01; // 菜单“原价→现价”特价
    var price = r.price;
    var was = hasCoupon ? r.listPrice : (limited ? it.originalPrice : null);
    var tags = (it.tags || []).filter(function (t) { return t !== '上新' && t !== '回归'; });
    var chip = null, deal = null;
    if (hasCoupon) {
      chip = '券后¥' + money(price);
      deal = { type: 'coupon', text: r.coupon };
    } else if (limited) {
      chip = '特价¥' + money(it.currentPrice);
      deal = { type: 'limited', text: '限时特价 · 立省¥' + money(it.originalPrice - it.currentPrice) };
    }
    return {
      code: it.code,
      name: it.name,
      kind: it.kind,
      img: imgLocal(it.image),
      imgRemote: it.image,
      rail: rail,                          // 'new' 新品序 / 'hot' 爆品序（卡角淡淡的「新」「热」）
      price: price,
      priceText: money(price),
      priceLabel: hasCoupon ? '券后¥' : '¥',
      was: was != null ? '¥' + money(was) : null,
      chip: chip,
      deal: deal,
      sub: [KIND_LABEL[it.kind] || ''].concat(tags.slice(0, 2)).filter(Boolean).join(' · '),
      taste: it.taste || [],
      reason: r.reason,
      score: r.score
    };
  }

  /* 建牌堆：左滑 = 新品序、右滑 = 爆品序（见 MaiRec.CONFIG.deck.swipe），已去重且左右序互斥 */
  function build() {
    var items = window.MEALS.items;
    var deck = MaiRec.createDeck(items, { now: nowCtx() });
    var railOf = {};
    ['new', 'hot'].forEach(function (m) { deck.lists[m].forEach(function (r) { railOf[r.code] = m; }); });
    var seq = {
      left: deck.lists[deck.sides.left].map(function (r) { return toCard(r, railOf[r.code]); }),
      right: deck.lists[deck.sides.right].map(function (r) { return toCard(r, railOf[r.code]); })
    };
    return { deck: deck, seq: seq, sides: deck.sides };
  }

  Mai.data = { build: build, toCard: toCard, money: money };
})();
