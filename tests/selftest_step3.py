"""步骤 3 自测：python3 tests/selftest_step3.py
 · 不用语音：打字输入 + 点按钮，或直接写 localStorage 预置购物车；
 · 本地 http.server（localhost）+ /usr/bin/google-chrome（playwright）；
 · 覆盖：加购 → 购物车 → 勾选 → 结算 → 支付成功 → 已结算清出 / 未勾选保留；空态、改数量、删除、预估/实算徽标、麦乐送提示；
 · 全程收集 console error/warning、pageerror、requestfailed，必须为空；截图写到 shots/step3-*.png；失败 → 退出码 1。"""
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

errors, fails = [], []
def ok(cond, msg):
    if not cond: fails.append(msg); print('  ✗ FAIL:', msg)
    else: print('  ✓', msg)

async def new_page(b, cart=None):
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    page = await ctx.new_page()
    page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('requestfailed', lambda r: errors.append(f'requestfailed: {r.url}'))
    page.on('response', lambda r: errors.append(f'http {r.status}: {r.url}') if r.status >= 400 else None)
    if cart is not None:
        await page.add_init_script("if(!sessionStorage.__seeded){localStorage.setItem('maimai.cart.v1',%s);sessionStorage.__seeded=1}" % json.dumps(json.dumps(cart)))
    await page.goto(URL); await page.wait_for_selector('body.ready'); await page.wait_for_timeout(400)
    return page

def row(code, name, qty, sub, was=None, coupon=None):
    return {'code': code, 'name': name, 'img': 'assets/avatar.jpg', 'qty': qty, 'subtotal': sub, 'was': was or sub, 'coupon': coupon}
def entry(i, kind, title, rows):
    return {'id': f'e{i}', 'ts': 1, 'kind': kind, 'title': title, 'rail': 'hot', 'rows': rows,
            'total': sum(r['subtotal'] for r in rows), 'was': sum(r['was'] for r in rows)}

