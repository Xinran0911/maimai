/* chat.js — 对话页：消息流（用户气泡 / agent 气泡 / 餐卡），语音与打字两种输入，连续多轮（推荐 → 改单 → 再推荐）
 *  入口：Mai.chat.handleVoice(res, src) ← voice.js 松手后；Mai.chat.submit(text, opts) ← 打字 / 快捷语 / 标签按钮。
 *  识别不可用 → 降级：agent 说明原因 + 「打字输入」框 + 3 条示例快捷语（点一条 = 当作识别结果）。
 *  只有最新的一张餐卡可交互；有新一轮回复时，上一张餐卡收成一行灰色摘要（对应 Figma 07f）。 */
(function () {
  'use strict';
  var Mai = (window.Mai = window.Mai || {});
  var CFG = window.MAIMAI_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var S = Mai.sets, money = S.money;
  var EXAMPLES = ['我今天健身了，来点高蛋白的', '昨天吃得油腻，今天想清淡点', '3个人预算100'];
  var HINT_FIRST = '比如「来点高蛋白的」';
  var HINT_EDIT = '比如「换成可乐」';
  var ICON_MIC = '<svg class="umic" width="14" height="14" viewBox="0 0 24 24" fill="#2B1B12"><rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 11a7 7 0 0014 0" stroke="#2B1B12" stroke-width="2" fill="none"/><rect x="11" y="18" width="2" height="4"/></svg>';

  var el = {}, st = { open: false, active: null, last: null, q: Promise.resolve(), turns: 0, typing: false, hist: [] };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function remember(role, text) { text = String(text || '').replace(/\s+/g, ' ').trim(); if (!text) return; st.hist.push({ role: role, content: text.slice(0, 200) }); if (st.hist.length > 12) st.hist.splice(0, st.hist.length - 12); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function rich(s) { return esc(s).replace(/「([^」]+)」/g, '<b class="k">「$1」</b>'); }

  /* ── 视图开关 ── */
  function open() {
    if (st.open) return;
    st.open = true;
    document.body.classList.add('in-chat');
    el.chat.classList.add('on'); el.chat.setAttribute('aria-hidden', 'false');
    scrollEnd();
  }
  function close() {
    if (!st.open) return;
    st.open = false;
    document.body.classList.remove('in-chat');
    el.chat.classList.remove('on'); el.chat.setAttribute('aria-hidden', 'true');
    el.input.blur();
  }
  function scrollTurn(turn, later) {      // 卡能放下就贴底；放不下（多人大套餐）就把这一轮的开头（气泡+标题）放到顶部
    function go() {
      var t = turn.el, h = t.offsetHeight + 12;
      if (h <= el.scroll.clientHeight) el.scroll.scrollTop = el.scroll.scrollHeight;
      else el.scroll.scrollTop = t.offsetTop - 10;
    }
    go(); if (later) setTimeout(go, later);
  }
  function scrollEnd(later) {
    function go() { el.scroll.scrollTop = el.scroll.scrollHeight; }
    go(); if (later) setTimeout(go, later);
  }
  function setTyping(on, focus) {
    st.typing = on;
    el.chat.classList.toggle('typing', on);
    el.kb.setAttribute('aria-label', on ? '切换为按住说话' : '切换为键盘输入');
    if (on && focus !== false) setTimeout(function () { try { el.input.focus({ preventScroll: true }); } catch (_) { el.input.focus(); } }, 30);
  }
  function setHint() { el.hint.textContent = st.active ? HINT_EDIT : HINT_FIRST; }
  function voiceHint() { return st.active ? HINT_EDIT : HINT_FIRST; }

  /* ── 消息 DOM ── */
  function addUser(text, src) {
    var d = document.createElement('div'); d.className = 'msg user';
    d.innerHTML = '<div class="ub">' + (src === 'voice' ? ICON_MIC : '') + '<span></span></div>';
    d.querySelector('span').textContent = text;
    el.list.appendChild(d); scrollEnd(); return d;
  }
  function agentRow(inner) {
    var d = document.createElement('div'); d.className = 'msg agent turn';
    d.innerHTML = '<img class="av" alt="麦麦" draggable="false" src="' + esc(CFG.avatar.src || '') + '"><div class="mcol"><div class="mbt"></div></div>';
    d.querySelector('.mbt').innerHTML = inner;
    return d;
  }
  /* 一轮 agent 回复：气泡 + （可选）chips + （可选）餐卡槽 */
  function addAgent(html, o) {
    o = o || {};
    var row = agentRow(html), col = row.querySelector('.mcol');
    if (o.chips && o.chips.length) {
      var cs = document.createElement('div'); cs.className = 'cchips' + (o.fb ? ' fb' : '');
      o.chips.forEach(function (c) {
        var label = typeof c === 'string' ? c : c.label, text = typeof c === 'string' ? (Mai.intent.CHIP_TEXT[c] || c) : c.text;
        var b = document.createElement('button'); b.type = 'button'; b.className = o.fb ? 'cchip fbchip' : 'cchip'; b.textContent = label;
        b.addEventListener('click', function () {
          if (cs.classList.contains('used')) return;
          cs.classList.add('used');
          submit(text, { src: o.fb ? 'voice' : 'chip', display: o.fb ? text : label });
        });
        cs.appendChild(b);
      });
      col.appendChild(cs);
    }
    var turn = { el: row, bubble: row.querySelector('.mbt'), host: null, stack: null, lead: o.lead || '', fixed: !!o.fixed };
    if (o.host) { row.appendChild(o.host); turn.host = o.host; }
    el.list.appendChild(row); scrollEnd();
    return turn;
  }
  function typingDots() {
    var STEPS = ['麦麦在翻今天的菜单…', '在算价格和优惠…', '在帮你搭配…'], i = 0;
    var d = agentRow('<span class="think"><span class="dots3"><i></i><i></i><i></i></span><span class="tt">' + STEPS[0] + '</span></span>'); d.classList.add('typing-row');
    el.list.appendChild(d); scrollEnd();
    var tt = d.querySelector('.tt');
    var iv = setInterval(function () { i = (i + 1) % STEPS.length; if (tt) { tt.classList.remove('sw'); void tt.offsetWidth; tt.textContent = STEPS[i]; tt.classList.add('sw'); } }, 900);
    var off = function () { clearInterval(iv); d.remove(); };
    off.setText = function (t) { if (!tt || !t) return; clearInterval(iv); tt.classList.remove('sw'); void tt.offsetWidth; tt.textContent = t; tt.classList.add('sw'); };
    return off;
  }
  function clearChips() { el.list.querySelectorAll('.cchips').forEach(function (c) { c.classList.add('used'); }); }

  /* ── 文案：懂你的导购，口语，最多两句 ── */
  function summaryOf(set) { return '已推荐「' + set.title + '」¥' + money(set.total) + (set.pill ? ' · ' + set.pill.text : ''); }
  function leadFor(P, I, f) {
    var tags = I.tags || [], sx = I.state || {};
    if (I.people > 1 || I.budget) return '收到！' + (I.people > 1 ? I.people + '人' : '') + (I.people > 1 && I.budget ? '，' : '') + (I.budget ? '预算¥' + I.budget : '') + '～';
    if (P.refine) {
      var bits = []; if (f.like) bits.push({ chicken: '鸡肉', beef: '牛肉', fish: '鱼虾' }[f.like] + '安排上'); if (f.noSpicy) bits.push('都挑了不辣的'); if (f.cheaper) bits.push('帮你省着点');
      return '好嘞，' + (bits.join('，') || '按你说的调了一下') + '～';
    }
    if (sx.workout) return '练完辛苦啦！';
    if (sx.greasy) return '昨天吃太油，今天就清爽点～';
    if (f.meal === 'breakfast') return '这会儿已过早餐时段，先按清淡的给你配～';
    var b2 = []; if (f.like) b2.push({ chicken: '鸡肉', beef: '牛肉', fish: '鱼虾' }[f.like] + '安排上'); if (f.noSpicy) b2.push('都挑了不辣的'); if (f.cheaper) b2.push('帮你省着点');
    if (b2.length) return b2.join('，') + '～';
    if (tags.indexOf('顶饱') >= 0) return '想吃饱是吧？';
    if (tags.indexOf('提神') >= 0) return '来点提神的～';
    return '好的～';
  }
  function pitchFor(set, I) {
    var est = set.est ? '约' : '', m = S.mainRow(set);
    var others = set.rows.filter(function (r) { return r !== m && r.cat !== 'main'; });
    if (set.people > 1 || set.budget) {
      var mains = set.rows.filter(function (r) { return r.cat === 'main'; }).reduce(function (n, r) { return n + r.qty; }, 0);
      return set.people + '人份配好了，' + mains + '个主食加配餐，共¥' + money(set.total) + (set.budget ? '，没超预算' : '') + (set.saved > 0.05 ? '，用券/特价省了¥' + money(set.saved) : '') + '。';
    }
    var tags = I.tags || [];
    if (tags.indexOf('高蛋白') >= 0) {
      var comp = others.filter(function (r) { return r.nut.protein >= 4; })[0];
      return '「' + m.short + '」打底' + (others.length ? '，再来' + others.map(function (r) { return r.short; }).join('和') : '') + (I.state && I.state.workout ? '，练后一餐刚好。' : '，吃得扎实。');
    }
    if (tags.indexOf('清淡') >= 0) {
      var sd = others.filter(function (r) { return r.cat === 'side'; })[0];
      return '「' + m.short + '」打底，脂肪才' + est + set.fat + 'g' + (sd ? '，配' + sd.short + '解腻' : '') + '。';
    }
    return '「' + m.short + '」' + (others.length ? '配' + others.map(function (r) { return r.short; }).join('+') : '') + '，' + est + set.kcal + 'kcal' + (set.saved > 0.05 ? '，还省了¥' + money(set.saved) : '') + '。';
  }
  function textFor(turn, set) { return (turn.lead ? turn.lead : '') + pitchFor(set, turn.I); }
  function setBubble(turn, text) {
    var b = turn.bubble; b.classList.add('swap');
    setTimeout(function () { b.innerHTML = rich(text); b.classList.remove('swap'); }, 120);
  }

  /* ── 卡片回调 ── */
  function onAdd(set, btn) {
    Mai.cart.addSet(set);
    Mai.ui.toast('已加入购物车', 1600);
    Mai.ui.flyToCart(btn, 'chatCartBtn');
    btn.classList.add('done');
    clearTimeout(btn._t);
    btn._t = setTimeout(function () { btn.classList.remove('done'); }, 2000);
  }
  /* 去结算：这一套加入购物车，并且只勾选这一套，直接进结算页 */
  function onGo(set) {
    var e = Mai.cart.addSet(set);
    Mai.cart.setAll(false); Mai.cart.setGroupSel(e.id, true);
    Mai.shop.openCheckout();
  }
  function collapse(turn, text) {
    if (!turn) return;
    if (turn.host && turn.host.parentNode === turn.el) turn.host.remove();
    var old = turn.el.querySelector('.cchips'); if (old) old.remove();
    turn.bubble.textContent = text; turn.bubble.classList.add('sum');
    turn.stack = null; turn.host = null; turn.collapsed = true;
  }
  function makeStack(turn, build) {
    var host = document.createElement('div');
    turn.el.appendChild(host); turn.host = host;
    var hotFirst = build.hot[0];
    var center = hotFirst || build.new[0];
    var holder = { turn: turn };
    var opts = {
      center: center, hot: [], new: [],
      onAdd: onAdd,
      onGo: onGo,
      onFlip: function (set) { var t = holder.turn; if (t && t.stack) setBubble(t, textFor(t, set)); }
    };
    opts.hot = hotFirst ? build.hot.slice(1) : [];
    opts.new = hotFirst ? build.new.slice() : build.new.slice(1);
    turn.stack = new Mai.Stack(host, opts);
    turn.stack._holder = holder; turn.I = build.I; turn.flags = build.flags;
    return center;
  }

  /* ── 回复流程 ── */
  function agentSay(text, chips, o) { remember('assistant', text); var t = addAgent(rich(text), Object.assign({ chips: chips }, o || {})); return t; }

  function doRecommend(P, reply) {
    var build = S.build(P);
    if (!build.hot.length && !build.new.length) {
      agentSay('这个条件下菜单里没找到合适的搭配，换个说法试试？比如想吃饱一点还是清淡一点？', ['吃得饱一点', '清淡一点', '高蛋白']);
      return;
    }
    var prev = st.active;
    var turn = addAgent('', { lead: '' });
    var center = makeStack(turn, build);
    if (reply) { turn.lead = ''; turn.bubble.innerHTML = rich(reply); remember('assistant', reply); }
    else { turn.lead = leadFor(P, build.I, build.flags); turn.bubble.innerHTML = rich(textFor(turn, center)); remember('assistant', textFor(turn, center)); }
    if (prev) collapse(prev, summaryOf(prev.stack.center()));
    st.active = turn; st.last = { mi: P.mi, flags: P.flags };
    st.turns++; setHint(); scrollTurn(turn, 450);
  }

  function doEdit(P, reply) {
    var prev = st.active, set = prev.stack.center(), e = P.edit;
    if (e.unknown) {
      agentSay('店里没有「' + e.unknown + '」哦，饮料可以换成可乐、纯悦、奶铁、美式～', ['换成可乐', '换成纯悦', '换成美式']);
      return;
    }
    var before = summaryOf(set);
    var res = S.applyEdit(set, e, prev.I, prev.flags);
    if (!res.ok) {
      var cn = S.CAT_CN[res.cat] || '这一项';
      var have = [];
      ['drink', 'side', 'main'].forEach(function (c) { if (set.rows.some(function (r) { return r.cat === c; })) have.push({ label: '只换' + S.CAT_CN[c], text: '只换' + S.CAT_CN[c] }); });
      if (res.why === 'nocat') agentSay('这套里没有' + cn + '，想换哪一样？', have);
      else if (res.why === 'same') agentSay('「' + (res.name || cn) + '」已经在这套里啦，想换成别的吗？', have);
      else if (res.why === 'budget') agentSay((res.name ? '换成「' + res.name + '」' : '再换') + '会超出预算，换个便宜点的？', [{ label: '换个便宜点的' + cn, text: '换个便宜点的' + cn }]);
      else agentSay('这一项暂时没有更合适的可换了，换个别的吧？', have);
      return;
    }
    var nt = addAgent('', { fixed: true, host: prev.host, lead: '' });
    nt.stack = prev.stack; nt.stack._holder.turn = nt; nt.I = prev.I; nt.flags = prev.flags;
    prev.host = null; prev.stack = null;
    collapse(prev, before);
    var d = res.delta;
    var etext = reply || ('好的，只换' + S.CAT_CN[e.cat] + '：' + res.from.short + ' → ' + res.to.short + '，其他不动～');
    nt.bubble.innerHTML = rich(etext); remember('assistant', etext);
    nt.stack.refresh(set, { row: res.row, delta: d });
    st.active = nt; st.turns++; scrollTurn(nt, 450);
  }

  function respondRule(text, o) {
    Mai.agent && Mai.agent.mark('rule');
    var P = Mai.intent.parse(text, { hasStack: !!(st.active && st.active.stack), last: st.last });
    /* 导航口令：去结算 / 买单 / 看购物车 */
    if (/结算|结账|买单|付款|支付|下单/.test(text) && Mai.shop) { agentSay('好，带你去结算～'); setTimeout(function () { Mai.shop.openCheckout(); }, 500); return; }
    if (/购物车/.test(text) && Mai.shop) { agentSay('好，打开购物车～'); setTimeout(function () { Mai.shop.openCart(); }, 500); return; }
    if (P.kind === 'empty') { agentSay('没听清，能再说一遍吗？也可以点键盘直接打字～'); return; }
    if (P.kind === 'clarify') { agentSay(P.text, P.chips); return; }
    if (P.kind === 'edit') return doEdit(P);
    return doRecommend(P);
  }


  /* ── 大模型 Agent：上下文 / 结果落地 / UI 动作 ── */
  function centerSet() { return st.active && st.active.stack ? st.active.stack.center() : null; }
  function agentContext() {
    var ctx = { card: null, cart: { count: Mai.cart.count(), total: Mai.cart.total(), entries: Mai.cart.entries().map(function (e) { return { rows: e.rows.map(function (r) { return { code: r.code, qty: r.qty }; }) }; }) }, last: st.last || null };
    var cs = centerSet();
    if (cs && st.last) ctx.card = { rows: cs.rows.map(function (r) { return { code: r.code, qty: r.qty }; }), intent: { mi: st.last.mi, flags: st.last.flags } };
    return ctx;
  }
  function runActions(actions) {
    var acts = actions || [], hasAdd = acts.some(function (a) { return a.type === 'add_cart'; }), hasCo = acts.some(function (a) { return a.type === 'open_checkout'; });
    var cs = centerSet();
    setTimeout(function () {
      if (hasAdd && hasCo && cs) { onGo(cs); return; }               // 「去结算」= 这一套加购并只勾选这一套（与餐卡上的「去结算」一致）；支付仍是假支付，由用户在结算页自己点
      acts.forEach(function (a) {
        if (a.type === 'add_cart' && cs) { Mai.cart.addSet(cs); Mai.ui.toast('已加入购物车', 1600); }
        else if (a.type === 'open_cart') Mai.shop.openCart();
        else if (a.type === 'open_checkout') Mai.shop.openCheckout();
        else if (a.type === 'next_card' && st.active && st.active.stack) st.active.stack.go('right');
      });
    }, 700);
  }
  function respondAgent(res, text) {
    Mai.agent.mark('llm');
    var c = res.card, reply = res.reply || '';
    if (c && c.kind === 'recommend' && c.intent) {
      doRecommend({ kind: 'recommend', mi: c.intent.mi, flags: c.intent.flags || {}, refine: !!c.intent.refine, text: text }, reply);
    } else if (c && c.kind === 'edit' && centerSet()) {
      var P = Mai.intent.fromAgentEdit(c.edit);
      if (P) doEdit(P, reply); else if (reply) agentSay(reply);
    } else if (reply) agentSay(reply);
    if (res.actions && res.actions.length) runActions(res.actions);
  }
  function respond(text, o) { respondRule(text, o); }

  /* 提交一句话（语音识别结果 / 打字 / 快捷语 / 标签按钮）。串行处理，避免两轮交叠。 */
  function submit(text, o) {
    o = o || {};
    var t = String(text || '').trim();
    if (t.length < 2) { shake(); Mai.ui.toast('多说几个字吧，比如「来点高蛋白的」', 1800); return Promise.resolve(false); }
    open(); clearChips();
    addUser(o.display || t, o.src);
    remember('user', t);
    st.q = st.q.then(function () {
      var off = typingDots(), t0 = Date.now();
      if (!Mai.agent || !Mai.agent.enabled()) return delay(1800).then(function () { off(); respond(t, o); });
      /* 大模型：「想一想」一直到服务端返回（至少 1.2s，上限由 agent.js 的超时控制）；失败/超时 → 补足到 1.8s 后走规则解析，用户无感知 */
      return Mai.agent.ask(st.hist.slice(), agentContext(), off.setText).then(function (res) {
        var min = res ? 1200 : 1800, wait = Math.max(0, min - (Date.now() - t0));
        return delay(wait).then(function () { off(); if (res) respondAgent(res, t); else respond(t, o); });
      });
    });
    return st.q.then(function () { return true; });
  }
  function shake() { el.form.classList.remove('shake'); void el.form.offsetWidth; el.form.classList.add('shake'); }

  /* 识别不可用 → 降级文案 */
  var WHY = {
    unsupported: '这个浏览器不支持语音识别（建议用 Chrome / Edge，并用 localhost 打开）。先打字吧，或者点下面的例子～',
    insecure: '这个页面是本地文件打开的，浏览器不允许用麦克风（用 https 链接打开才能说话）。先点下面的例子或打字吧～',
    denied: '没拿到麦克风权限（可在地址栏左侧允许麦克风后再试）。先点下面的例子，或点左下角键盘图标打字～',
    network: '语音识别要联网才能用，现在连不上识别服务。先点下面的例子，或点左下角键盘图标打字～',
    nomic: '没检测到麦克风。先点下面的例子，或点左下角键盘图标打字～'
  };
  function fallback(reason) {
    open();
    /* 只有浏览器根本没有语音能力（不支持/非安全来源）才自动切到打字；没权限/断网/没麦时仍留在「按住说话」，用户想打字点键盘图标 */
    if (reason === 'unsupported' || reason === 'insecure') setTyping(true);
    st.q = st.q.then(function () { addAgent(esc(WHY[reason] || WHY.unsupported), { chips: EXAMPLES, fb: true }); });
  }

  function handleVoice(res, src) {
    if (res && res.error) { fallback(res.error); return; }
    var t = (res && res.text || '').trim();
    if (t.length < 2) {
      if (!st.open) { Mai.ui.toast('没听清，请再按住说一遍', 1800); return; }
      st.q = st.q.then(function () { addAgent('没听清，再按住说一遍？也可以点键盘直接打字～'); });
      return;
    }
    submit(t, { src: 'voice' });
  }

  function init() {
    el.chat = $('chat'); el.list = $('chatList'); el.scroll = $('chatScroll'); el.kb = $('kbBtn'); el.form = $('typeForm'); el.input = $('typeInput'); el.hint = $('chatVoiceHint');
    $('chatBack').addEventListener('click', close);
    el.kb.addEventListener('click', function () { setTyping(!st.typing); });
    el.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = el.input.value.trim();
      if (v.length < 2) { shake(); Mai.ui.toast('多输几个字吧，比如「来点高蛋白的」', 1800); return; }
      el.input.value = '';
      submit(v, { src: 'typed' });
    });
    el.input.addEventListener('keydown', function (e) { e.stopPropagation(); });
    document.addEventListener('keydown', function (e) {
      if (!st.open || !st.active || !st.active.stack || document.body.classList.contains('in-page')) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key === 'Backspace') { e.preventDefault(); st.active.stack.undo(); }
      else if (e.key === 'ArrowLeft') st.active.stack.go('left');
      else if (e.key === 'ArrowRight') st.active.stack.go('right');
    });
    setHint();
  }

  Mai.chat = { init: init, open: open, close: close, submit: submit, handleVoice: handleVoice, voiceHint: voiceHint, fallback: fallback, state: st, EXAMPLES: EXAMPLES };
})();
