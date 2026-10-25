# 麦麦帮你点（麦麦）

> 麦当劳程序员节创意开发大赛参赛作品。由参赛者独立开发，**非麦当劳官方产品**；输出仅供参考，不构成医疗、营养或其他专业建议，餐品信息、价格及供应状态以麦当劳官方渠道的实时结果为准。

**一句话**：对「懂你的导购」说一句今天的状态（比如「今天健身了来点高蛋白」「昨天吃得油腻想清淡」「3 个人预算 100」），麦麦用麦当劳 MCP 的真实菜单、营养和价格，给你配好一套餐卡，还能语音改单（「换成可乐」），最后进购物车、结算（真算价、假支付）。

**在线体验**：https://xinran0911.github.io/maimai/ ，请用 Safari / Chrome 打开（语音需要 https 和浏览器的麦克风权限，小红书、微信内置浏览器可能不支持，请选「在浏览器打开」；不支持时可以打字）。线上版是纯静态版本，用本地规则理解意图；完整的大模型 Agent 需要自行运行 `node server.js`（见下）。

## 文档
- [CONTEST_DECLARATION.md](CONTEST_DECLARATION.md) 参赛声明
- [MCP_INTEGRATION.md](MCP_INTEGRATION.md) MCP 接入说明
- [mcp-config.example.json](mcp-config.example.json) 配置示例（仅环境变量占位符，不含任何真实密钥）

---

# 麦麦帮你点 · 步骤 1+2+3：首页 + 语音点餐对话 + 购物车/结算/假支付（纯静态）

麦当劳主题移动端点餐助手 Demo「麦麦帮你点」。步骤 1 = 首页抽卡；步骤 2 = 按住说话 → 真实语音识别 → 对话 → 套餐餐卡 → 加入购物车。步骤 3 = 购物车页 → 结算页 → 假支付 → 支付成功（取餐码）。

## 打开（语音识别需要 localhost 或 https）
```
./serve.sh        # = python3 -m http.server 8765
```
然后用 **Chrome / Edge** 打开 http://localhost:8765/ ，首次按住说话时允许麦克风。
- 直接双击 index.html（file://）能看界面，但语音识别可能反复弹权限/不可用，会自动降级成打字输入。
- 桌面浏览器居中显示 390×844 手机框；键盘：首页 ← → 翻页、Backspace 反悔；对话页同理（输入框内不触发）。

## 大模型 Agent（DeepSeek function calling + 麦当劳 MCP 只读工具）
「听懂用户说话」不再只靠关键词：`server.js`（零依赖 Node，内置 http + fetch）托管页面并提供 `POST /api/agent`，服务端用 **DeepSeek（deepseek-chat，function calling，最多 4 轮工具调用）** 做点餐 Agent：能配餐、改单、查热量、算价、查优惠/门店、帮你放进购物车/带你去结算，也能回答任何闲聊/热量/怎么吃/过敏等问题（简短口语，事实只用工具结果）。

### 启动
```
DEEPSEEK_API_KEY=你的key node server.js        # 默认 http://localhost:18090/ ；PORT=xxxx 改端口，HOST=0.0.0.0 才对局域网开放
```
- key **只从环境变量读取**，不写进任何文件/前端/日志；前端永远拿不到 key。麦当劳 MCP token 同理（环境变量 `MCD_MCP_TOKEN`，或 `MCD_MCP_TOKEN_FILE` 指向的文件，仅服务端读取）。
- **没有 key / 离线 / 超时 / 出错 / 静态打开（file:// 或单文件版）→ 自动退回本地规则解析**（`js/intent.js`），界面无感。`?llm=0` 强制规则模式（回归测试用）。
- 界面上没有任何「来源」标记；调试：`Mai.lastIntentSource === 'llm' | 'rule'`（console.debug）。

