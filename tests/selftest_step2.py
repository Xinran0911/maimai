"""步骤 2 自测：python3 tests/selftest_step2.py
 · 用本地 http.server（localhost）打开页面，和真机/浏览器使用方式一致；
 · 语音识别用「假的 SpeechRecognition」驱动 —— mock 只在本测试脚本里通过 add_init_script 注入，产品代码里没有任何 mock 开关；
 · 截图写到 shots/step2-*.png；任何断言失败 → 退出码 1。"""
import asyncio, json, os, re, sys, threading, functools, http.server, socketserver
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = ROOT + '/shots'
os.makedirs(SHOTS, exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/index.html?llm=0'

# ── 假的 Web Speech API（仅测试用）：start 后 120ms 吐一次 interim（前半句），stop 后吐 final 再 end；可预设 error ──
MOCK = """
(()=>{ window.__sp={text:'',error:null,started:0,lang:null,interim:null};
class SR{ constructor(){ window.__sp.inst=this; }
 _emit(t,f){ const r=Object.assign([{transcript:t}],{isFinal:f}); this.onresult&&this.onresult({resultIndex:0,results:[r]}); }
 start(){ const s=window.__sp; s.started++; s.lang=this.lang; s.interim=this.interimResults; this._on=true;
   setTimeout(()=>{ if(!this._on)return;
     if(s.error){ this._on=false; this.onerror&&this.onerror({error:s.error}); this.onend&&this.onend(); return; }
     this._emit(s.text.slice(0,Math.ceil(s.text.length/2)),false); },120); }
 stop(){ if(!this._on)return; this._on=false; const s=window.__sp; setTimeout(()=>{ if(s.text) this._emit(s.text,true); this.onend&&this.onend(); },60); }
 abort(){ this._on=false; this.onend&&this.onend(); } }
window.SpeechRecognition=SR; window.webkitSpeechRecognition=SR; })();
"""
NO_SR = "delete window.SpeechRecognition; delete window.webkitSpeechRecognition;"

errors, fails, R = [], [], {}
def ok(cond, msg):
    if not cond: fails.append(msg); print('  ✗ FAIL:', msg)
    else: print('  ✓', msg)

async def new_page(b, init=MOCK):
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    page = await ctx.new_page()
    page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('requestfailed', lambda r: errors.append(f'requestfailed: {r.url}'))
    await page.add_init_script(init)
    await page.goto(URL); await page.wait_for_selector('body.ready'); await page.wait_for_timeout(400)
    return page

async def hold(page, sel, text=None, ms=900, shot=None, error=None, wait=2300):
    await page.evaluate("([t,e])=>{window.__sp.text=t||'';window.__sp.error=e||null}", [text, error]) if await page.evaluate("!!window.__sp") else None
    bb = await page.locator(sel).bounding_box(); x, y = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2
    await page.mouse.move(x, y); await page.mouse.down(); await page.wait_for_timeout(ms)
    if shot: await page.screenshot(path=f'{SHOTS}/{shot}.png')
    await page.mouse.up(); await page.wait_for_timeout(wait)

def sig(s): return '+'.join(sorted(r['code'] + 'x' + str(r['qty']) for r in s['rows']))
SETS_JS = """()=>{const st=Mai.chat.state.active.stack, h=st.heads();
  const f=s=>s&&({id:s.id,rail:s.rail,title:s.title,total:s.total,was:s.was,saved:s.saved,kcal:s.kcal,protein:s.protein,fat:s.fat,pill:s.pill&&s.pill.text,reason:s.reasonLine,budget:s.budget,people:s.people,
     rows:s.rows.map(r=>({code:r.code,name:r.name,qty:r.qty,sub:r.subtotal,was:r.was,coupon:r.coupon}))});
  return {left:f(h.left),center:f(h.center),right:f(h.right),hot:st.lists.hot.map(f),new:st.lists.new.map(f)}}"""
def dishes(s): return ' + '.join(r['name'] + ('×%d' % r['qty'] if r['qty'] > 1 else '') for r in s['rows'])

async def center_y(page):
    bb = await page.locator('.mc[style*="z-index: 3"]').bounding_box()
    return int(min(max(bb['y'] + 150, 230), 640))
async def drag(page, x0, y0, x1, y1, steps=12, hold_end=False):
    await page.mouse.move(x0, y0); await page.mouse.down()
    for i in range(1, steps + 1):
        await page.mouse.move(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); await page.wait_for_timeout(16)
    if not hold_end: await page.mouse.up()
async def center_id(page): return await page.evaluate("Mai.chat.state.active.stack.center().id")
async def center_rail(page): return await page.evaluate("Mai.chat.state.active.stack.center().rail")

async def scenario(b, name, text, shot):
    print(f'\n== 场景：{name}（{text}）')
    page = await new_page(b)
    await hold(page, '#voiceBtn', text, shot=f'{shot}-0-hold' if shot else None)
    ok(await page.evaluate("document.body.classList.contains('in-chat')"), '松手后进入对话页')
    d = await page.evaluate(SETS_JS)
    await page.screenshot(path=f'{SHOTS}/{shot}.png')
    return page, d

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome')

        # ─────────── a) 首页按住 → 松手进对话；真识别参数；标题与头像 ───────────
        print('\n== a) 首页按住说话 → 对话页')
        page = await new_page(b)
        ok((await page.inner_text('h1.brand-name')) == '麦麦帮你点', '首页标题=麦麦帮你点')
        ok((await page.title()).startswith('麦麦帮你点'), 'HTML <title> 含「麦麦帮你点」')
        ok('avatar.jpg' in await page.evaluate("getComputedStyle(document.getElementById('avatarSlot')).backgroundImage"), '首页头像位已显示头像')
        ok(await page.evaluate("document.fonts.check('900 26px MaiBlack','麦麦帮你点')"), '标题字体子集含「帮你点」')
        top = await page.evaluate("""()=>{const r=id=>document.querySelector(id).getBoundingClientRect();const a=r('#avatarSlot'),b=r('.brand .bubble'),c=r('#cartBtn');return {aR:a.right,bL:b.left,bR:b.right,cL:c.left,mid:(b.left+b.right)/2}}""")
        ok(top['bL'] >= top['aR'] - 12 and top['bL'] <= top['aR'] + 16 and top['cL'] - top['bR'] >= 10, f'顶部「头像 + 对话气泡标题」紧挨着，且不挤购物车 {top}')  # 家长改版后：头像在左、气泡在头像右侧（不再居中）
        await page.screenshot(path=f'{SHOTS}/step2-a0-home-title-avatar.png')
        await hold(page, '#voiceBtn', '我今天健身了，来点高蛋白的', ms=1000, shot='step2-a1-hold-interim')
        sp = await page.evaluate('window.__sp')
        ok(sp['started'] == 1 and sp['lang'] == 'zh-CN' and sp['interim'] is True, f"按下即 start 识别，lang=zh-CN，interimResults=true（{sp['lang']}）")
        ok(await page.evaluate("document.body.classList.contains('in-chat')"), '松手后进入对话页')
        ok((await page.inner_text('.msg.user .ub')).strip() == '我今天健身了，来点高蛋白的', '用户气泡 = 识别结果')
        ok(await page.locator('.msg.agent .av').first.evaluate("e=>e.src.includes('avatar.jpg')&&e.naturalWidth>0"), 'agent 气泡头像=豆豆头像')
        ok((await page.inner_text('.cbrand .brand-name')) == '麦麦帮你点', '对话页标题=麦麦帮你点')
        await page.screenshot(path=f'{SHOTS}/step2-a2-chat-from-home.png')
        # 太短的按住不触发
        await page.click('#chatBack'); await page.wait_for_timeout(500)
        n_before = await page.evaluate("document.querySelectorAll('.msg.user').length")
        await hold(page, '#voiceBtn', '来点吃的', ms=150, wait=500)
        ok(not await page.evaluate("document.body.classList.contains('in-chat')"), '按得太短 → 不进对话页')
        ok('太短' in await page.inner_text('#toast'), '按得太短 → toast 提示')
        await page.context.close()

        # ─────────── b) 三个场景 ───────────
        page, d = await scenario(b, '高蛋白（健身）', '我今天健身了，来点高蛋白的', 'step2-b1-protein')
        sets = [d['center'], d['left'], d['right']]
        ok(len({sig(s) for s in sets}) == 3, '可见的三套互不相同：' + ' | '.join(dishes(s) for s in sets))
        ok(all(s['pill'] and '蛋白质' in s['pill'] and re.search(r'\d+g', s['pill']) for s in sets), '每套都显示蛋白质克数：' + ' / '.join(s['pill'] for s in sets))
        ok(d['center']['reason'] != '' and '蛋白' not in d['center']['reason'], '卡片理由不再重复蛋白质')
        ok('蛋白' not in (await page.inner_text('.msg.agent .mbt')) and '打底' in (await page.inner_text('.msg.agent .mbt')), 'agent 气泡一句话不再重复蛋白质')
        allp = d['hot'] + d['new'] + [d['center']]
        ok(all(s['protein'] >= 25 for s in allp), f'所有套蛋白质 ≥ 25g（最低 {min(s["protein"] for s in allp)}g）')
        ok(all(abs(s['total'] - round(sum(r['sub'] for r in s['rows']), 2)) < 0.01 for s in allp), '合计 = 各行小计之和')
        ok(all(len(s['rows']) >= 2 for s in allp[:6]), '每套都有主食+配餐')
        R['protein'] = {'center': d['center'], 'hot': d['hot'], 'new': d['new']}
        prot = page
        page_l, dl = await scenario(b, '清淡（昨天油腻）', '昨天吃得油腻，今天想清淡点', 'step2-b2-light')
        alll = dl['hot'] + dl['new'] + [dl['center']]
        heavy = re.compile(r'炸鸡|薯条|麦乐鸡|薯饼|芝士条|麦辣|辣|鸡翅|奶昔|三件套|双层|巨无霸|黑巧|麦旋风|派')
        bad = [dishes(s) for s in alll if any(heavy.search(r['name']) for r in s['rows'])]
        ok(not bad, '清淡场景所有套都没有炸鸡/薯条/重口味' + (f'（违例：{bad}）' if bad else ''))
        ok(len({sig(s) for s in [dl['center'], dl['left'], dl['right']] if s}) == len([s for s in [dl['center'], dl['left'], dl['right']] if s]), '清淡：可见的套互不相同：' + ' | '.join(dishes(s) for s in alll[:4]))
        ok(all(s['fat'] <= 20 for s in alll), f'清淡：每套脂肪 ≤ 20g（最高 {max(s["fat"] for s in alll)}g）')
        ok(len(alll) >= 3, f'清淡：至少 3 套（共 {len(alll)} 套）')
        R['light'] = {'center': dl['center'], 'hot': dl['hot'], 'new': dl['new']}
        await page_l.context.close()
        page_p, dp = await scenario(b, '3 人 预算 100', '3个人预算100', 'step2-b3-3ppl')
        allpp = dp['hot'] + dp['new'] + [dp['center']]
        ok(all(s['total'] <= 100 + 1e-9 for s in allpp), f'3人预算：所有套合计 ≤ 100（最高 ¥{max(s["total"] for s in allpp)}）')
        ok(all(s['title'].startswith('3人 · ¥') and '预算100内' in s['title'] for s in allpp), '标题形如「3人 · ¥xx（预算100内）」：' + dp['center']['title'])
        ok(len({sig(s) for s in [dp['center'], dp['left'], dp['right']]}) == 3, '3人预算：可见的三套互不相同')
        ok(all(sum(r['qty'] for r in s['rows'] if r['code'] and True) >= 4 for s in allpp), '3人预算：每套至少 4 份餐品（够 3 人吃）')
        ok('3' in await page_p.inner_text('.msg.agent .mbt') and '100' in await page_p.inner_text('.msg.agent .mbt'), 'agent 气泡点明 3人/预算100')
        ok(any(r['coupon'] for s in allpp for r in s['rows']), '预算场景用上了券/特价（真实价格计算）')
        ok(all(r['sub'] <= r['was'] + 1e-9 for s in allpp for r in s['rows']), '每行 小计 ≤ 原价（原价划线）')
        R['3ppl'] = {'center': dp['center'], 'hot': dp['hot'], 'new': dp['new']}
        await page_p.context.close()

        # ─────────── c) 叠放 / 拖动 / 翻页 / 反悔（用高蛋白场景那页） ───────────
        print('\n== c) 叠放、拖动、翻页、反悔')
        page = prot
        await page.evaluate("document.getElementById('chatScroll').scrollTop=1e5"); await page.wait_for_timeout(200)
        info = await page.evaluate("""()=>{const c=[...document.querySelectorAll('.mc')].map(e=>({z:e.style.zIndex,o:+e.style.opacity,r:e.getBoundingClientRect()}));
           const cen=c.find(x=>x.z==='3'), side=c.filter(x=>x.z==='1');return {cen:{l:cen.r.left,r:cen.r.right,w:cen.r.width},sides:side.map(s=>({l:s.r.left,r:s.r.right,o:s.o,top:s.r.top})),cenTop:cen.r.top,
           peekL:Math.min(...side.map(s=>s.r.left)),tags:[...document.querySelectorAll('.etag.on')].map(e=>e.textContent),hasHint:/左滑|右滑|滑动/.test(document.querySelector('.stack').innerText)}}""")
        ok(info['cen']['w'] >= 340 and info['cen']['l'] <= 24, f"当前套撑满屏宽（宽 {info['cen']['w']:.0f}px）")
        ok(any(s['l'] < info['cen']['l'] - 10 for s in info['sides']) and any(s['r'] > info['cen']['r'] + 10 for s in info['sides']), '左右各露出相邻套的边缘')
        ok(all(s['o'] < 1 and s['top'] > info['cenTop'] for s in info['sides']), '相邻套更透明、更低')
        ok(set(info['tags']) == {'爆款', '新'}, '边缘淡角标：左爆款 右新')
        ok(not info['hasHint'], '没有“左滑/右滑”提示文字')
        first = await center_id(page); y = await center_y(page)
        await drag(page, 250, y, 150, y + 6, hold_end=True)       # 向左拖到一半，未松手
        await page.wait_for_timeout(100)
        await page.screenshot(path=f'{SHOTS}/step2-c1-drag-mid.png')
        tr = await page.evaluate("document.querySelector('.mc[style*=\"z-index: 3\"]').style.transform")
        ok('translate3d(-' in tr, f'拖动跟手（居中卡随手指平移 {tr[:40]}）')
        await page.mouse.up(); await page.wait_for_timeout(650)
        second = await center_id(page)
        ok(second != first and await center_rail(page) == 'new', f'向左拖过阈值 → 翻到新品序下一套（{first} → {second}）')
        await page.screenshot(path=f'{SHOTS}/step2-c2-flipped-new.png')
        ok(await page.locator('.sundo').is_visible(), '翻页后出现「↩」')
        await page.click('.sundo'); await page.wait_for_timeout(650)
        ok(await center_id(page) == first, '点「↩」回到上一套')
        await page.screenshot(path=f'{SHOTS}/step2-c3-undo.png')
        y = await center_y(page)
        await drag(page, 150, y, 255, y + 4); await page.wait_for_timeout(650)
        hot = await center_id(page)
        ok(hot != first and await center_rail(page) == 'hot', f'向右拖 → 翻到爆品序下一套（{hot}）')
        await page.keyboard.press('Backspace'); await page.wait_for_timeout(650)
        ok(await center_id(page) == first, 'Backspace 同样反悔')
        y = await center_y(page)
        await drag(page, 230, y, 255, y); await page.wait_for_timeout(500)
        ok(await center_id(page) == first, '拖得不够远 → 回弹，不翻页')
        # 竖向拖动应当滚动对话而不是翻页
        await page.mouse.wheel(0, -200); await page.wait_for_timeout(200)
        ok(await center_id(page) == first, '竖向滚动不触发翻页')
        # 翻几页后每套仍符合意图
        for _ in range(3):
            await page.evaluate("Mai.chat.state.active.stack.go('left')"); await page.wait_for_timeout(480)
        pr = await page.evaluate("Mai.chat.state.active.stack.center().protein")
        ok(pr >= 25, f'翻到的套仍是高蛋白（{pr}g）')
        bubble = await page.inner_text('.msg.agent .mbt'); ok('打底' in bubble and '蛋白' not in bubble, 'agent 气泡随翻页更新：' + bubble)
        while await page.evaluate("Mai.chat.state.active.stack.canUndo()"):
            await page.evaluate("Mai.chat.state.active.stack.undo()"); await page.wait_for_timeout(460)
        ok(await center_id(page) == first, '连续反悔回到最初那一套')

        # ─────────── d) 语音改单 ───────────
        print('\n== d) 语音改单：不要牛奶，换个饮料')
        before = await page.evaluate("Mai.chat.state.active.stack.center().rows.map(r=>({code:r.code,name:r.name,cat:r.cat,sub:r.subtotal}))")
        tot0 = await page.evaluate("Mai.chat.state.active.stack.center().total")
        await hold(page, '#chatVoiceBtn', '不要牛奶，换个饮料', ms=900, wait=3600)
        await page.wait_for_timeout(100)
        await page.screenshot(path=f'{SHOTS}/step2-d1-voice-edit.png')
        after = await page.evaluate("Mai.chat.state.active.stack.center().rows.map(r=>({code:r.code,name:r.name,cat:r.cat,sub:r.subtotal}))")
        tot1 = await page.evaluate("Mai.chat.state.active.stack.center().total")
        diff = [i for i in range(len(before)) if before[i]['code'] != after[i]['code']]
        ok(len(before) == len(after) and len(diff) == 1 and after[diff[0]]['cat'] == 'drink', f'只换了饮料那一行：{before[diff[0]]["name"]} → {after[diff[0]]["name"]}，其余行不变')
        ok(await page.locator('.it.hl').count() == 1, '被替换行高亮')
        dt = (await page.locator('.dtag').inner_text()) if await page.locator('.dtag').count() else ''
        ok(re.match(r'(\+¥|省¥)[\d.]+|价格不变', dt) is not None, f'高亮行显示价差：{dt}')
        ok(abs((tot1 - tot0) - (after[diff[0]]['sub'] - before[diff[0]]['sub'])) < 0.01, f'合计随之更新：¥{tot0} → ¥{tot1}')
        ok(await page.locator('.edline').count() == 1 and '已改单' in await page.inner_text('.mc[style*="z-index: 3"] .mt'), '卡片标题「已改单」+ 常驻改动摘要行')
        ok(await page.locator('.mbt.sum').count() >= 1, '上一张卡收成一行灰色摘要：' + await page.locator('.mbt.sum').first.inner_text())
        await page.wait_for_timeout(2200)
        ok(await page.locator('.it.hl').count() == 0 and await page.locator('.dtag').count() == 0, '高亮 2 秒后消失')
        # 第二次：换成可乐
        await hold(page, '#chatVoiceBtn', '换成可乐', ms=800, wait=3300)
        names = await page.evaluate("Mai.chat.state.active.stack.center().rows.map(r=>r.name)")
        ok(any('可乐' in n for n in names), f'「换成可乐」→ 饮料行变可乐：{names}')
        await page.screenshot(path=f'{SHOTS}/step2-d2-edit-cola.png')
        # 听不懂的改单 → 反问
        await hold(page, '#chatVoiceBtn', '嗯那个随便搞搞吧', ms=800, wait=3300)
        ok(await page.locator('.cchip').count() == 3, '听不懂 → agent 反问并给 3 个标签按钮：' + await page.locator('.msg.agent .mbt').last.inner_text())
        await page.screenshot(path=f'{SHOTS}/step2-d3-clarify.png')
        await page.locator('.cchip', has_text='清淡一点').click(); await page.wait_for_timeout(3300)
        ok(await page.evaluate("Mai.chat.state.active.stack.center().pill.text.startsWith('脂肪')"), '点标签「清淡一点」→ 重新推荐清淡套')
        await page.screenshot(path=f'{SHOTS}/step2-d4-multi-turn.png')
        ok(await page.locator('.msg.user').count() >= 5, f'多轮对话历史保留（{await page.locator(".msg.user").count()} 条用户消息）')

        # ─────────── e) 加入购物车 ───────────
        print('\n== e) 加入购物车')
        await page.evaluate("Mai.chat.state.active.stack.go('left')"); await page.wait_for_timeout(500)
        n1 = await page.evaluate("Mai.chat.state.active.stack.center().rows.reduce((a,r)=>a+r.qty,0)")
        nav = page.url
        await page.click('.mc[style*="z-index: 3"] .addbtn'); await page.wait_for_timeout(300)
        ok(await page.locator('.mc[style*="z-index: 3"] .addbtn.done').count() == 1, '加购图标按钮变绿 ✓')
        ok('已加入购物车' in await page.inner_text('#toast'), 'toast「已加入购物车」')
        ok(page.url == nav and await page.evaluate("document.body.classList.contains('in-chat')"), '不跳转，留在对话页')
        ok((await page.inner_text('#chatCartCount')) == str(n1), f'对话页购物车角标 = {n1}')
        await page.screenshot(path=f'{SHOTS}/step2-e1-added.png')
        await page.wait_for_timeout(2100)
        ok(await page.locator('.mc[style*="z-index: 3"] .addbtn.done').count() == 0, '2 秒后按钮恢复')
        await page.evaluate("Mai.chat.state.active.stack.go('right')"); await page.wait_for_timeout(500)
        n2 = await page.evaluate("Mai.chat.state.active.stack.center().rows.reduce((a,r)=>a+r.qty,0)")
        await page.click('.mc[style*="z-index: 3"] .addbtn'); await page.wait_for_timeout(300)
        ok((await page.inner_text('#chatCartCount')) == str(n1 + n2), f'再加一套，角标累加 = {n1}+{n2}')
        await page.click('#chatBack'); await page.wait_for_timeout(500)
        ok((await page.inner_text('#cartCount')) == str(n1 + n2), '回首页，首页角标同步')
        store = await page.evaluate("JSON.parse(localStorage.getItem('maimai.cart.v1'))")
        ok(len(store['entries']) == 2 and sum(r['qty'] for e in store['entries'] for r in e['rows']) == n1 + n2, 'localStorage 里有 2 套（步骤 3 可读）')
        await page.screenshot(path=f'{SHOTS}/step2-e2-home-badge.png')
        R['cart_store'] = {'entries': len(store['entries']), 'items': n1 + n2}
        # 首页单品加购也进同一个 store
        await page.click('.card[style*="z-index: 3"] .add'); await page.wait_for_timeout(300)
        ok((await page.inner_text('#cartCount')) == str(n1 + n2 + 1), '首页单品加购与整套加购共用同一个购物车')
        # 重新打开页面：购物车保留
        await page.reload(); await page.wait_for_selector('body.ready'); await page.wait_for_timeout(300)
        ok((await page.inner_text('#cartCount')) == str(n1 + n2 + 1), '刷新后购物车角标仍在（localStorage）')
        await page.context.close()

        # ─────────── f) 打字 / 降级 ───────────
        print('\n== f) 识别不可用 → 打字降级')
        page = await new_page(b)
        await hold(page, '#voiceBtn', '随便', ms=800, error='not-allowed', wait=1200)
        ok(await page.evaluate("document.body.classList.contains('in-chat')"), '权限被拒 → 仍进入对话页')
        ok(await page.locator('.fbchip').count() == 3, '显示 3 条示例快捷语：' + ' / '.join(await page.locator('.fbchip').all_inner_texts()))
        ok(not await page.locator('.chat.typing').count(), '权限被拒后仍默认「按住说话」（不自动切到打字框）')
        ok('麦克风' in await page.inner_text('.msg.agent .mbt'), '说明了原因：' + await page.inner_text('.msg.agent .mbt'))
        await page.screenshot(path=f'{SHOTS}/step2-f1-fallback-denied.png')
        await page.locator('.fbchip').nth(1).click(); await page.wait_for_timeout(3300)
        ok(await page.evaluate("!!Mai.chat.state.active && Mai.chat.state.active.stack.center().pill.text.startsWith('脂肪')"), '点示例快捷语 = 识别结果 → 出清淡餐卡')
        ok(await page.locator('.msg.user .umic').count() == 1, '示例快捷语以“语音”用户气泡呈现')
        # 打字
        await page.click('#kbBtn'); await page.wait_for_timeout(150)
        ok(await page.locator('.chat.typing .tform').is_visible(), '点键盘图标 → 打字框展开')
        await page.click('#kbBtn'); await page.wait_for_timeout(100)
        ok(not await page.locator('.chat.typing').count(), '键盘图标可切回语音')
        await page.click('#kbBtn'); await page.wait_for_timeout(150)
        await page.fill('#typeInput', '嗯'); await page.press('#typeInput', 'Enter'); await page.wait_for_timeout(300)
        ok('多输几个字' in await page.inner_text('#toast'), '过短文本 → 提示：' + await page.inner_text('#toast'))
        nusers = await page.locator('.msg.user').count()
        await page.fill('#typeInput', ''); await page.press('#typeInput', 'Enter'); await page.wait_for_timeout(300)
        ok(await page.locator('.msg.user').count() == nusers, '空文本 → 不发送')
        await page.fill('#typeInput', '想吃鸡，便宜点'); await page.press('#typeInput', 'Enter'); await page.wait_for_timeout(3300)
        ok(await page.locator('.msg.user').count() == nusers + 1 and await page.locator('.msg.user .umic').count() == 1, '打字发送：用户气泡无麦克风图标')
        sc = await page.evaluate(SETS_JS); allc = sc['hot'] + sc['new'] + [sc['center']]
        ok(all(any('鸡' in r['name'] or '麦乐' in r['name'] for r in s['rows']) for s in allc), '「想吃鸡」→ 每套都有鸡肉类：' + dishes(sc['center']))
        await page.screenshot(path=f'{SHOTS}/step2-f2-typed.png')
        # 输入框里按退格不应触发“反悔”
        await page.focus('#typeInput'); await page.keyboard.type('abc'); await page.keyboard.press('Backspace')
        ok(await page.input_value('#typeInput') == 'ab', '输入框里 Backspace 只删字')
        await page.context.close()
        # 浏览器完全不支持
        page = await new_page(b, NO_SR)
        ok(not await page.evaluate("Mai.speech.support().ok"), '（无 SpeechRecognition 的浏览器）support=false')
        await hold(page, '#voiceBtn', None, ms=800, wait=800)
        ok(await page.locator('.fbchip').count() == 3 and '不支持' in await page.inner_text('.msg.agent .mbt'), '不支持 → 降级文案 + 3 条示例：' + await page.inner_text('.msg.agent .mbt'))
        await page.screenshot(path=f'{SHOTS}/step2-f3-fallback-unsupported.png')
        await page.context.close()
        # 网络错误
        page = await new_page(b)
        await hold(page, '#voiceBtn', '你好', ms=800, error='network', wait=1200)
        ok('联网' in await page.inner_text('.msg.agent .mbt'), '网络错误 → 说明需联网')
        await page.context.close()
        # 没听清（空结果）
        page = await new_page(b)
        await hold(page, '#voiceBtn', '', ms=800, wait=1200)
        ok(not await page.evaluate("document.body.classList.contains('in-chat')") and '没听清' in await page.inner_text('#toast'), '没识别出内容 → 首页 toast「没听清」')
        await page.context.close()

        # ─────────── g) 口语解析覆盖 ───────────
        print('\n== g) 口语解析')
        page = await new_page(b)
        cases = ['便宜点', '不要辣', '想吃鸡', '早餐', '想吃牛肉', '想吃得饱一点', '来点提神的', '两个人预算60', '预算30', '随便', '来点吃的']
        out = await page.evaluate("""(cs)=>cs.map(t=>{const P=Mai.intent.parse(t,{hasStack:false,last:null});
          if(P.kind!=='recommend')return {t,kind:P.kind,text:P.text,chips:P.chips};
          const b=Mai.sets.build(P);const all=b.hot.concat(b.new);return {t,kind:P.kind,n:all.length,first:all[0]&&all[0].rows.map(r=>r.name).join('+'),title:all[0]&&all[0].title,
            spicy:all.some(s=>s.rows.some(r=>Mai.sets.SPICY_RE.test(r.name))),maxTotal:Math.max.apply(null,all.map(s=>s.total))}})""", cases)
        for o in out: print('   ', o)
        R['colloquial'] = out
        g = {o['t']: o for o in out}
        ok(all(g[t]['kind'] == 'recommend' and g[t]['n'] >= 1 for t in cases[:8]), '便宜点/不要辣/想吃鸡/早餐/牛肉/吃饱/提神/人数预算 都能解析并出套')
        ok(not g['不要辣']['spicy'], '「不要辣」→ 没有辣味菜')
        ok(g['预算30']['maxTotal'] <= 30, '「预算30」→ 单人套 ≤ 30')
        ok(g['随便']['kind'] == 'clarify' and g['来点吃的']['kind'] == 'clarify', '解析不出 → 回问，不乱推：' + g['随便']['text'])
        # 回问气泡
        await page.evaluate("Mai.chat.submit('随便', {src:'typed'})"); await page.wait_for_timeout(3100)
        ok(await page.locator('.cchip').count() == 3 and '想吃得饱一点还是清淡一点' in await page.inner_text('.msg.agent .mbt'), 'UI：回问「想吃得饱一点还是清淡一点？」+ 3 个标签按钮')
        ok(not await page.evaluate("!!Mai.chat.state.active"), '回问时没有出任何餐卡')
        await page.screenshot(path=f'{SHOTS}/step2-g1-clarify.png')
        await page.context.close()

        # ─────────── 禁用元素检查 ───────────
        print('\n== 禁用元素 / 桌面框')
        page = await new_page(b)
        await hold(page, '#voiceBtn', '我今天健身了，来点高蛋白的')
        html = await page.evaluate("document.getElementById('chat').innerText + document.querySelector('.mc').outerHTML")
        ok(not re.search(r'微调|加购|就要这份|左滑换一套|右滑就要|跳过', html), '卡片/对话里没有「微调/加购/就要这份/左滑换一套右滑就要/跳过」')
        ok(await page.locator('.mc[style*="z-index: 3"] .acts button').count() == 2 and await page.locator('.mc[style*="z-index: 3"] .gobtn').count() == 1 and (await page.inner_text('.mc[style*="z-index: 3"] .addbtn')).strip() == '', '卡底两个按钮：无字购物车加号图标 + 大「就这个吧！」')
        await page.context.close()
        dctx = await b.new_context(viewport={'width': 1280, 'height': 900}); dp = await dctx.new_page()
        await dp.add_init_script(MOCK); await dp.goto(URL); await dp.wait_for_selector('body.ready'); await dp.wait_for_timeout(400)
        await dp.evaluate("window.__sp.text='3个人预算100'")
        await hold(dp, '#voiceBtn', '3个人预算100')
        await dp.screenshot(path=f'{SHOTS}/step2-h1-desktop-frame.png')
        await b.close()

    ok(not errors, 'Console 无 error/warning/请求失败' + (f'：{errors[:5]}' if errors else ''))
    R['console_errors'] = errors
    R['fails'] = fails
    json.dump(R, open(SHOTS + '/step2-scenarios.json', 'w'), ensure_ascii=False, indent=1)
    print('\n====', 'ALL PASS' if not fails else f'{len(fails)} FAILED', '====')
    for f in fails: print(' -', f)
    sys.exit(1 if fails else 0)

asyncio.run(main())
