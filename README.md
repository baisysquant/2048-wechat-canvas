2048  - 纯原生微信小游戏

**零依赖，纯 TypeScript + Canvas 2D**，直接放入微信开发者工具即可运行。

## 项目结构

```
minigame-native/
├── game.js          # 入口文件（含核心逻辑、渲染、广告SDK）
├── game.json        # 微信小游戏配置
├── project.config.json  # 开发者工具项目配置
└── README.md
```

## 核心特性

| 特性 | 说明 |
|------|------|
| **包体大小** | ~15 KB (gzipped ~5 KB) |
| **启动速度** | 即开即用，无加载等待 |
| **运行环境** | 微信小游戏 Canvas 2D 模式 |
| **广告变现** | 激励视频广告（复活机制） |
| **数据持久** | 最高分本地存储 |
| **触控支持** | 滑动移动，自适应屏幕 |

## 广告机制（复活）

**触发时机**：游戏结束弹窗 → 点击「看广告复活」→ 播放激励视频 → 观看完成 → 继续游戏

```javascript
// game.js 中的关键配置
const adUnitId = 'adunit-xxxxxxxx'; // ⚠️ 必须替换为你在微信公众平台申请的激励视频广告位 ID

// 广告生命周期
1. 启动 2 秒后自动预加载 loadRewardedAd()
2. 游戏结束显示「看广告复活」按钮
3. 点击按钮 → showRewardedAd() 展示广告
4. onClose 回调中判断 res.isEnded
5. 观看完成 → onAdReward() 复活继续游戏
6. 广告关闭后自动预加载下一条
```

## 快速开始

### 1. 微信开发者工具导入
```
打开微信开发者工具
→ 导入项目
→ 选择 minigame-native 目录
→ AppID 填入你的小游戏 AppID
→ 点击确定
```

### 2. 配置广告位 ID
编辑 `game.js` 第 480 行左右：
```javascript
const adUnitId = 'adunit-xxxxxxxx'; // 替换为你的激励视频广告位 ID
```
在微信公众平台 → 流量主 → 激励视频 创建广告位获取。

### 3. 编译预览
点击工具栏「编译」→ 「预览」→ 真机调试

## 游戏逻辑核心

### 网格系统
- 4x4 网格
- 滑动合并相同数字
- 新生成 2 (90%) 或 4 (10%)

### 评分系统
- 合并得分 = 新数字值
- 最高分本地持久化

### 判胜负
- 胜利：出现 2048（可继续游戏）
- 失败：无空位且无法合并

## 性能优化

- **requestAnimationFrame** 游戏循环
- **脏矩形渲染**（全量重绘，4x4 网格开销极小）
- **对象复用** Tile 对象池
- **CSS 变换动画** 用 scale/position 插值代替重排

## 适配说明

| 设备 | 适配策略 |
|------|---------|
| iPhone SE (375pt) | 自动缩放棋盘 |
| iPhone 14 Pro (393pt) | 居中显示，边距自适应 |
| iPad (768pt+) | 棋盘最大 452px，居中 |
| 横屏 | 强制竖屏 (game.json deviceOrientation) |

## 扩展建议

1. **分享拉新** - `wx.shareAppMessage()` 分享得复活机会
2. **排行榜** - `wx.getFriendCloudStorage()` 好友榜
3. **数据上报** - `wx.getRealtimeLogManager()` 监控
4. **分包加载** - 图片/音效放子包，首包 < 200KB

## 许可证

MIT