### 架构
```
 语音(Web Speech) / 打字 / 标签按钮
            │  chat.js: 「想一想」动效持续到服务端返回（≥1.2s，上限≈8.5s）
            ▼
   POST /api/agent  {最近若干轮对话, 当前餐卡/购物车/上一次意图}      ← 无 key/超时/失败 → 回退 intent.js 规则解析
            │  server.js（限流、校验、NDJSON 进度）
            ▼
   lib/agent.js ── DeepSeek（function calling，≤4 轮）◄──► 工具（lib/tools.js、lib/engine.js）
                                                          │ recommend_meal   → 本地 MaiRec + sets.js（和浏览器同一份代码）
                                                          │ edit_meal / next_card → sets.applyEdit（只换一行）
                                                          │ get_nutrition    → 麦当劳 MCP list-nutrition-foods（失败退回缓存）
                                                          │ calculate_price  → 麦当劳 MCP calculate-price（失败退回 prices.js 预计算表）
                                                          │ query_coupons    → MCP available-coupons / query-store-coupons（失败退回券快照）
                                                          │ store_info       → 演示店快照（陆家嘴明珠环 1450127）
                                                          └ add_to_cart / open_cart / checkout → 只返回 UI 指令
            ▼
   {reply 口语文案, card 意图, actions[], toolsUsed[]}
            ▼
   前端用 card.intent 在本地重算餐卡（recommend.js + sets.js + pricing.js：价格/营养真算）→ stack.js 叠层餐卡 → 气泡显示 reply；actions 逐个执行（加购/打开购物车/去结算/翻下一套）
```
- **MCP 只读白名单**（`lib/mcp.js`）：`list-nutrition-foods`、`calculate-price`、`query-store-coupons`、`available-coupons`；**绝不调用** create-order / cancel-order / 自动领券等有副作用的接口。营养数据首次调用后内存缓存 30 分钟，服务启动时预热。
- 每个工具结果都标注来源：`mcp`（真调了麦当劳 MCP）/ `cache`（MCP 不可用，退回缓存）/ `local`（本地算法），见响应里的 `toolsUsed`。
- **支付仍是「真算价、假支付」**：麦当劳 MCP 没有开放支付，agent 只会「放进购物车 / 带你去结算页」，要用户自己在结算页点「支付」；系统提示禁止声称已扣款或已在麦当劳下单；购物车和餐卡都为空时先问想吃什么，不直接下单。

### 大模型负责什么 / 不负责什么
| 负责 | 不负责 |
|---|---|
| 理解口语意图（口味/状态/人数/预算/忌口/换哪一项）→ 选工具、填参数 | 价格、优惠、热量、营养数字（一律来自工具：本地算法 / MCP） |
| 用口语、亲切的短话（≤3 句）回答与解释；闲聊/问答/回问 | 凭空编造菜单外的菜品、价格、过敏原结论 |
| 听不懂时回问并给方向 | 真实下单/扣款（演示是假支付） |
服务端还会校验回复：回复里出现的数字必须能在工具结果/当前状态/用户原话里找到，否则让模型重写或丢掉那一句。


## 语音识别（Web Speech API）
`lang: zh-CN`，按下开始、松手结束，识别中文字实时显示在收音浮层（interimResults）。**以下环境不可用，会自动降级**为「打字输入」框 + 3 个示例 chip（点 chip 等同识别结果）；对话栏左侧键盘键随时可切到打字：
- 无 SpeechRecognition 的浏览器（Firefox；部分 Safari 版本）、部分微信/App 内置 WebView
- 非 localhost 的 http:// 页面（不安全上下文）
- 断网（Chrome 的识别在云端）；拒绝麦克风权限；无麦克风；无头 Chrome

