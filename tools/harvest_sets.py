"""harvest_sets.py — 用无头 Chrome 打开 Demo，按一批常见说法让 sets.js 出套，收集所有套的菜品组合（供 precompute_prices.py 实算）。"""
import asyncio, json, os, sys, threading, functools, http.server, socketserver
from playwright.async_api import async_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
srv = socketserver.TCPServer(('127.0.0.1',0), functools.partial(Q, directory=ROOT)); PORT=srv.server_address[1]
threading.Thread(target=srv.serve_forever,daemon=True).start()
QUERIES = ['我今天健身了，来点高蛋白的','昨天吃得油腻，今天想清淡点','3个人预算100','2个人预算80','4个人预算150','一个人预算30','来点便宜的','想吃鸡','想吃牛肉','不辣的','吃得饱一点','来点提神的','想吃鱼','高蛋白不要辣','清淡一点便宜点']
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(); await pg.goto(f'http://127.0.0.1:{PORT}/index.html'); await pg.wait_for_selector('body.ready')
        out = await pg.evaluate("""(Q)=>{const res=[];Q.forEach(q=>{const P=Mai.intent.parse(q,{hasStack:false,last:null}); if(P.kind==='clarify'||P.kind==='empty'||P.kind==='edit')return;
          const bd=Mai.sets.build(P); [].concat(bd.hot,bd.new).forEach(s=>res.push({q:q,rows:s.rows.map(r=>({code:r.code,qty:r.qty}))}));});
          const dishes=Mai.built? null:null; return res;}""", QUERIES)
        await b.close()
    json.dump(out, open('/tmp/harvest.json','w'), ensure_ascii=False)
    sigs = {'|'.join(sorted(f"{r['code']}:{r['qty']}" for r in s['rows'])) for s in out}
    print(len(out),'sets;',len(sigs),'unique combos')
asyncio.run(main())
