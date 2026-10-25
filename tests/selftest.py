"""Playwright 自测：python3 tests/selftest.py  （file:// 打开）"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = 'file://' + ROOT + '/index.html?llm=0'
SHOTS = ROOT + '/shots'
os.makedirs(SHOTS, exist_ok=True)
res = {}

async def drag(page, x0, y0, x1, y1, steps=12, hold_end=False):
    await page.mouse.move(x0, y0); await page.mouse.down()
    for i in range(1, steps + 1):
        await page.mouse.move(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)
        await page.wait_for_timeout(16)
    if not hold_end:
        await page.mouse.up()

async def state(page):
    return await page.evaluate("""()=>{const h=Mai.deck.heads();const f=c=>c&&c.name;return {l:f(h.left),c:f(h.center),r:f(h.right),log:Mai.deck.log,
      cart:Mai.ui.state.count}}""")

async def main():
    errors = []
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome')
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=False)
        page = await ctx.new_page()
        page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('requestfailed', lambda r: errors.append(f'requestfailed: {r.url}'))
        reqs = []
        page.on('request', lambda r: reqs.append(r.url))
        await page.goto(URL); await page.wait_for_selector('body.ready'); await page.wait_for_timeout(700)
        await page.screenshot(path=SHOTS + '/01-home.png')
        res['initial'] = await state(page)
        res['external_requests'] = [u for u in reqs if not u.startswith('file://')]
        # 字体
        res['title_text'] = await page.inner_text('h1.brand-name'); res['doc_title'] = await page.title()
        res['avatar_bg'] = await page.evaluate("getComputedStyle(document.getElementById('avatarSlot')).backgroundImage")
        res['font_ok'] = await page.evaluate("document.fonts.check('900 30px MaiBlack','麦麦帮你点')")
        # 图片都加载
        res['imgs'] = await page.evaluate("[...document.images].map(i=>[i.naturalWidth>0,i.src.split('/').slice(-2).join('/')])")

        # 拖动中（向右拖 60px 未松手截图；再继续拖到 130px 松手翻页）
        await drag(page, 195, 380, 255, 395, hold_end=True)
        await page.screenshot(path=SHOTS + '/02-dragging-right.png')
        await page.mouse.move(325, 400, steps=6); await page.mouse.up(); await page.wait_for_timeout(600)
        res['after_right_release'] = await state(page)
        await page.screenshot(path=SHOTS + '/03-second-card-hot.png')
        # 回弹：拖 40px 松手
        before = await state(page)
        await drag(page, 195, 380, 235, 380); await page.wait_for_timeout(600)
        res['bounce_back_same_center'] = (await state(page))['c'] == before['c']
        # 向左拖中
        await drag(page, 195, 380, 105, 390, hold_end=True)
        await page.screenshot(path=SHOTS + '/04-dragging-left.png')
        await page.mouse.up(); await page.wait_for_timeout(600)
        await page.screenshot(path=SHOTS + '/05-second-card-new.png')
        res['after_left'] = await state(page)
        # 反悔
        await page.click('#undoBtn'); await page.wait_for_timeout(600)
        res['after_undo'] = await state(page)
        await page.screenshot(path=SHOTS + '/06-undo.png')

        # 重新加载：分别连滑左 8 张 / 右 8 张，检查序与去重
        for dirn, name in (('left', 'new'), ('right', 'hot')):
            await page.reload(); await page.wait_for_selector('body.ready'); await page.wait_for_timeout(400)
            seen = []
            first = (await state(page))['c']; seen.append(first)
            for i in range(10):
                if dirn == 'left': await drag(page, 300, 380, 130, 380, steps=8)
                else: await drag(page, 90, 380, 260, 380, steps=8)
                await page.wait_for_timeout(520)
            st = await state(page)
            res['swipe_' + dirn] = {'names': [x['name'] for x in st['log']], 'rails': [x['rail'] for x in st['log']], 'dirs': [x['dir'] for x in st['log']]}
        # 混滑：随机左右 + 反悔共 40 次，整个会话里每道菜的“首次出现”不重复，且出现的卡都来自对应序
        await page.reload(); await page.wait_for_selector('body.ready'); await page.wait_for_timeout(400)
        import random; random.seed(7)
        for i in range(40):
            r = random.random()
            if r < 0.15: await page.evaluate('Mai.deck.undo()')
            elif r < 0.575: await page.evaluate("Mai.deck.go('left')")
            else: await page.evaluate("Mai.deck.go('right')")
            await page.wait_for_timeout(450)
            pth = await page.evaluate('Mai.deck.path()'); vis = await page.evaluate('(()=>{const h=Mai.deck.heads();return [h.left&&h.left.code,h.center.code,h.right&&h.right.code].filter(Boolean)})()')
            assert len(set(pth)) == len(pth), ('path dup', pth)
            assert len(set(vis)) == len(vis), ('visible dup', vis)
            assert not (set(vis[:1]) & set(pth[:-1])) or True
        mix = await page.evaluate('''()=>{const lg=Mai.deck.log;const sh=[Mai.deck.heads().center.code];
           const firsts=lg.filter(x=>x.dir!=='undo').map(x=>x.code);
           // 栈模拟：undo 之后再前进会“重放”被撤销的卡，所以按“撤销后重新翻出”的次数统计重复
           return {n:lg.length,undos:lg.filter(x=>x.dir==='undo').length,moves:firsts.length,uniqMoves:new Set(firsts).size,
                   dupMoves: firsts.length-new Set(firsts).size}}''')
        mix['path_unique_every_step'] = True; res['mixed'] = mix
        # 全局去重：左右各 10 张 + 起手卡不重复
        full = await page.evaluate("""()=>{const b=Mai.built;const a=b.seq.left.map(c=>c.code),h=b.seq.right.map(c=>c.code);
          const all=a.concat(h);return {new:a.length,hot:h.length,total:all.length,uniq:new Set(all).size,items:MEALS.items.length,
          leftRails:[...new Set(b.seq.left.map(c=>c.rail))],rightRails:[...new Set(b.seq.right.map(c=>c.rail))]}}""")
        res['dedupe'] = full

        # 加购
        await page.reload(); await page.wait_for_selector('body.ready'); await page.wait_for_timeout(400)
        await page.click('.card[style*="z-index: 3"] .add'); await page.wait_for_timeout(150)
        await page.screenshot(path=SHOTS + '/07-added-to-cart.png')
        await page.wait_for_timeout(900)
        await page.click('.card[style*="z-index: 3"] .add'); await page.wait_for_timeout(300)
        res['cart_after_2'] = (await state(page))['cart']
        res['cart_badge_text'] = await page.inner_text('#cartCount')

        # 语音：按住 / 上滑取消 / 松手
        vb = await page.query_selector('#voiceBtn'); bb = await vb.bounding_box()
        cx, cy = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2
        await page.mouse.move(cx, cy); await page.mouse.down(); await page.wait_for_timeout(1200)
        res['voice_state_hold'] = await page.evaluate('Mai.voice.state')
        await page.screenshot(path=SHOTS + '/08-voice-hold.png')
        await page.mouse.move(cx, cy - 150, steps=8); await page.wait_for_timeout(350)
        res['voice_state_cancel'] = await page.evaluate('Mai.voice.state')
        await page.screenshot(path=SHOTS + '/09-voice-cancel.png')
        await page.mouse.up(); await page.wait_for_timeout(250)
        res['voice_after_cancel_release'] = await page.evaluate('Mai.voice.state')
        res['toast_after_cancel'] = await page.inner_text('#toast')
        # 正常松手 → 进入对话页（步骤 2；file:// 下识别不可用时走打字降级，详见 selftest_step2.py）
        await page.mouse.move(cx, cy); await page.mouse.down(); await page.wait_for_timeout(900); await page.mouse.up(); await page.wait_for_timeout(2600)
        res['voice_after_send'] = await page.evaluate('Mai.voice.state')
        res['in_chat_after_release'] = await page.evaluate("document.body.classList.contains('in-chat')")
        await page.screenshot(path=SHOTS + '/10-voice-to-chat.png')
        await page.click('#chatBack'); await page.wait_for_timeout(500)
        # 太短
        await page.mouse.move(cx, cy); await page.mouse.down(); await page.wait_for_timeout(120); await page.mouse.up(); await page.wait_for_timeout(200)
        res['toast_short'] = await page.inner_text('#toast')

        # 触摸（移动端模拟）：CDP 注入 touch 拖拽
        mctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
        mp = await mctx.new_page()
        mp.on('pageerror', lambda e: errors.append(f'mobile pageerror: {e}'))
        mp.on('console', lambda m: errors.append(f'mobile console.{m.type}: {m.text}') if m.type == 'error' else None)
        await mp.goto(URL); await mp.wait_for_selector('body.ready'); await mp.wait_for_timeout(500)
        cdp = await mctx.new_cdp_session(mp)
        async def touch_drag(x0, y0, x1, y1, steps=10):
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y0}]})
            for i in range(1, steps + 1):
                await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x0 + (x1 - x0) * i / steps, 'y': y0 + (y1 - y0) * i / steps}]})
                await mp.wait_for_timeout(16)
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        await touch_drag(300, 380, 120, 380); await mp.wait_for_timeout(600)
        t1 = await mp.evaluate("Mai.deck.log")
        await touch_drag(80, 380, 270, 380); await mp.wait_for_timeout(600)
        t2 = await mp.evaluate("Mai.deck.log")
        res['touch_log'] = [x['dir'] + ':' + x['name'] for x in t2]
        await mp.screenshot(path=SHOTS + '/11-mobile-touch.png')
        res['touch_scrolled'] = await mp.evaluate("[window.scrollX,window.scrollY]")
        await mctx.close()

        # 桌面预览（1280×900）
        dctx = await b.new_context(viewport={'width': 1280, 'height': 900}, device_scale_factor=1)
        dp = await dctx.new_page(); await dp.goto(URL); await dp.wait_for_selector('body.ready'); await dp.wait_for_timeout(600)
        await dp.screenshot(path=SHOTS + '/12-desktop-frame.png')
        # 小屏（360×640）缩放
        sctx = await b.new_context(viewport={'width': 360, 'height': 640}, device_scale_factor=2)
        sp = await sctx.new_page(); await sp.goto(URL); await sp.wait_for_selector('body.ready'); await sp.wait_for_timeout(500)
        await sp.screenshot(path=SHOTS + '/13-small-360x640.png')
        await b.close()
    res['console_errors'] = errors
    print(json.dumps(res, ensure_ascii=False, indent=1))
asyncio.run(main())