## 结构
```
index.html          首页 + 对话页骨架（#chat）
css/app.css         样式
js/config.js        可调项：DEMO_NOW、门店、头像、叠卡几何、手势/语音阈值
data/meals.js       真实菜单 window.MEALS（门店 1450127，42 道）
js/recommend.js     推荐算法 MaiRec（未改）
js/data.js          首页卡片视图模型
js/cart.js          购物车 store：Mai.cart（localStorage maimai.cart.v1）；步骤 3 增补勾选 row.sel、改数量、删行/删组、selectedRows、removeSelected
js/pricing.js       步骤 3 算价 Mai.pricing.quote：先查预计算的实算价表，查不到再本地预估（见下「价格」）
js/shop.js          步骤 3 购物车页 / 结算页 / 支付中 / 支付成功页（#cartPage #coPage #okPage #payOv），订单记在 localStorage maimai.orders.v1
data/prices.js      预计算价格表 window.MAI_PRICES（由 tools/precompute_prices.py 生成；同内容 data/prices.json）
tools/              仅服务端脚本，不被页面加载：mcd_calc.py（只读 calculate-price 封装）、harvest_sets.py、precompute_prices.py、probe.py、singles.py
js/ui.js            舞台缩放、toast、购物车角标（首页/对话页共用）、飞入动画
js/deck.js          首页叠卡
js/sets.js          套餐生成：按意图组合 1 主餐/套餐 + 配菜，券价逐件分摊，合计=各行之和，换单品改单
js/intent.js        中文意图解析：健身高蛋白/油腻后清淡/N 人预算/便宜/不辣/想吃鸡/牛肉/吃得饱…；解析不了→反问
js/speech.js        Web Speech 封装 Mai.speech（错误归类 unsupported/insecure/denied/network/nomic）
js/stack.js         对话页餐卡叠放：拖动跟手/阈值翻页/回弹/↩ 反悔（左滑=新序，右滑=爆序）
js/chat.js          对话：气泡、导购话术、餐卡、语音改单、加入购物车、降级与反问
js/voice.js         首页与对话页「按住说」：收音浮层、上滑取消、过短提示
js/agent.js         前端调用 /api/agent（NDJSON 进度、8.5s 超时、失败回退；?llm=0 关闭）
js/main.js          启动
server.js           Node 服务：静态托管 + /api/agent + /api/health（零依赖）
lib/engine.js       在 Node 里加载前端同一份 recommend/sets/pricing/intent（vm 沙箱），供工具使用
lib/tools.js        Agent 工具：配餐/改单/营养/算价/优惠/门店/购物车指令
lib/mcp.js          麦当劳 MCP 只读客户端（白名单，token 仅服务端）
lib/agent.js        DeepSeek function calling 循环、系统提示、数字校验
data/nutrition_mcp_snapshot.json  营养数据缓存（MCP list-nutrition-foods 的快照，MCP 不可用时用）
assets/             菜品图、字体（Noto Sans SC Black 子集，含「麦麦帮你点」）、avatar.jpg（豆豆 256px）
shots/              自测截图（step3-*.png、step2-*.png、步骤1 01–13）
tests/selftest.py        步骤 1 自测
tests/selftest_step2.py  步骤 2 自测（场景 a–h；Web Speech 仅在测试里 mock，产品代码无 mock）
tests/selftest_llm.py    大模型 Agent 自测：起 server.js、真调 DeepSeek（需 DEEPSEEK_API_KEY）；配餐/改单/查热量/下单/问答/回退/密钥不泄露
tests/selftest_step3.py  步骤 3 自测（不用语音：打字/写 localStorage 预置购物车；加购→购物车→勾选→结算→支付成功→清出/保留）
serve.sh
```

## 自测
```
python3 tests/selftest.py
python3 tests/selftest_step2.py     # 用 /usr/bin/google-chrome，输出 shots/step2-*.png 与 shots/step2-scenarios.json
python3 tests/selftest_llm.py       # 需要环境变量 DEEPSEEK_API_KEY；会在后台起 server.js 并在结束时关掉
# 前三套自测都用 ?llm=0（规则模式）打开页面，不依赖网络/key
python3 tests/selftest_step3.py     # 步骤 3，输出 shots/step3-*.png；要求 console 无 error/warning、无 4xx 请求
```

