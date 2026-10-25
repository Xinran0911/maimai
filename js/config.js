/* 麦麦帮你点 · 配置（所有可调项都在这里） */
window.MAIMAI_CONFIG = {
  /* ── 演示用“当前时间” ──────────────────────────────────────────────
   * 推荐算法用时间判断：券是否过期、活动日历、正餐/下午茶时段。
   * 演示数据（meals.js / DEFAULT_COUPONS）抓取于 2026-10-22 13:54，两张券 2026-10-23 到期，
   * 如果用真实“今天”，券已失效、首页就看不到任何优惠信息。
   * 所以演示固定在数据抓取时刻。上线/接真实接口时：把 USE_REAL_NOW 改为 true 即用设备当前时间。 */
  DEMO_NOW: '2026-10-22 13:54',
  USE_REAL_NOW: false,

  /* 门店（演示店：麦当劳上海陆家嘴明珠环餐厅 1450127） */
  store: { code: '1450127', shortName: '陆家嘴明珠环' },

  /* 顶部头像位 + 对话页 agent 气泡头像：戴 M 帽的服务生豆豆（256px）。src 填图片路径即显示，留空则不显示头像 */
  avatar: { src: 'assets/avatar.jpg' },

  /* 叠卡几何 */
  deckLayout: {
    peek: 18,          // 两侧卡露出的边缘宽度 px（需求 14-20；Figma 静态稿是约 64，想对齐设计稿改成 64）
    sideScale: 0.9,    // 两侧卡缩放（略小）
    sideDrop: 24,      // 两侧卡下沉 px（略低）
    sideRotate: 4,     // 两侧卡微倾角度
    startCenter: 'firstDeal' // 起手居中卡：'firstDeal' = 爆品序里第一张带券/特价的；'first' = 爆品序第 1 张
  },

  /* 手势 */
  swipe: {
    commitDistance: 84,   // 松手时位移超过它就翻页
    commitVelocity: 0.45, // 或者速度(px/ms)超过它且位移>30
    dragStart: 6          // 超过多少 px 才算“拖动”（以内算点击）
  },

  /* 语音按住 */
  voice: {
    cancelDistance: 90,   // 上滑超过多少 px 进入“取消”态
    minHoldMs: 450        // 按住不足这个时长，提示“说话时间太短”
  }
};
