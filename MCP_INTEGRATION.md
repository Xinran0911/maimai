# MCP 接入说明

## 1. 接入的 MCP 服务
- 服务：麦当劳 MCP，`https://mcp.mcd.cn`（Streamable HTTP，JSON-RPC `tools/call`）。
- 鉴权：`Authorization: Bearer <token>`。token 只从服务端环境变量 `MCD_MCP_TOKEN`（或 `MCD_MCP_TOKEN_FILE` 指向的文件）读取，不写进代码、前端、日志或仓库。配置格式见 [mcp-config.example.json](mcp-config.example.json)。
- 实现位置：`lib/mcp.js`（客户端和只读白名单）、`lib/tools.js`（把 MCP 能力包装成大模型可调用的工具）、`lib/agent.js`（DeepSeek function calling 循环）。

## 2. 使用的 MCP 工具（全部只读）
| MCP tool | 用途 |
|---|---|
| `list-nutrition-foods` | 查询餐品热量、蛋白质、脂肪、碳水等营养数据，用来按「健身高蛋白」「想清淡」配餐、回答「这个多少卡路里」 |
| `calculate-price` | 给配好的套餐算价（含优惠），餐卡和结算页显示的价格以它为准 |
| `available-coupons` / `query-store-coupons` | 查询可用优惠券和门店优惠，餐卡上展示优惠信息 |
| `query-nearby-stores` / `now-time-info` / `campaign-calendar` | 门店、当前时间、活动日历（白名单内，用于门店信息和时段提示） |

代码里的白名单（`lib/mcp.js`）之外的工具一律拒绝。**不会调用** `create-order`、`cancel-order`、自动领券等会产生真实订单、扣款或领券的接口。支付环节是「真算价、假支付」的演示。

## 3. 调用流程
```
用户语音/文字 ──► POST /api/agent（server.js）
   └─► lib/agent.js：DeepSeek function calling（最多 4 轮）
         ├─ recommend_meal / edit_meal / next_card  → 本地配餐算法（recommend.js、sets.js），按状态、人数、预算选套餐
         ├─ get_nutrition   → MCP list-nutrition-foods
         ├─ calculate_price → MCP calculate-price
         ├─ query_coupons   → MCP available-coupons / query-store-coupons
         └─ add_to_cart / open_cart / checkout → 只返回界面指令，由前端执行
   └─► 返回口语化回复 + 餐卡意图 + 界面动作 → 前端用本地代码重算餐卡并渲染
```
- 价格、热量等数字只来自工具结果（MCP 或本地缓存），大模型回复里的数字会被校验，对不上就重写或丢弃。
- MCP 或大模型不可用、超时时，自动退回本地缓存数据和规则解析，界面无感。
- 线上静态体验版（GitHub Pages）没有服务端，不含密钥，直接使用仓库里随附的 MCP 数据快照（`data/`，由 MCP 实拉的菜单、营养和算价结果）和本地规则解析。

## 4. 业务价值
- 把「今天吃什么」这个选择困难，变成说一句话就得到一套带热量、价格和优惠的搭配，缩短点餐决策时间。
- 首页按新品、爆款两条顺序展示，帮助用户发现想吃的单品；语音改单（「换成可乐」）让调整更自然。
- 营养信息透明展示，帮助想控制摄入的用户做更合适的选择，不鼓励过量进食。