## 数据与约定
- `DEMO_NOW = '2026-10-22 13:54'`（两张券 10-23 过期）；`USE_REAL_NOW:true` 切回真实时间。
- 价格全部来自菜单 currentPrice + 券逻辑；「王牌炸鸡任选2」券为 assumed，按单件 ¥9.95 计；营养为估算，标「约」。
- 菜单里没有牛奶、早餐品类；「早餐」按清淡处理并提示。

## 步骤 3：购物车 → 结算 → 假支付
- **入口**：首页右上角购物车、对话页购物车角标 → 购物车页（页头沿用「豆豆头像 + 气泡标题」，无红色 M 标）。
- **购物车页**：按「套餐 / 单品」分组；每行勾选框（确认这道菜）、± 数量（减到 0 = 删除）、删除；组头可整组勾选/删除；底栏 = 全选 + 勾选项的 原价 / 优惠 / 应付 + 唯一的「去结算」按钮（没勾选时置灰）。勾选状态存进 localStorage（`row.sel`，缺省=勾选）。
- **结算页**：门店 陆家嘴明珠环 1450127（地址/营业时间取自门店查询结果）、**到店取餐**（堂食/外带）、菜品明细、优惠券、金额明细、「确认支付」。「麦乐送」只是占位：点了 toast「演示版暂未开放」，没有编造配送费/送达时间/排队人数。
- **假支付**：「确认支付」→「支付中…」遮罩 1.4 秒 → 支付成功页（取餐码、门店、已点菜品、实付、「返回首页」）。**只结算勾选的菜**：已结算的从购物车清出，未勾选的留在购物车。订单只写 `maimai.orders.v1`（带 `demo:true`），**没有调用 create-order 等任何会真实下单的接口，也不扣款**。

### 价格：哪些是实算，哪些是预估
浏览器拿不到、也不应该拿到麦当劳 MCP 的 token，所以**价格是预先在服务端算好的静态表**：
- `tools/precompute_prices.py` 用 `tools/mcd_calc.py`（**白名单只放行只读的 `calculate-price`**，token 只在进程内存里读取，不打印、不写入前端）对 725 个组合逐一核价（单品 ×1/×2、推荐算法产出的各套及其子集），结果写成 `data/prices.json` / `data/prices.js`（`meta.generatedAt` 是核价时间；684 个成功，41 个因含售罄商品返回 60006）。
- `Mai.pricing.quote` 的查询顺序：① 整单组合 key（`code:qty|code:qty`，code 排序）→ ② 按「套」分组逐套核价后相加 → ③ 逐菜品（该菜品+数量）核价后相加（已核对：表里 575 个多品组合与这一相加结果完全一致）→ ④ 都没有才用 recommend.js / sets.js 的菜单价本地预估。
- 界面徽标：**实算** = 商品价全部来自 calculate-price，且没有券；**商品价实算 · 券预估** = 商品价实算，券抵扣是本地估算；**预估** = 整单本地估算。
- **券永远是预估**：calculate-price 校验券有效期，而演示时钟固定在 `DEMO_NOW = 2026-10-22 13:54`，真实今天（2026-10-25）那两张券已过期（600012），所以真实接口不可能算出券后价；券抵扣按 sets.js 的本地逻辑估算（「王牌炸鸡任选2」仍是 assumed ¥9.95）。
- **价格与菜单不一致的地方（以核价为准，结算页有「核价后价格有变」提示）**：麦咖啡奶铁（507409）核价 ¥25，菜单为 ¥9.9；咸蛋黄鸡腿蛋月堡（521900）及其三件套（9900015850）在核价时「售罄/不可售」，结算页会提示「暂不可售」，演示支付仍放行。
- 重新生成价格表：`cd tools && python3 precompute_prices.py`（需要环境变量 `MCD_MCP_TOKEN`；可续跑；约 2 s/次调用，限 600 次/分钟）。数据过一阵会过时——重新跑一遍即可。