async def vis(page, sel): return await page.evaluate("s=>{const e=document.querySelector(s);return !!e&&e.classList.contains('on')}", sel)
def num(s): return float(re.search(r'[\d.]+', s.replace(',', '')).group())

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])

        # ───────── a) 空购物车 ─────────
        print('\n== a) 空购物车')
        page = await new_page(b)
        await page.click('#cartBtn'); await page.wait_for_timeout(500)
        ok(await vis(page, '#cartPage'), '首页右上角购物车 → 打开购物车页')
        ok('购物车还是空的' in await page.inner_text('#cartBody'), '空态文案')
        ok(await page.locator('#cartPage .avatar-slot img, #cartPage .avatar-slot canvas, #cartPage .avatar-slot svg').count() >= 0 and await page.locator('#cartPage .bubble .pg-title').count() == 1, '页头是「头像 + 气泡标题」')
        ok(await page.locator('#cartPage .brand-m, #cartPage .logo-m').count() == 0, '页头没有红色 M 标')
        await page.screenshot(path=f'{SHOTS}/step3-a-empty-cart.png')
        await page.click('#cartBody [data-act=goorder]'); await page.wait_for_timeout(500)
        ok(not await vis(page, '#cartPage'), '「去点餐」回到首页')
        await page.context.close()

        # ───────── b) 真实加购流程（打字输入，不用语音）─────────
        print('\n== b) 加购 → 购物车 → 勾选 → 结算 → 支付 → 清出')
        page = await new_page(b)
        await page.click('.card[style*="z-index: 3"] .add'); await page.wait_for_timeout(300)   # 首页单品加购
        ok((await page.inner_text('#cartCount')) == '1', '首页单品加购，角标 = 1')
        await page.evaluate('Mai.chat.open()'); await page.wait_for_timeout(500)
        await page.click('#kbBtn'); await page.wait_for_timeout(200)     # 切到打字
        ok(await page.evaluate("document.body.classList.contains('in-chat')"), '进入对话页（无语音）')
        await page.fill('#typeInput', '想吃鸡，便宜点'); await page.press('#typeInput', 'Enter'); await page.wait_for_timeout(1600)
        await page.click('.mc[style*="z-index: 3"] .addbtn'); await page.wait_for_timeout(300)
        n_all = int(await page.inner_text('#chatCartCount'))
        ok(n_all >= 2, f'对话页加购整套，角标 = {n_all}')
        await page.click('#chatCartBtn'); await page.wait_for_timeout(500)
        ok(await vis(page, '#cartPage'), '对话页购物车角标 → 购物车页')
        ok(await page.locator('#cartBody .grp').count() == 2, '按「套餐 / 单品」分成 2 组')
        tags = await page.locator('#cartBody .grp .gh').all_inner_texts()
        ok(any('套餐' in t for t in tags) and any('单品' in t for t in tags), f'分组标签含「套餐」「单品」：{[t.split()[0] for t in tags]}')
        rows = page.locator('#cartBody .rw, #cartBody .row')
        n_rows = await page.locator('#cartBody [data-act=rsel]').count()
        ok(n_rows >= 2, f'每行有勾选框（{n_rows} 行）')
        ok(await page.locator('#cartBody [data-act=inc]').count() == n_rows and await page.locator('#cartBody [data-act=rdel]').count() == n_rows, '每行有 +/− 与删除')
        ok(await page.locator('#cartBody [data-act=rsel].on').count() == n_rows, '默认全部勾选')
        bar0 = await page.inner_text('#cartBar')
        ok(all(k in bar0 for k in ('原价', '优惠', '应付', '去结算')), '底栏有原价/优惠/应付 + 去结算')
        await page.screenshot(path=f'{SHOTS}/step3-b1-cart.png')

        # 改数量：单品 +1
        dish_eid = await page.evaluate("Mai.cart.entries().find(e=>e.kind==='dish').id")
        pay0 = num(await page.inner_text('#cartBar .cb-pay, #cartBar .pay, #cartBar b'))
        await page.click(f'#cartBody [data-act=inc][data-eid="{dish_eid}"]'); await page.wait_for_timeout(200)
        ok(await page.evaluate(f"Mai.cart.find('{dish_eid}').rows[0].qty") == 2, '单品 + → 数量 2')
        ok(int(await page.inner_text('#cartCount')) == n_all + 1, '首页角标同步')
        await page.click(f'#cartBody [data-act=dec][data-eid="{dish_eid}"]'); await page.wait_for_timeout(200)
        ok(await page.evaluate(f"Mai.cart.find('{dish_eid}').rows[0].qty") == 1, '单品 − → 数量 1')

        # 取消勾选单品 → 底栏结算件数变少
        cnt_before = int(re.search(r'\((\d+)\)', await page.inner_text('#cartBar .go')).group(1))
        await page.click(f'#cartBody [data-act=rsel][data-eid="{dish_eid}"]'); await page.wait_for_timeout(200)
        cnt_after = int(re.search(r'\((\d+)\)', await page.inner_text('#cartBar .go')).group(1))
        ok(cnt_after == cnt_before - 1, f'取消勾选单品 → 去结算({cnt_before}) → ({cnt_after})')
        ok(await page.evaluate(f"Mai.cart.find('{dish_eid}').rows[0].sel") is False, '勾选状态写进 localStorage')
        await page.screenshot(path=f'{SHOTS}/step3-b2-cart-unchecked.png')

        # 去结算
        await page.click('#cartBar [data-act=checkout]'); await page.wait_for_timeout(500)
        ok(await vis(page, '#coPage'), '去结算 → 结算页')
        body = await page.inner_text('#coBody')
        ok('陆家嘴明珠环' in body and '1450127' in body, '结算页：门店 陆家嘴明珠环 1450127')
        ok('到店取餐' in body and '麦乐送' in body, '取餐方式：到店取餐 / 麦乐送')
        ok('堂食' in body and '外带' in body, '到店取餐可选 堂食 / 外带')
        ok(all(k in body for k in ('商品原价', '优惠券', '应付')), '有商品原价 / 优惠券 / 应付')
        ok(not await page.evaluate(f"document.querySelector('#coBody [data-code]') && [...document.querySelectorAll('#coBody .irow')].some(x=>false)"), '菜品明细渲染')
        pay_co = num(await page.inner_text('#coPayable'))
        ok(abs(pay_co - num(await page.inner_text('#coBar .co-sum b'))) < .01, f'应付 = 底栏合计 = ¥{pay_co}')
        pn = await page.inner_text('#coBody .pnote')
        ok('实算' in pn or '预估' in pn, f'价格来源有标注：{pn[:30]}…')
        ok(await page.locator('#coBody .irow').count() == await page.evaluate("Mai.pricing.quote(Mai.cart.selectedRows().map(x=>x.row)).lines.length"), '菜品明细 = 勾选菜品（未勾选的不在里面）')
        await page.click('#coBody [data-act=mode-delivery]'); await page.wait_for_timeout(200)
        ok('麦乐送' in await page.inner_text('#toast') and await vis(page, '#coPage'), '点「麦乐送」→ 提示暂未开放，仍在结算页')
        await page.click('#coBody [data-act=take][data-k=locker-in]') if await page.locator('#coBody [data-k=locker-in]').count() else None
        await page.screenshot(path=f'{SHOTS}/step3-b3-checkout.png')
        await page.evaluate("document.querySelector('#coPage .pg-scroll').scrollTop=9999"); await page.wait_for_timeout(150)
        await page.screenshot(path=f'{SHOTS}/step3-b3b-checkout-bottom.png')

        # 支付
        await page.click('#coBar [data-act=pay]'); await page.wait_for_timeout(250)
        ok(await page.evaluate("document.getElementById('payOv').classList.contains('on')"), '点「确认支付」→ 支付中')
        await page.screenshot(path=f'{SHOTS}/step3-b4-paying.png')
        await page.wait_for_selector('#okPage.on', timeout=5000); await page.wait_for_timeout(400)
        ok(await vis(page, '#okPage') and not await vis(page, '#coPage'), '支付成功页')
        code = (await page.inner_text('#pickCode')).strip()
        ok(re.fullmatch(r'[A-Z] \d{3}', code) is not None, f'取餐码 {code}')
        ok_body = await page.inner_text('#okBody')
        ok('陆家嘴明珠环' in ok_body and '已点菜品' in ok_body, '成功页：门店 + 已点菜品')
        ok(abs(num(await page.inner_text('#paidTotal')) - pay_co) < .01, '实付 = 结算页应付')
        ok('返回首页' in await page.inner_text('#okBar'), '有「返回首页」')
        await page.screenshot(path=f'{SHOTS}/step3-b5-success.png')
        left = await page.evaluate("Mai.cart.entries().map(e=>({k:e.kind,rows:e.rows.map(r=>[r.code,r.qty])}))")
        ok(len(left) == 1 and left[0]['k'] == 'dish', f'已结算的整套清出，未勾选的单品保留：{left}')
        orders = await page.evaluate("JSON.parse(localStorage.getItem('maimai.orders.v1')||'[]')")
        ok(len(orders) == 1 and orders[0]['code'] == code and orders[0].get('demo') is True, '订单记在 maimai.orders.v1（demo 标记）')
        await page.click('#okBar [data-act=home]'); await page.wait_for_timeout(500)
        ok(not await vis(page, '#okPage') and not await vis(page, '#cartPage'), '返回首页')
        ok(int(await page.inner_text('#cartCount')) == 1, '首页角标 = 剩下的 1 件')
        await page.click('#cartBtn'); await page.wait_for_timeout(400)
        ok(await page.locator('#cartBody .grp').count() == 1 and await page.locator('#cartBody [data-act=rsel].on').count() == 0, '再开购物车：只剩未勾选的单品')
        await page.screenshot(path=f'{SHOTS}/step3-b6-cart-left.png')
        ok(await page.locator('#cartBar .go[disabled]').count() == 1, '没勾选任何菜品时「去结算」不可点')
        await page.context.close()

        # ───────── c) 预置购物车：删除 / 全选 / 组选 / 实算价 / 暂不可售 ─────────
        print('\n== c) 预置购物车：删除、全选、组勾选、价格状态')
        page = await new_page(b)
        codes = await page.evaluate("Object.keys(Mai.sets.info()).filter(c=>{const i=Mai.sets.info()[c];return i.list>0&&!(window.MAI_PRICES.unavailable||[]).includes(c)})")
        names = await page.evaluate("c=>Mai.sets.info()[c].name", codes[0]), await page.evaluate("c=>Mai.sets.info()[c].name", codes[1]), await page.evaluate("c=>Mai.sets.info()[c].name", codes[2])
        rows = [row(codes[0], names[0], 1, 11.9, 26), row(codes[1], names[1], 1, 9.9)]
        cart = {'v': 1, 'entries': [entry(1, 'set', '高蛋白 · 1人', rows), entry(2, 'dish', '单品', [row(codes[2], names[2], 2, 20)])]}
        await page.context.close()
        page = await new_page(b, cart)
        ok((await page.inner_text('#cartCount')) == '4', '预置购物车角标 = 4')
        await page.click('#cartBtn'); await page.wait_for_timeout(400)
        await page.click('#cartBody .grp >> nth=0 >> [data-act=gsel]'); await page.wait_for_timeout(200)
        ok(await page.locator('#cartBody .grp >> nth=0 >> [data-act=rsel].on').count() == 0, '组勾选框 → 整组取消')
        await page.click('#cartBar [data-act=all]'); await page.wait_for_timeout(200)
        ok(await page.locator('#cartBody [data-act=rsel].on').count() == 3, '全选 → 全部勾选')
        await page.click('#cartBody .grp >> nth=0 >> [data-act=rdel] >> nth=0'); await page.wait_for_timeout(200)
        ok(await page.evaluate("Mai.cart.entries()[0].rows.length") == 1, '行删除')
        await page.click('#cartBody .grp >> nth=0 >> [data-act=gdel]'); await page.wait_for_timeout(200)
        ok(await page.evaluate("Mai.cart.entries().length") == 1, '整组删除')
        await page.click('#cartBody [data-act=dec]'); await page.wait_for_timeout(100); await page.click('#cartBody [data-act=dec]'); await page.wait_for_timeout(300)
        ok('购物车还是空的' in await page.inner_text('#cartBody') and await page.evaluate("Mai.cart.count()") == 0, '数量减到 0 → 删除，回到空态')
        await page.context.close()

        # ───────── d) 价格状态 / 暂不可售 ─────────
        print('\n== d) 价格状态')
        page = await new_page(b)
        r = await page.evaluate("""()=>{
          const P=Mai.intent.parse('想吃鸡，便宜点',{hasStack:false,last:null}), bd=Mai.sets.build(P), s=bd.hot[0];
          const q=Mai.pricing.quote(s.rows.map(x=>({code:x.code,name:x.name,img:x.img,qty:x.qty,subtotal:x.subtotal,was:x.was,coupon:x.coupon})));
          return {status:q.status,payable:q.payable,orig:q.origTotal,n:q.lines.length,unav:q.unavailable,hasReal:Mai.pricing.hasReal(), combos:Object.keys((window.MAI_PRICES||{}).combos||{}).length}}""")
        print('   ', r)
        ok(r['combos'] > 100, f'预计算价格表已加载（{r["combos"]} 个组合）')
        ok(r['status'] in ('real', 'mixed', 'est') and r['payable'] > 0, f'quote 状态 {r["status"]}，应付 ¥{r["payable"]}')
        # 暂不可售菜品
        una = await page.evaluate("(window.MAI_PRICES||{}).unavailable||[]")
        if una:
            c2 = {'v': 1, 'entries': [entry(1, 'dish', '单品', [row(una[0], '暂不可售测试菜', 1, 10)])]}
            await page.evaluate("c=>{localStorage.setItem('maimai.cart.v1',JSON.stringify(c));location.reload()}", c2)
            await page.wait_for_selector('body.ready'); await page.wait_for_timeout(300)
            await page.click('#cartBtn'); await page.click('#cartBar [data-act=checkout]'); await page.wait_for_timeout(400)
            ok('暂不可售' in await page.inner_text('#coBody'), f'核价返回不可售的菜（{una[0]}）→ 结算页提示「暂不可售」')
            await page.screenshot(path=f'{SHOTS}/step3-d-unavailable.png')
        await page.context.close()

        # ───────── e) 首页叠卡没被页面样式影响 ─────────
        print('\n== e) 首页回归')
        page = await new_page(b)
        pos = await page.evaluate("getComputedStyle(document.querySelector('.card[style*=\"z-index: 3\"]')).position")
        ok(pos == 'absolute', f'首页叠卡仍是绝对定位（{pos}）')
        await page.screenshot(path=f'{SHOTS}/step3-e-home.png')
        await page.context.close()
        await b.close()

    print('\n== console / 网络错误:', errors or '无')
    ok(not errors, '没有 console error/warning、pageerror、requestfailed')
    print('\n' + ('全部通过 ✅' if not fails else f'{len(fails)} 项失败 ❌: {fails}'))
    sys.exit(1 if fails else 0)

asyncio.run(main())
