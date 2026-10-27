/**
 * FK2048 核心模块：游戏实例 / 棋盘与移动逻辑 / 布局渲染 / 输入 / 难度选择
 * 功能已按模块拆分（src/ 目录）：
 *   config.js  全局常量与调测开关
 *   tile.js    方块实体
 *   special.js 特技加速（闪烁机会 / 特技池 / 广告闭环 / 绘制）
 *   ads.js     微信广告 SDK 初始化 / 加载 / 场景路由
 *   undo.js    后悔回撤（回撤5步 / 免费次数 / 广告生效 / 绘制）
 * 无引擎依赖，包体 < 200KB，直接可在微信开发者工具运行
 */

// 双环境加载：微信小游戏用 require，浏览器测试用 window 上的全局模块
const FK = (typeof require === 'function')
    ? {
        cfg: require('./src/config.js'),
        Tile: require('./src/tile.js'),
        special: require('./src/special.js'),
        ads: require('./src/ads.js'),
        undo: require('./src/undo.js')
    }
    : {
        cfg: window.FK_CONFIG,
        Tile: window.FK_TILE,
        special: window.FK_SPECIAL,
        ads: window.FK_ADS,
        undo: window.FK_UNDO
    };

const {
    DEBUG_SKIP_AD,
    TILE_SIZE, GAP, DEFAULT_GRID_SIZE, DIFFICULTY_SAVE_KEY,
    ANIM_SCALE_SPEED, ANIM_MOVE_SPEED, ANIM_MERGE_POP_SPEED, ANIM_FADE_SPEED, ANIM_POS_THRESHOLD,
    TITLE_FONT_SIZE, TITLE_MARGIN, SCORE_BOX_W, SCORE_BOX_H, SCORE_LABEL_Y, SCORE_VALUE_Y,
    BOARD_ADJACENT_GAP, BOARD_TOP_MARGIN, BOARD_SIDE_MARGIN, BOARD_BOTTOM_RESERVE,
    SPECIAL_TRIGGER_VALUE,
    UNDO_STEPS, UNDO_FREE_COUNT, UNDO_HISTORY_CAP, UNDO_ROW_GAP,
    GameState, StateTransitions, COLORS
} = FK.cfg;

