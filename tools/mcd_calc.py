#!/usr/bin/env python3
"""mcd_calc.py — 服务端脚本：只调用麦当劳 MCP 的 calculate-price（只读算价）。
token 从环境变量 MCD_MCP_TOKEN 或 MCD_MCP_TOKEN_FILE 指向的文件读取，只在本进程内存里用，不打印、不写入任何输出文件。
白名单：只允许 initialize / tools/call(calculate-price)。绝不调用 create-order 等会真实下单的接口。"""
import json, os, sys, time, urllib.request, urllib.error

URL = 'https://mcp.mcd.cn'
TOKEN_FILE = os.environ.get('MCD_MCP_TOKEN_FILE', '')
ALLOWED_TOOLS = {'calculate-price'}
_tok = None
_id = [100]

def _token():
    global _tok
    if _tok is None:
        _tok = (os.environ.get('MCD_MCP_TOKEN') or '').strip() or open(TOKEN_FILE).read().strip()
    return _tok

def _post(payload, timeout=30):
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), method='POST', headers={
        'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer ' + _token()})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode('utf-8', 'replace')
            ct = r.headers.get('Content-Type', '')
    except urllib.error.HTTPError as e:
        return {'_http': e.code, '_body': e.read().decode('utf-8', 'replace')[:300]}
    except Exception as e:      # 超时 / 网络抖动：当作可重试的失败
        return {'_http': 0, '_body': type(e).__name__}
    if 'event-stream' in ct:
        for line in body.splitlines():
            if line.startswith('data:'):
                body = line[5:].strip(); break
    return json.loads(body) if body.strip() else {}

def init():
    return _post({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
        'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'maimai-price-precompute', 'version': '1'}}})

def call(tool, args):
    if tool not in ALLOWED_TOOLS:
        raise SystemExit('blocked tool: ' + tool)
    _id[0] += 1
    r = _post({'jsonrpc': '2.0', 'id': _id[0], 'method': 'tools/call', 'params': {'name': tool, 'arguments': args}})
    if '_http' in r: return {'ok': False, 'http': r['_http'], 'msg': r['_body']}
    res = r.get('result', {})
    sc = res.get('structuredContent')
    if sc is None:
        try: sc = json.loads(res['content'][0]['text'].split('## Original Response')[-1].strip())
        except Exception: sc = {'raw': str(res)[:300]}
    return {'ok': bool(sc.get('success')), 'code': sc.get('code'), 'msg': sc.get('message'), 'data': sc.get('data'), 'dt': sc.get('datetime')}

def calc(items, beType=1, store='1450127', tableware=False):
    args = {'storeCode': store, 'orderType': 1 if beType == 1 else 2, 'beType': beType, 'items': items}
    return call('calculate-price', args)

if __name__ == '__main__':
    print(json.dumps(init().get('result', {}).get('serverInfo', {}), ensure_ascii=False))
    print(json.dumps(calc([{'productCode': '521952', 'quantity': 1}]), ensure_ascii=False, indent=1)[:1500])