const Game2048 = (function () {
    'use strict';

    class Game {
        constructor(canvas) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.width = canvas.width;
            this.height = canvas.height;

            this.gridSize = DEFAULT_GRID_SIZE;  // 可通过难度弹框切换 4 或 5
            this.grid = [];
            this.tiles = [];
            this.score = 0;
            this.bestScore = 0;
            this._state = GameState.IDLE;       // 打开游戏先展示难度弹框
            this.tileIdCounter = 0;
            this.wonShown = false;

            this.touchStartX = 0;
            this.touchStartY = 0;

            // 后悔回撤状态
            this._undoHistory = [];             // [{ grid, score }]：每步移动前的快照
            this._undoFreeLeft = UNDO_FREE_COUNT; // 每盘局免费次数

            this.adLoaded = false;
            this.adLoading = false;
            this._adInitialized = false;
            this._adLoadPromise = null;
            this._adPurpose = null;
            this._adLoadTimer = null;
            this._adWatchdog = null;

            // 特技加速状态
            this.specialPool = [];          // FIFO 队列 [{ id, value, ts }]
            this.specialPending = null;     // 棋盘上正在倒计时的机会
            this._specialTriggered = 0;     // 本局已获得次数
            this._specialIdSeq = 1;
            this._specialFlyers = [];       // 入池飞行动画
            this._specialFloatTexts = [];   // 飘字特效
            this.specialPanelOpen = false;
            this._specialScroll = 0;
            this._specialScrollDrag = null;
            this._specialTouchMode = null;
            this._specialTouchConsumed = false;
            this._specialAdBusy = false;
            this._specialPendingItemId = null;
            this._specialCooldownUntil = 0;
            this._specialAdWatchdog = null;
            this._specialFreeUsed = false;  // 每局首次特技免广告

            // 难度弹框
            this._difficultyButtons = null;
            this._lastDifficulty = null;
            this._difficultyDefs = [
                { label: '经典 4X4', size: 4 },
                { label: '挑战 5X5', size: 5 }
            ];

            // 事件绑定幂等标记（避免 onShow 重入产生幽灵 handler）
            this._eventsBound = false;

            // 结算弹窗配置缓存（避免每帧重建数组与闭包）
            this._overlay = null;

            // 对话框/弹窗文字入场动画：打开时从下方上浮 + 淡入
            this._dialogAnimStart = 0;
            this._dialogAnimDuration = 420;

            // 最高分落盘去抖
            this._bestDirty = false;
            this._bestFlushTimer = null;

            // 数字文本缓存（避免每帧 toString）
            this._scoreLabelCache = { v: -1, s: '0' };
            this._bestLabelCache = { v: -1, s: '0' };

            // 字体/样式缓存
            this._fontCache = new Map();
            this._textMetricsCache = new Map();
            this._initFontCache();

            this.init();
        }

        _initFontCache() {
            // 数值键缓存：size*2 + (bold?1:0)，避免每帧拼接字体字符串
            this._defaultFontFamily = 'Arial, "Microsoft YaHei", sans-serif';
            for (let size = 10; size <= 80; size++) {
                for (let bold = 0; bold <= 1; bold++) {
                    const font = `${bold ? 'bold' : 'normal'} ${size}px ${this._defaultFontFamily}`;
                    this._fontCache.set(size * 2 + bold, font);
                }
            }
        }

        getFont(weight, size, family) {
            const bold = weight === 'bold';
            if (!family || family === this._defaultFontFamily) {
                const key = size * 2 + (bold ? 1 : 0);
                return this._fontCache.get(key)
                    || `${bold ? 'bold' : 'normal'} ${size}px ${this._defaultFontFamily}`;
            }
            return `${bold ? 'bold' : 'normal'} ${size}px ${family}`;
        }

        // State Machine
        get state() {
            return this._state;
        }

        setState(newState) {
            const validTransitions = StateTransitions[this._state] || [];
            if (validTransitions.includes(newState) || this._state === GameState.IDLE) {
                console.log(`[State] ${this._state} -> ${newState}`);
                this._state = newState;
            } else {
                console.warn(`[State] Invalid transition: ${this._state} -> ${newState}`);
            }
        }

        isState() {
            // 不用 rest 参数（...states）：微信「增强编译」的 SWC 会为它生成
            // @swc/runtime helper，在小游戏环境不存在，导致 module is not defined
            const states = [].slice.call(arguments);
            return states.includes(this._state);
        }

        get gameOver() { return this._state === GameState.GAME_OVER; }
        get won() { return this._state === GameState.WON; }
        get animating() { return this._state === GameState.ANIMATING; }
        get isPlaying() { return this._state === GameState.PLAYING; }

        measureText(text, font) {
            const key = `${font}|${text}`;
            let metrics = this._textMetricsCache.get(key);
            if (!metrics) {
                this.ctx.font = font;
                metrics = this.ctx.measureText(text);
                this._textMetricsCache.set(key, metrics);
            }
            return metrics;
        }

        // 统一交互提示：红色飘字（替代系统黑色 toast）
        // options: { x, y, duration, size } 均可省略
        showHint(text, options) {
            if (!text) return;
            const o = options || {};
            const msg = String(text);
            const maxW = Math.max(120, this.width - 48);
            const size = o.size || Math.max(14, Math.min(24, Math.floor(maxW / Math.max(1, msg.length))));
            const x = o.x != null ? o.x : this.width / 2;
            const y = o.y != null ? o.y : (this.boardY ? this.boardY - 16 : this.height / 2 - 80);
            if (typeof this.pushFloatText === 'function') {
                this.pushFloatText(msg, x, y, o.duration || 1500, size);
            }
        }

        // 兼容旧调用名
        showToastSafe(title) {
            this.showHint(title);
        }

        // 弹窗文字入场动画：打开时从下方上浮 + 淡入
        beginDialogTextAnim() {
            this._dialogAnimStart = Date.now();
        }

        // 返回 { t, alpha }：t 为 easeOutCubic 缓动进度(0..1)，alpha 为淡入透明度(0..1)
        dialogTextAnim(now) {
            if (!this._dialogAnimStart) return { t: 1, alpha: 1 };
            const raw = Math.min(1, (now - this._dialogAnimStart) / this._dialogAnimDuration);
            return {
                t: 1 - Math.pow(1 - raw, 3),
                alpha: Math.min(1, raw / 0.22)
            };
        }

        init() {
            if (DEBUG_SKIP_AD) {
                console.warn('[调测模式] 已跳过激励视频：复活/特技/回撤奖励直接发放。上线前请将 src/config.js 的 DEBUG_SKIP_AD 改为 false。');
            }
            this.loadDifficultySetting();
            this.loadBestScore();
            this.loadSpecialPool();
            this.resize();
            this.bindEvents();
            this.initAd();
            this.loop();
            this.bindLifecycle();
        }

        // ---------- 难度系统（启动圆角弹框） ----------
        loadDifficultySetting() {
            try {
                const stored = wx.getStorageSync(DIFFICULTY_SAVE_KEY);
                const n = parseInt(stored, 10);
                if (n === 4 || n === 5) this._lastDifficulty = n;
            } catch (e) {
                this._lastDifficulty = null;
            }
        }

        // 选择难度并进入对应棋盘
        selectDifficulty(n) {
            if (n !== 4 && n !== 5) return;
            this.gridSize = n;
            try { wx.setStorageSync(DIFFICULTY_SAVE_KEY, String(n)); } catch (e) { }
            this._lastDifficulty = n;
            this._difficultyButtons = null;
            // 换棋盘重新布局并开局，历史 / 免费次数随 newGame 清空
            this.resize();
            this.newGame();
            this.trackSpecial('difficulty_select', { gridSize: n });
        }

        checkDifficultyTap(x, y) {
            if (!this._difficultyButtons) return;
            for (const btn of this._difficultyButtons) {
                if (this.pointInRect(x, y, btn.rect)) {
                    this.selectDifficulty(btn.size);
                    return;
                }
            }
        }

        drawDifficultyDialog() {
            const ctx = this.ctx;

            // 弹窗重新创建时，文字重新播放入场动画（从下方上浮）
            if (!this._difficultyButtons) this.beginDialogTextAnim();

            // 半透明遮罩
            ctx.save();
            ctx.fillStyle = 'rgba(35, 28, 24, 0.55)';
            ctx.fillRect(0, 0, this.width, this.height);

            // 圆角面板
            const panelW = Math.min(320, this.width - 40);
            const panelH = 320;
            const panelX = (this.width - panelW) / 2;
            const panelY = Math.max(80, (this.height - panelH) / 2);

            ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
            ctx.shadowBlur = 24;
            ctx.shadowOffsetY = 8;
            ctx.fillStyle = 'rgba(250, 248, 239, 0.98)';
            this.roundRect(panelX, panelY, panelW, panelH, 18);
            ctx.restore();

            // 标题 + 副标题：弹出时从下方上浮并淡入
            const anim = this.dialogTextAnim(Date.now());
            const rise = 44;
            ctx.save();
            ctx.globalAlpha = anim.alpha;
            ctx.fillStyle = COLORS.text.dark;
            ctx.font = this.getFont('bold', 26);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('选择难度', panelX + panelW / 2, panelY + 48 + (1 - anim.t) * rise);

            ctx.font = this.getFont('normal', 14);
            ctx.fillStyle = '#9C8B7B';
            ctx.fillText('选择棋盘开始游戏', panelX + panelW / 2, panelY + 78 + (1 - anim.t) * rise);
            ctx.restore();

            // 难度按钮：布局变化时才重建（resize / 选择难度会清空缓存）
            const bw = panelW - 60;
            const bh = 64;
            const bx = panelX + (panelW - bw) / 2;
            if (!this._difficultyButtons) {
                const y1 = panelY + 108;
                const y2 = y1 + bh + 20;
                this._difficultyButtons = this._difficultyDefs.map((def, i) => ({
                    label: def.label,
                    size: def.size,
                    rect: { x: bx, y: i === 0 ? y1 : y2, w: bw, h: bh }
                }));
            }

            for (const btn of this._difficultyButtons) {
                const r = btn.rect;
                const isLast = this._lastDifficulty === btn.size;
                ctx.fillStyle = isLast ? '#F2B179' : '#8F7A66';
                this.roundRect(r.x, r.y, r.w, r.h, 12);

                // 主文字（经典 4X4 / 挑战 5X5）：一行，水平居中
                ctx.fillStyle = COLORS.text.light;
                ctx.font = this.getFont('bold', 22);
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(btn.label, r.x + r.w / 2, r.y + r.h / 2 - 8);

                if (isLast) {
                    // 上次选择的难度打标：第二行，同样水平居中
                    ctx.font = this.getFont('bold', 12);
                    ctx.fillStyle = '#5C4A3A';
                    ctx.fillText('上次使用', r.x + r.w / 2, r.y + r.h / 2 + 16);
                }
            }

            ctx.textAlign = 'left';
        }

        bindLifecycle() {
            wx.onHide(() => {
                this.flushBestScore();
                this.unbindEvents();
                // 未入池的闪烁机会在切后台时直接入池，避免数据丢失
                if (this.specialPending) this.bankPendingSpecial(false);
                this.closeSpecialPanel();
                // 广告播放中被切后台：立即释放锁并清理 loading，避免返回后 UI 悬挂。
                // 特技场景走专用出口（清 _specialAdBusy/_specialPendingItemId 并加冷却），
                // 其余场景走通用出口
                if (this._adPurpose === 'special') {
                    this.failSpecialAd('');
                } else if (this._adPurpose) {
                    this.failGeneralAd(this._adPurpose, '');
                }
            });
            wx.onShow(() => {
                // 确保动画状态重置，避免卡死
                if (this.animating) {
                    this.completeAnimationsImmediately();
                }
                this.resize();
                this.bindEvents();
                // 难度选择阶段还没有棋盘，跳过同步
                if (Array.isArray(this.grid) && this.grid.length === this.gridSize) {
                    this.syncTilesWithGrid();
                }
                // 部分机型切后台会清理 SDK 回调 / 广告实例失效，这里确保广告可用：
                // 实例不存在则重建；实例存在但加载失败则主动重载
                if (!this._adPurpose && !this._specialAdBusy) {
                    if (!this.rewardedAd) {
                        this.initRewardedAd();
                    } else if (!this.adLoaded && !this.adLoading) {
                        this.loadRewardedAd();
                    }
                }
            });
        }

        // 立即完成所有动画，同步状态
        completeAnimationsImmediately() {
            for (const tile of this.tiles) {
                tile.x = tile.targetX;
                tile.y = tile.targetY;
                tile.scale = 1;
                tile.opacity = 1;
                tile.merged = false;
                tile.new = false;
                tile.removing = false;
                tile.mergeScale = undefined;
            }
            this.tiles = this.tiles.filter(t => t.opacity > 0.01);
            this.setState(GameState.PLAYING);
        }

        // 同步 tiles 数组与 grid 状态（以目标格子为准，丢弃多余/幽灵方块）
        syncTilesWithGrid() {
            // 难度选择阶段 grid 尚未建立，直接跳过
            if (!Array.isArray(this.grid) || this.grid.length !== this.gridSize) return;
            const n = this.gridSize;
            const needed = new Map();

            // 收集 grid 中需要的格子
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    const value = this.grid[y][x];
                    if (value !== null && value !== undefined) {
                        needed.set(`${x},${y},${value}`, { x, y, value });
                    }
                }
            }

            // 保留匹配的 tiles，标记位置；其余丢弃
            const newTiles = [];
            for (const tile of this.tiles) {
                if (tile.removing) continue;
                const tx = Math.round(tile.targetX);
                const ty = Math.round(tile.targetY);
                const key = `${tx},${ty},${tile.value}`;
                if (needed.has(key)) {
                    tile.x = tile.targetX = tx;
                    tile.y = tile.targetY = ty;
                    tile.scale = 1;
                    tile.opacity = 1;
                    tile.merged = false;
                    tile.mergeScale = undefined;
                    tile.new = false;
                    newTiles.push(tile);
                    needed.delete(key);
                }
            }

            // 为缺失的 grid 位置创建新 tiles
            // 不用 for...of + 数组解构（[, pos]）：SWC「增强编译」会生成外部 helper 依赖
            for (const entry of needed) {
                const pos = entry[1];
                const newTile = new FK.Tile(pos.value, pos.x, pos.y);
                newTile.id = `tile_${this.tileIdCounter++}`;
                newTile.scale = 1;
                newTile.new = false;
                newTiles.push(newTile);
            }

            this.tiles = newTiles;
        }

        initAd() {
            if (this._adInitialized) return;
            this._adInitialized = true;
            setTimeout(() => this.loadRewardedAd(), 2000);
        }

        // 最高分校验摘要：FNV-1a 快速哈希，防止玩家直接修改本地存储刷分
        static bestDigest(value) {
            let h = 0x811c9dc5;
            const s = 'fk2048:v1:' + value;
            for (let i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = (h * 0x01000193) >>> 0;
            }
            return h.toString(36);
        }

        loadBestScore() {
            try {
                const stored = wx.getStorageSync('fk2048_best');
                if (typeof stored === 'string') {
                    // 兼容旧版本纯字符串存储，并立即迁移为带校验格式
                    this.bestScore = stored ? parseInt(stored, 10) : 0;
                    try {
                        wx.setStorageSync('fk2048_best', {
                            v: String(this.bestScore),
                            c: Game.bestDigest(this.bestScore)
                        });
                    } catch (e) { }
                } else if (stored && stored.v != null && stored.c === Game.bestDigest(stored.v)) {
                    this.bestScore = parseInt(stored.v, 10) || 0;
                } else {
                    this.bestScore = 0;   // 校验失败视为被篡改 / 首次运行
                }
            } catch (e) {
                this.bestScore = 0;
            }
        }

        // 最高分落盘去抖：避免每个破纪录的 move 都触发同步 IO
        markBestDirty() {
            this._bestDirty = true;
            if (this._bestFlushTimer) return;
            this._bestFlushTimer = setTimeout(() => this.flushBestScore(), 2000);
        }

        flushBestScore() {
            if (this._bestFlushTimer) {
                clearTimeout(this._bestFlushTimer);
                this._bestFlushTimer = null;
            }
            if (!this._bestDirty) return;
            this._bestDirty = false;
            try {
                wx.setStorageSync('fk2048_best', {
                    v: String(this.bestScore),
                    c: Game.bestDigest(this.bestScore)
                });
            } catch (e) { }
        }

        // 分数累加：整数安全，超过 2^53 时饱和，避免精度丢失
        addScore(points) {
            const gain = Math.floor(Number(points));
            if (!Number.isFinite(gain) || gain <= 0) return;
            const next = this.score + gain;
            this.score = Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
            if (this.score > this.bestScore) {
                this.bestScore = this.score;
                this.markBestDirty();
            }
        }

        resize() {
            const sysInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
            const dpr = sysInfo.pixelRatio || 1;

            // 显式复位变换，不依赖“重设 canvas 尺寸会重置上下文”的平台差异行为
            this.ctx.setTransform(1, 0, 0, 1, 0, 0);
            this.canvas.width = sysInfo.windowWidth * dpr;
            this.canvas.height = sysInfo.windowHeight * dpr;
            this.width = sysInfo.windowWidth;
            this.height = sysInfo.windowHeight;

            this.ctx.scale(dpr, dpr);
            this.calculateLayout();

            // 布局变化：失效难度弹框与结算弹窗的缓存矩形
            this._difficultyButtons = null;
            this._invalidateOverlayRects();
        }

        calculateLayout() {
            const n = this.gridSize;
            const maxBoardWidth = this.width - BOARD_SIDE_MARGIN * 2;
            const maxBoardHeight = this.height - BOARD_BOTTOM_RESERVE;
            const maxSize = Math.min(maxBoardWidth, maxBoardHeight);

            const boardSize = TILE_SIZE * n + GAP * (n - 1);
            const scale = Math.min(1, maxSize / boardSize);

            this.tileSize = Math.floor(TILE_SIZE * scale);
            this.gap = Math.floor(GAP * scale);
            const actualBoardSize = this.tileSize * n + this.gap * (n - 1);

            this.boardX = (this.width - actualBoardSize) / 2;
            this.boardY = BOARD_TOP_MARGIN + (maxBoardHeight - actualBoardSize) / 2;
            this.boardSize = actualBoardSize;

            // 分数组紧贴棋盘上沿，间距与特技池一致
            this.scoreBoxY = this.boardY - SCORE_BOX_H - BOARD_ADJACENT_GAP;

            // 棋盘正下方一行：左侧「后悔」按钮 + 右侧缩短的特技池，
            // 整行宽度与棋盘左右边框完全对齐
            const rowH = 54;
            const undoW = Math.min(120, Math.max(84, Math.floor((this.boardSize - UNDO_ROW_GAP) * 0.32)));
            const poolW = this.boardSize - undoW - UNDO_ROW_GAP;
            const rowY = Math.min(this.boardY + actualBoardSize + BOARD_ADJACENT_GAP, this.height - rowH - 24);

            this.undoRect = {
                x: this.boardX,
                y: rowY,
                w: undoW,
                h: rowH
            };
            this.specialPoolRect = {
                x: this.boardX + undoW + UNDO_ROW_GAP,
                y: rowY,
                w: poolW,
                h: rowH
            };

            // 棋盘上的闪烁按钮：正方形，控制在单个格子内
            this.specialButtonSize = Math.max(36, Math.min(66, Math.floor(this.tileSize * 0.8)));
            if (this.specialPending) this.positionPending();
        }

        bindEvents() {
            // 幂等：避免 onShow 等路径在未 onHide 时重复注册产生幽灵 handler
            if (this._eventsBound) return;
            this._eventsBound = true;

            this._touchStartHandler = (e) => {
                const touch = e.touches[0];
                this.touchStartX = touch.clientX;
                this.touchStartY = touch.clientY;

                this._specialTouchConsumed = false;
                this._specialTouchMode = null;
                this._specialScrollDrag = null;

                // 「后悔」按钮：优先拦截（游戏结束弹窗时也可点击）
                if (this.pointInRect(touch.clientX, touch.clientY, this.undoRect)) {
                    this._specialTouchConsumed = true;
                    this._specialTouchMode = 'undo';
                    return;
                }

                // 胜利/失败弹窗优先，避免特技池入口抢占
                if (this.overlayButtons) return;
                if (this.specialPanelOpen || this.hitSpecialPending(touch.clientX, touch.clientY) ||
                    this.pointInRect(touch.clientX, touch.clientY, this.specialPoolRect)) {
                    this._specialTouchConsumed = this.handleSpecialTouchStart(touch.clientX, touch.clientY);
                }
            };

            this._touchMoveHandler = (e) => {
                if (!this._specialTouchConsumed) return;
                const touch = e.touches[0];
                if (touch) this.handleSpecialTouchMove(touch.clientX, touch.clientY);
            };

            this._touchEndHandler = (e) => {
                const touch = e.changedTouches[0];
                const x = touch.clientX;
                const y = touch.clientY;
                const moved = Math.abs(x - this.touchStartX) > 12 || Math.abs(y - this.touchStartY) > 12;

                // 难度选择弹框：点击按钮进入对应棋盘
                if (this.isState(GameState.IDLE) && this._difficultyButtons) {
                    if (!moved) this.checkDifficultyTap(x, y);   // 滑动不误触开局
                    return;
                }

                // 「后悔」按钮
                if (this._specialTouchMode === 'undo') {
                    if (!moved) this.tryUndo();
                    this._specialTouchConsumed = false;
                    this.resetSpecialTouch();
                    return;
                }

                if (this.checkOverlayTap(x, y)) {
                    this._specialTouchConsumed = false;
                    this.resetSpecialTouch();
                    return;
                }

                // 点击特技按钮/特技池/弹窗时，拦截触控，禁止下层棋盘响应
                if (this._specialTouchConsumed) {
                    this.handleSpecialTouchEnd(x, y);
                    this._specialTouchConsumed = false;
                    this.resetSpecialTouch();
                    return;
                }

                if (this.animating || this.gameOver || this.won) return;
                const dx = x - this.touchStartX;
                const dy = y - this.touchStartY;

                if (Math.abs(dx) < 30 && Math.abs(dy) < 30) return;

                if (Math.abs(dx) > Math.abs(dy)) {
                    this.move(dx > 0 ? 'right' : 'left');
                } else {
                    this.move(dy > 0 ? 'down' : 'up');
                }
            };

            this._resizeHandler = () => {
                this.resize();
            };

            wx.onTouchStart(this._touchStartHandler);
            wx.onTouchMove(this._touchMoveHandler);
            wx.onTouchEnd(this._touchEndHandler);
            wx.onWindowResize(this._resizeHandler);
        }

        unbindEvents() {
            if (!this._eventsBound) return;
            this._eventsBound = false;
            wx.offTouchStart(this._touchStartHandler);
            wx.offTouchMove(this._touchMoveHandler);
            wx.offTouchEnd(this._touchEndHandler);
            wx.offWindowResize(this._resizeHandler);
        }

        newGame() {
            // 未入池的闪烁机会先入池，再开始新一局，数据不丢失
            if (this.specialPending) this.bankPendingSpecial(false);
            this.closeSpecialPanel();
            this._specialTriggered = 0;
            this._specialFreeUsed = false;  // 新一局重新获得一次免广告体验

            // 新盘局：清空回撤历史，免费次数重置
            this.clearUndoHistory();

            const n = this.gridSize;
            this.grid = Array(n).fill(null).map(() => Array(n).fill(null));
            this.tiles = [];
            this.score = 0;
            this.setState(GameState.PLAYING);
            this.wonShown = false;
            this.clearOverlay();
            this.tileIdCounter = 0;
            this.addRandomTile();
            this.addRandomTile();
        }

        addRandomTile() {
            const n = this.gridSize;
            const empty = [];
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    if (!this.grid[y][x]) empty.push({ x, y });
                }
            }
            if (empty.length === 0) return;

            const pos = empty[Math.floor(Math.random() * empty.length)];
            const value = Math.random() < 0.9 ? 2 : 4;
            this.grid[pos.y][pos.x] = value;
            const tile = new FK.Tile(value, pos.x, pos.y);
            tile.id = `tile_${this.tileIdCounter++}`;
            this.tiles.push(tile);
        }

        move(direction) {
            if (!this.isState(GameState.PLAYING)) return;
            // 广告加载/播放中禁止棋盘操作，避免奖励结算基于被修改的棋盘状态
            if (this._adPurpose || this._specialAdBusy) return;

            // 回撤快照：仅在本步真正移动后入历史
            const snapshot = this.takeUndoSnapshot();

            let moved = false;
            let scoreGained = 0;
            const merges = [];
            const n = this.gridSize;

            if (direction === 'left' || direction === 'right') {
                for (let y = 0; y < n; y++) {
                    const result = this.processLineWithTiles(
                        this.getRowWithTiles(y),
                        direction === 'left'
                    );
                    if (result.moved) moved = true;
                    scoreGained += result.scoreGained;
                    this.setRow(y, result.line.map(t => t ? t.value : null));

                    if (result.merges) {
                        for (const m of result.merges) {
                            merges.push({ x: m.to, y, value: m.value, fromX: m.from, targetId: m.targetId, sourceId: m.sourceId });
                        }
                    }
                    this.animateRowWithIds(y, result.line);
                }
            } else {
                for (let x = 0; x < n; x++) {
                    const result = this.processLineWithTiles(
                        this.getColWithTiles(x),
                        direction === 'up'
                    );
                    if (result.moved) moved = true;
                    scoreGained += result.scoreGained;
                    this.setCol(x, result.line.map(t => t ? t.value : null));

                    if (result.merges) {
                        for (const m of result.merges) {
                            merges.push({ x, y: m.to, value: m.value, fromY: m.from, targetId: m.targetId, sourceId: m.sourceId });
                        }
                    }
                    this.animateColWithIds(x, result.line);
                }
            }

            // Apply merge animations using tile ids
            let specialHits = 0;
            for (const merge of merges) {
                if (merge.value === SPECIAL_TRIGGER_VALUE) specialHits++;
                const targetTile = this.tiles.find(t => t.id === merge.targetId);
                if (targetTile) {
                    targetTile.merged = true;
                    targetTile.mergeScale = 1.2;
                }
                const sourceTile = this.tiles.find(t => t.id === merge.sourceId);
                if (sourceTile && sourceTile !== targetTile) {
                    sourceTile.removing = true;
                    sourceTile.removeTarget = { x: merge.x, y: merge.y };
                }
            }

            if (moved) {
                // 入回撤历史（上限裁剪）
                this._undoHistory.push(snapshot);
                if (this._undoHistory.length > UNDO_HISTORY_CAP) this._undoHistory.shift();

                this.addScore(scoreGained);
                this.setState(GameState.ANIMATING);
                this.addRandomTile();

                // 仅“新生成 512”触发特技机会，1024/2048 等更高等级不触发
                for (let i = 0; i < specialHits; i++) {
                    this.trySpawnSpecial();
                }
            }
        }

        getRowWithTiles(y) {
            const row = [];
            const availableTiles = this.tiles.slice(); // Copy to track used tiles（不用展开符，避免 SWC helper 依赖）
            for (let x = 0; x < this.gridSize; x++) {
                if (this.grid[y][x] !== null) {
                    // 精确位置 + 数值匹配
                    let tileIdx = availableTiles.findIndex(t => Math.round(t.x) === x && Math.round(t.y) === y && t.value === this.grid[y][x]);
                    // 目标位置匹配：方块 target 已就位时也能对上
                    if (tileIdx === -1) {
                        tileIdx = availableTiles.findIndex(t => Math.round(t.targetX) === x && Math.round(t.targetY) === y && t.value === this.grid[y][x]);
                    }
                    // 同值同行匹配
                    if (tileIdx === -1) {
                        tileIdx = availableTiles.findIndex(t => t.value === this.grid[y][x] && Math.round(t.y) === y);
                    }
                    if (tileIdx !== -1) {
                        row.push(availableTiles.splice(tileIdx, 1)[0]);
                    } else {
                        // 兜底：创建真实 Tile 并注册，保证合并/绘制/回收走同一引用，
                        // 避免占位对象与真实方块失去关联导致数值不同步
                        const tile = new FK.Tile(this.grid[y][x], x, y);
                        tile.id = `tile_${this.tileIdCounter++}`;
                        tile.new = false;
                        tile.scale = 1;
                        this.tiles.push(tile);
                        row.push(tile);
                    }
                } else {
                    row.push(null);
                }
            }
            return row;
        }

        getColWithTiles(x) {
            const col = [];
            const availableTiles = this.tiles.slice();
            for (let y = 0; y < this.gridSize; y++) {
                if (this.grid[y][x] !== null) {
                    // 精确位置 + 数值匹配
                    let tileIdx = availableTiles.findIndex(t => Math.round(t.x) === x && Math.round(t.y) === y && t.value === this.grid[y][x]);
                    // 目标位置匹配：方块 target 已就位时也能对上
                    if (tileIdx === -1) {
                        tileIdx = availableTiles.findIndex(t => Math.round(t.targetX) === x && Math.round(t.targetY) === y && t.value === this.grid[y][x]);
                    }
                    // 同值同列匹配
                    if (tileIdx === -1) {
                        tileIdx = availableTiles.findIndex(t => t.value === this.grid[y][x] && Math.round(t.x) === x);
                    }
                    if (tileIdx !== -1) {
                        col.push(availableTiles.splice(tileIdx, 1)[0]);
                    } else {
                        // 兜底：创建真实 Tile 并注册，保证合并/绘制/回收走同一引用
                        const tile = new FK.Tile(this.grid[y][x], x, y);
                        tile.id = `tile_${this.tileIdCounter++}`;
                        tile.new = false;
                        tile.scale = 1;
                        this.tiles.push(tile);
                        col.push(tile);
                    }
                } else {
                    col.push(null);
                }
            }
            return col;
        }

        setRow(y, line) {
            this.grid[y] = line;
        }

        setCol(x, line) {
            for (let y = 0; y < this.gridSize; y++) {
                this.grid[y][x] = line[y];
            }
        }

        processLineWithTiles(line, forward) {
            const tiles = line.filter(t => t !== null);
            const result = new Array(this.gridSize).fill(null);
            const merges = [];
            let moved = false;
            let scoreGained = 0;

            if (tiles.length === 0) {
                return { line: result, moved: false, scoreGained: 0, merges: [] };
            }

            if (forward) {
                // 双指针：read 读取，write 写入
                let write = 0;
                for (let read = 0; read < tiles.length; read++) {
                    const current = tiles[read];

                    // 检查是否可以与下一个合并
                    if (read + 1 < tiles.length &&
                        current.value === tiles[read + 1].value) {
                        // 合并：必须直接更新原 Tile 实例的数值，
                        // 否则 tiles 与 grid 会失去同步（显示旧数字、后续无法合并）
                        const mergedValue = current.value * 2;
                        scoreGained += mergedValue;
                        current.value = mergedValue;
                        result[write] = current;
                        merges.push({
                            from: read + 1,
                            to: write,
                            value: mergedValue,
                            targetId: current.id,
                            sourceId: tiles[read + 1].id
                        });
                        read++; // 跳过下一个（已合并）
                        moved = true;
                    } else {
                        // 不合并，直接移动
                        result[write] = current;
                        if (write !== read) moved = true;
                    }
                    write++;
                }
            } else {
                // 反向：从右向左
                let write = this.gridSize - 1;
                for (let read = tiles.length - 1; read >= 0; read--) {
                    const current = tiles[read];

                    // 检查是否可以与前一个合并
                    if (read - 1 >= 0 &&
                        current.value === tiles[read - 1].value) {
                        // 合并：同样更新原 Tile 实例，保持 tiles 与 grid 一致
                        const mergedValue = current.value * 2;
                        scoreGained += mergedValue;
                        current.value = mergedValue;
                        result[write] = current;
                        merges.push({
                            from: read - 1,
                            to: write,
                            value: mergedValue,
                            targetId: current.id,
                            sourceId: tiles[read - 1].id
                        });
                        read--; // 跳过前一个（已合并）
                        moved = true;
                    } else {
                        // 不合并，直接移动
                        result[write] = current;
                        if (write !== (this.gridSize - 1 - (tiles.length - 1 - read))) moved = true;
                    }
                    write--;
                }
            }

            // 检查是否有移动（位置变化或合并）
            for (let i = 0; i < this.gridSize; i++) {
                const orig = line[i];
                const now = result[i];
                if (!orig && now || orig && !now || (orig && now && orig.id !== now.id)) {
                    moved = true;
                    break;
                }
            }

            return { line: result, moved, scoreGained, merges };
        }

        animateRowWithIds(y, newLine) {
            for (let x = 0; x < this.gridSize; x++) {
                const tileData = newLine[x];
                if (!tileData) continue;

                const tile = this.tiles.find(t => t.id === tileData.id);
                if (tile) {
                    tile.targetX = x;
                    tile.targetY = y;
                }
            }
        }

        animateColWithIds(x, newLine) {
            for (let y = 0; y < this.gridSize; y++) {
                const tileData = newLine[y];
                if (!tileData) continue;

                const tile = this.tiles.find(t => t.id === tileData.id);
                if (tile) {
                    tile.targetX = x;
                    tile.targetY = y;
                }
            }
        }

        findTileAt(x, y) {
            return this.tiles.find(t => t.x === x && t.y === y);
        }

        updateAnimations(dt) {
            let allDone = true;

            for (const tile of this.tiles) {
                if (tile.scale < 1) {
                    tile.scale = Math.min(1, tile.scale + dt * ANIM_SCALE_SPEED);
                    allDone = false;
                }

                // Handle removing tiles (fade out and move to merge target)
                if (tile.removing) {
                    tile.opacity = Math.max(0, tile.opacity - dt * ANIM_FADE_SPEED);
                    if (tile.removeTarget) {
                        tile.x += (tile.removeTarget.x - tile.x) * Math.min(1, dt * ANIM_MOVE_SPEED);
                        tile.y += (tile.removeTarget.y - tile.y) * Math.min(1, dt * ANIM_MOVE_SPEED);
                    }
                    if (tile.opacity <= 0.01) {
                        continue; // Will be filtered out
                    }
                    allDone = false;
                }

                if (tile.x !== tile.targetX || tile.y !== tile.targetY) {
                    tile.x += (tile.targetX - tile.x) * Math.min(1, dt * ANIM_MOVE_SPEED);
                    tile.y += (tile.targetY - tile.y) * Math.min(1, dt * ANIM_MOVE_SPEED);

                    if (Math.abs(tile.x - tile.targetX) < ANIM_POS_THRESHOLD && Math.abs(tile.y - tile.targetY) < ANIM_POS_THRESHOLD) {
                        tile.x = tile.targetX;
                        tile.y = tile.targetY;
                    } else {
                        allDone = false;
                    }
                }

                if (tile.new && tile.scale >= 1) {
                    tile.new = false;
                }
            }

            // Filter out removed tiles：仅在确实有方块被移除时才重建数组，避免每帧产生垃圾
            if (this.tiles.some(t => t.opacity <= 0.01)) {
                this.tiles = this.tiles.filter(t => t.opacity > 0.01);
            }

            // Handle merge pop animation
            for (const tile of this.tiles) {
                if (tile.merged) {
                    if (!tile.mergeScale) tile.mergeScale = 1.2;
                    tile.mergeScale = Math.max(1, tile.mergeScale - dt * ANIM_MERGE_POP_SPEED);
                    tile.scale = tile.mergeScale;
                    if (tile.mergeScale > 1) {
                        allDone = false;
                    } else {
                        // 弹跳结束，重置标记，避免 scale 被永久锁死
                        tile.merged = false;
                        tile.mergeScale = 1;
                        tile.scale = 1;
                    }
                }
            }

            if (this.isState(GameState.ANIMATING) && allDone) {
                // 动画完成，先与 grid 对齐，避免任何残留的错位方块
                this.syncTilesWithGrid();
                // 根据游戏状态决定下一状态
                if (this.isState(GameState.WON)) {
                    // 已经是 WON 状态，保持
                } else if (this.isState(GameState.GAME_OVER)) {
                    // 已经是 GAME_OVER 状态，保持
                } else {
                    this.setState(GameState.PLAYING);
                }
                this.checkGameState();
            }
        }

        checkGameState() {
            const n = this.gridSize;
            // 已弹过胜利框并点击“继续游戏”后（wonShown=true），不再重复进入 WON，
            // 否则棋盘上的 2048 会让状态永久锁死在 WON，导致无法继续移动
            if (!this.isState(GameState.WON) && !this.wonShown) {
                for (let y = 0; y < n; y++) {
                    for (let x = 0; x < n; x++) {
                        if (this.grid[y][x] >= 2048) {
                            this.setState(GameState.WON);
                            break;
                        }
                    }
                }
            }

            let hasEmpty = false;
            let canMerge = false;

            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    if (!this.grid[y][x]) {
                        hasEmpty = true;
                    } else {
                        const val = this.grid[y][x];
                        if (x < n - 1 && this.grid[y][x + 1] === val) canMerge = true;
                        if (y < n - 1 && this.grid[y + 1][x] === val) canMerge = true;
                    }
                }
            }

            if (!hasEmpty && !canMerge) {
                if (!this.isState(GameState.GAME_OVER)) this.closeSpecialPanel();
                this.setState(GameState.GAME_OVER);
            }
        }

        loop() {
            let lastTime = Date.now();
            let frameErrors = 0;
            const frame = () => {
                const now = Date.now();
                const dt = Math.min(0.05, (now - lastTime) / 1000);
                lastTime = now;

                try {
                    this.updateAnimations(dt);
                    this.updateSpecial(now);
                    this.render();
                    frameErrors = 0;
                } catch (err) {
                    console.error('Frame error:', err);
                    // 连续出错超过阈值：降级为只保留基础玩法——
                    // 清理动画缓冲、关闭特技弹窗，避免持续分配新对象
                    if (++frameErrors > 120) {
                        this._specialFloatTexts = [];
                        this._specialFlyers = [];
                        this.closeSpecialPanel();
                        // 仅当棋盘已建立且当前卡在过渡态时才尝试恢复可操作状态；
                        // IDLE（难度弹框阶段棋盘未建）绝不能强切，否则会渲染空棋盘
                        if (Array.isArray(this.grid) && this.grid.length === this.gridSize &&
                            !this.isState(GameState.PLAYING) && !this.isState(GameState.GAME_OVER)) {
                            this.setState(GameState.PLAYING);
                        }
                    }
                }

                // 无论如何都继续下一帧：单帧失败不终止渲染循环，避免游戏永久冻结
                requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        }

        render() {
            try {
                this.ctx.clearRect(0, 0, this.width, this.height);

                // 难度选择弹框：未选择前只渲染弹框场景
                if (this.isState(GameState.IDLE)) {
                    this.drawBackground();
                    this.drawDifficultyDialog();
                    this.drawSpecialFloatTexts(Date.now());
                    return;
                }

                const now = Date.now();

                this.drawBackground();
                this.drawGrid();
                this.drawTiles();
                this.drawSpecialPending(now);
                this.drawSpecialFlyers(now);
                this.drawUI();
                this.drawSpecialPanel();

                if (this.isState(GameState.WON) && !this.wonShown) {
                    this.showWinDialog();
                }

                if (this.isState(GameState.GAME_OVER) && !this._overlay) {
                    this.showGameOverDialog();
                }

                if (this._overlay) this.drawOverlay();

                // 提示飘字最后绘制：保证在弹窗/遮罩之上仍然可见
                this.drawSpecialFloatTexts(now);
            } catch (err) {
                console.error('Render error:', err);
                // 尝试恢复
                this.ctx.fillStyle = '#FAF8EF';
                this.ctx.fillRect(0, 0, this.width, this.height);
                this.ctx.fillStyle = '#776E65';
                this.ctx.font = this.getFont('normal', 24);
                this.ctx.textAlign = 'center';
                this.ctx.fillText('渲染错误，请重启游戏', this.width / 2, this.height / 2);
            }
        }

        destroy() {
            this.unbindEvents();
            this.flushBestScore();
            clearTimeout(this._adLoadTimer);
            clearTimeout(this._adWatchdog);
            this._adLoadTimer = null;
            this._adWatchdog = null;
            if (this.rewardedAd) {
                this.rewardedAd.offLoad();
                this.rewardedAd.offError();
                this.rewardedAd.offClose();
                this.rewardedAd.destroy();
                this.rewardedAd = null;
                this._rewardedAdInited = false;
            }
        }

        drawBackground() {
            this.ctx.fillStyle = '#FAF8EF';
            this.ctx.fillRect(0, 0, this.width, this.height);
        }

        drawGrid() {
            const n = this.gridSize;
            const boardSize = this.tileSize * n + this.gap * (n - 1);
            this.ctx.fillStyle = COLORS.grid;
            this.roundRect(this.boardX - this.gap / 2, this.boardY - this.gap / 2, boardSize + this.gap, boardSize + this.gap, 6);
            this.ctx.fill();

            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    const px = this.boardX + x * (this.tileSize + this.gap);
                    const py = this.boardY + y * (this.tileSize + this.gap);
                    this.ctx.fillStyle = COLORS.empty;
                    this.roundRect(px, py, this.tileSize, this.tileSize, 4);
                    this.ctx.fill();
                }
            }
        }

        drawTiles() {
            for (const tile of this.tiles) {
                const px = this.boardX + tile.x * (this.tileSize + this.gap);
                const py = this.boardY + tile.y * (this.tileSize + this.gap);
                const size = this.tileSize * tile.scale;
                const offset = (this.tileSize - size) / 2;

                const color = COLORS.tiles[tile.value] || COLORS.tiles[8192];

                this.ctx.globalAlpha = tile.opacity;
                this.ctx.fillStyle = color.bg;
                this.roundRect(px + offset, py + offset, size, size, 4);
                this.ctx.fill();

                this.ctx.fillStyle = color.text;
                const fontSize = Math.max(20, Math.floor(48 * tile.scale * this.tileSize / 100));
                this.ctx.font = this.getFont('bold', fontSize);
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                this.ctx.fillText(tile.label, px + this.tileSize / 2, py + this.tileSize / 2);
                this.ctx.globalAlpha = 1;
            }
        }

        drawUI() {
            this.ctx.fillStyle = COLORS.text.dark;
            this.ctx.font = this.getFont('bold', TITLE_FONT_SIZE);
            this.ctx.textAlign = 'left';
            this.ctx.textBaseline = 'top';
            this.ctx.fillText('2048', TITLE_MARGIN, TITLE_MARGIN);

            // 分数组左右均不得超出棋盘边框：贴棋盘右沿排布，窄屏时自动缩窄
            const boardRight = this.boardX + this.boardSize;
            const boxW = Math.min(SCORE_BOX_W, Math.floor((this.boardSize - 8) / 2));
            const gap = Math.max(8, Math.min(24, this.boardSize - boxW * 2));
            const rightX = boardRight - boxW;

            this.drawScoreBox(rightX, this.scoreBoxY, '得分', this.numLabel(this.score, this._scoreLabelCache), boxW);
            this.drawScoreBox(rightX - boxW - gap, this.scoreBoxY, '最佳', this.numLabel(this.bestScore, this._bestLabelCache), boxW);
            this.drawSpecialPoolBar();
            this.drawUndoButton();  // 与特技池同一行、位于其左侧

            if (DEBUG_SKIP_AD && this.specialPoolRect) {
                const rect = this.specialPoolRect;
                this.ctx.fillStyle = 'rgba(217, 83, 79, 0.92)';
                this.ctx.font = this.getFont('normal', 12);
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'top';
                this.ctx.fillText('调测模式 · 跳过广告', this.width / 2, rect.y + rect.h + 10);
            }
        }

        drawScoreBox(x, y, label, value, w) {
            const boxW = w || SCORE_BOX_W;

            this.ctx.fillStyle = COLORS.grid;
            this.roundRect(x, y, boxW, SCORE_BOX_H, 6);
            this.ctx.fill();

            this.ctx.fillStyle = '#EEE4DA';
            this.ctx.font = this.getFont('normal', Math.min(14, Math.max(11, Math.floor(boxW * 0.11))));
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(label, x + boxW / 2, y + SCORE_LABEL_Y);

            this.ctx.fillStyle = COLORS.text.light;
            this.ctx.font = this.getFont('bold', Math.min(32, Math.max(18, Math.floor(boxW * 0.24))));
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(value.toString(), x + boxW / 2, y + SCORE_VALUE_Y);
        }

        // 数字文本缓存：值未变化时复用字符串，减少每帧分配
        numLabel(value, cache) {
            if (cache.v !== value) {
                cache.v = value;
                cache.s = String(value);
            }
            return cache.s;
        }

        // 圆角矩形：统一用 arcTo 手绘路径。
        // 微信小游戏真机（尤其 iOS）没有全局 Path2D，Canvas 2D 的 fill(path)
        // 也不保证可用，因此这里不依赖任何扩展 API，只使用 Canvas 1.0 能力。
        roundRect(x, y, w, h, r) {
            const ctx = this.ctx;
            const rr = Math.min(Math.max(0, r), w / 2, h / 2);
            ctx.beginPath();
            ctx.moveTo(x + rr, y);
            ctx.arcTo(x + w, y, x + w, y + h, rr);
            ctx.arcTo(x + w, y + h, x, y + h, rr);
            ctx.arcTo(x, y + h, x, y, rr);
            ctx.arcTo(x, y, x + w, y, rr);
            ctx.closePath();
            ctx.fill();
        }

        showWinDialog() {
            if (this._overlay) return;
            this.wonShown = true;
            this._buildOverlay('恭喜获胜!', '达成 2048!', [
                { text: '继续游戏', color: '#8F7A66', callback: () => { this.wonShown = true; this.setState(GameState.PLAYING); } },
                { text: '重新开始', color: '#8F7A66', callback: () => { this.newGame(); this.wonShown = false; } }
            ]);
        }

        showGameOverDialog() {
            if (this._overlay) return;
            this.flushBestScore();
            this._buildOverlay('游戏结束', '最终得分: ' + this.score, [
                { text: '重新开始', color: '#F2B179', callback: () => { this.newGame(); } },
                { text: '看广告复活', color: '#8F7A66', callback: () => { this.showRewardedAd('revive'); } }
            ]);
        }

        // 结算弹窗配置只构建一次，渲染时复用，避免每帧创建数组/闭包
        _buildOverlay(title, subtitle, buttons) {
            this._overlay = { title, subtitle, buttons };
            this.overlayButtons = buttons;
            this._invalidateOverlayRects();
            this.beginDialogTextAnim();   // 弹窗打开时文字从下方上浮
        }

        clearOverlay() {
            this._overlay = null;
            this.overlayButtons = null;
        }

        _invalidateOverlayRects() {
            if (!this._overlay) return;
            for (const btn of this._overlay.buttons) btn._rect = null;
        }

        drawOverlay() {
            const overlay = this._overlay;
            if (!overlay) return;

            this.ctx.fillStyle = 'rgba(238, 228, 218, 0.95)';
            this.ctx.fillRect(0, 0, this.width, this.height);

            // 标题 + 副标题：弹出时从下方上浮并淡入
            const anim = this.dialogTextAnim(Date.now());
            const rise = 48;
            this.ctx.save();
            this.ctx.globalAlpha = anim.alpha;
            this.ctx.fillStyle = COLORS.text.dark;
            this.ctx.font = this.getFont('bold', 48);
            this.ctx.textAlign = 'center';
            this.ctx.fillText(overlay.title, this.width / 2, this.height / 2 - 80 + (1 - anim.t) * rise);

            this.ctx.font = this.getFont('normal', 28);
            this.ctx.fillText(overlay.subtitle, this.width / 2, this.height / 2 - 20 + (1 - anim.t) * rise);
            this.ctx.restore();

            const count = overlay.buttons.length;
            const margin = Math.max(20, Math.round(this.width * 0.06));   // 与屏幕左右边界的安全距离
            const gap = 14;                                              // 两个按钮之间的间距
            const btnH = 60;
            const maxBtnW = 220;
            // 按屏幕宽度均分可用区域，保证按钮不重叠、不越界
            const btnW = Math.min(
                maxBtnW,
                Math.floor((this.width - margin * 2 - gap * (count - 1)) / count)
            );
            const totalW = btnW * count + gap * (count - 1);
            const startX = (this.width - totalW) / 2;
            const btnY = this.height / 2 + 60;

            this.ctx.textBaseline = 'middle';
            for (let i = 0; i < count; i++) {
                const btn = overlay.buttons[i];
                if (!btn._rect) {
                    btn._rect = {
                        x: startX + i * (btnW + gap),
                        y: btnY - btnH / 2,
                        w: btnW,
                        h: btnH
                    };
                }
                const r = btn._rect;
                this.ctx.fillStyle = btn.color;
                this.roundRect(r.x, r.y, r.w, r.h, 8);

                // 窄屏自动缩小字号，避免文字顶到按钮边缘
                const fontSize = Math.max(
                    16,
                    Math.min(24, Math.floor((r.w - 24) / Math.max(1, btn.text.length)))
                );
                this.ctx.fillStyle = COLORS.text.light;
                this.ctx.font = this.getFont('bold', fontSize);
                this.ctx.textAlign = 'center';
                this.ctx.fillText(btn.text, r.x + r.w / 2, r.y + r.h / 2 + 1);
            }
        }

        checkOverlayTap(x, y) {
            if (!this.overlayButtons) return false;
            for (const btn of this.overlayButtons) {
                if (btn._rect && x >= btn._rect.x && x <= btn._rect.x + btn._rect.w &&
                    y >= btn._rect.y && y <= btn._rect.y + btn._rect.h) {
                    btn.callback();
                    this.clearOverlay();
                    return true;
                }
            }
            return false;
        }
    }

    return Game;
})();

// ---- 混入功能模块（特技加速 / 广告 / 后悔回撤） ----
Object.assign(Game2048.prototype, FK.special, FK.ads, FK.undo);

// 启动游戏
const canvas = wx.createCanvas();
const game = new Game2048(canvas);

console.log('start');
