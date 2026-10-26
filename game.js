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

            // Path2D 缓存
            this._pathCache = new Map();

            // 字体/样式缓存
            this._fontCache = new Map();
            this._textMetricsCache = new Map();
            this._initFontCache();

            this.init();
        }

        _initFontCache() {
            // 预计算常用字体
            const fontFamilies = ['Arial, "Microsoft YaHei", sans-serif'];
            const fontWeights = ['normal', 'bold'];
            const fontSizes = [11, 14, 18, 20, 24, 28, 32, 42, 48, 64, 72];

            for (const family of fontFamilies) {
                for (const weight of fontWeights) {
                    for (const size of fontSizes) {
                        const key = `${weight} ${size}px ${family}`;
                        this._fontCache.set(key, key);
                    }
                }
            }
        }

        getFont(weight, size, family = 'Arial, "Microsoft YaHei", sans-serif') {
            const key = `${weight} ${size}px ${family}`;
            return this._fontCache.get(key) || key;
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

        isState(...states) {
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

        showToastSafe(title) {
            try { wx.showToast({ title, icon: 'none' }); } catch (e) { }
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
                    btn.callback();
                    return;
                }
            }
        }

        drawDifficultyDialog() {
            const ctx = this.ctx;

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

            // 标题
            ctx.fillStyle = COLORS.text.dark;
            ctx.font = this.getFont('bold', 26);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('选择难度', panelX + panelW / 2, panelY + 48);

            ctx.font = this.getFont('normal', 14);
            ctx.fillStyle = '#9C8B7B';
            ctx.fillText('选择棋盘开始游戏', panelX + panelW / 2, panelY + 78);

            // 难度按钮
            const bw = panelW - 60;
            const bh = 64;
            const bx = panelX + (panelW - bw) / 2;
            const y1 = panelY + 108;
            const y2 = y1 + bh + 20;
            const levels = [
                { label: '4 × 4', sub: '经典模式', y: y1, size: 4 },
                { label: '5 × 5', sub: '挑战模式', y: y2, size: 5 }
            ];
            this._difficultyButtons = [];

            for (const lv of levels) {
                const isLast = this._lastDifficulty === lv.size;
                ctx.fillStyle = isLast ? '#F2B179' : '#8F7A66';
                this.roundRect(bx, lv.y, bw, bh, 12);

                ctx.fillStyle = COLORS.text.light;
                ctx.font = this.getFont('bold', 22);
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(lv.label, bx + 40, lv.y + bh / 2 - 8);

                ctx.font = this.getFont('normal', 13);
                ctx.fillText(lv.sub, bx + 40, lv.y + bh / 2 + 16);

                if (isLast) {
                    // 上次选择的难度打标
                    ctx.font = this.getFont('bold', 12);
                    ctx.fillStyle = '#5C4A3A';
                    ctx.textAlign = 'right';
                    ctx.fillText('上次使用', bx + bw - 16, lv.y + bh / 2);
                }

                this._difficultyButtons.push({
                    rect: { x: bx, y: lv.y, w: bw, h: bh, },
                    callback: () => this.selectDifficulty(lv.size)
                });
            }

            ctx.textAlign = 'left';
        }

        bindLifecycle() {
            wx.onHide(() => {
                this.unbindEvents();
                // 未入池的闪烁机会在切后台时直接入池，避免数据丢失
                if (this.specialPending) this.bankPendingSpecial(false);
                this.closeSpecialPanel();
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
                // 部分机型切后台会清理 SDK 回调，这里确保广告回调仍可用
                if (!this.rewardedAd && !this._adPurpose) this.initRewardedAd();
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
            for (const [, pos] of needed) {
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

        loadBestScore() {
            try {
                const stored = wx.getStorageSync('fk2048_best');
                this.bestScore = stored ? parseInt(stored, 10) : 0;
            } catch (e) {
                this.bestScore = 0;
            }
        }

        saveBestScore() {
            try {
                wx.setStorageSync('fk2048_best', this.bestScore.toString());
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
                this.saveBestScore();
            }
        }

        resize() {
            const sysInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
            const dpr = sysInfo.pixelRatio || 1;

            this.canvas.width = sysInfo.windowWidth * dpr;
            this.canvas.height = sysInfo.windowHeight * dpr;
            this.width = sysInfo.windowWidth;
            this.height = sysInfo.windowHeight;

            this.ctx.scale(dpr, dpr);
            this.calculateLayout();
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
            this.specialButtonSize = Math.max(48, Math.min(66, Math.floor(this.tileSize * 0.8)));
            if (this.specialPending) this.positionPending();
        }

        bindEvents() {
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
                    this.checkDifficultyTap(x, y);
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
            this.overlayButtons = null;
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
            const availableTiles = [...this.tiles]; // Copy to track used tiles
            for (let x = 0; x < this.gridSize; x++) {
                if (this.grid[y][x] !== null) {
                    // Try exact position match first
                    let tileIdx = availableTiles.findIndex(t => Math.round(t.x) === x && Math.round(t.y) === y && t.value === this.grid[y][x]);
                    // Fallback: same value, same row, not used yet
                    if (tileIdx === -1) {
                        tileIdx = availableTiles.findIndex(t => t.value === this.grid[y][x] && Math.round(t.y) === y);
                    }
                    if (tileIdx !== -1) {
                        row.push(availableTiles.splice(tileIdx, 1)[0]);
                    } else {
                        row.push({ value: this.grid[y][x], id: `tile_${this.tileIdCounter++}`, x, y });
                    }
                } else {
                    row.push(null);
                }
            }
            return row;
        }

        getColWithTiles(x) {
            const col = [];
            const availableTiles = [...this.tiles];
            for (let y = 0; y < this.gridSize; y++) {
                if (this.grid[y][x] !== null) {
                    let tileIdx = availableTiles.findIndex(t => Math.round(t.x) === x && Math.round(t.y) === y && t.value === this.grid[y][x]);
                    if (tileIdx === -1) {
                        tileIdx = availableTiles.findIndex(t => t.value === this.grid[y][x] && Math.round(t.x) === x);
                    }
                    if (tileIdx !== -1) {
                        col.push(availableTiles.splice(tileIdx, 1)[0]);
                    } else {
                        col.push({ value: this.grid[y][x], id: `tile_${this.tileIdCounter++}`, x, y });
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

            // Filter out removed tiles
            this.tiles = this.tiles.filter(t => t.opacity > 0.01);

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
            if (!this.isState(GameState.WON)) {
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
            const frame = () => {
                const now = Date.now();
                const dt = (now - lastTime) / 1000;
                lastTime = now;

                this.updateAnimations(dt);
                this.updateSpecial(now);
                this.render();

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
                this.drawSpecialFloatTexts(now);

                if (this.isState(GameState.WON) && !this.wonShown) {
                    this.showWinDialog();
                }

                if (this.isState(GameState.GAME_OVER)) {
                    this.showGameOverDialog();
                }
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
                this.ctx.fillText(tile.value.toString(), px + this.tileSize / 2, py + this.tileSize / 2);
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

            this.drawScoreBox(rightX, this.scoreBoxY, '得分', this.score, boxW);
            this.drawScoreBox(rightX - boxW - gap, this.scoreBoxY, '最佳', this.bestScore, boxW);
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

        getRoundRectPath(w, h, r) {
            const key = `${w},${h},${r}`;
            let path = this._pathCache.get(key);
            if (!path) {
                path = new Path2D();
                path.moveTo(r, 0);
                path.lineTo(w - r, 0);
                path.quadraticCurveTo(w, 0, w, r);
                path.lineTo(w, h - r);
                path.quadraticCurveTo(w, h, w - r, h);
                path.lineTo(r, h);
                path.quadraticCurveTo(0, h, 0, h - r);
                path.lineTo(0, r);
                path.quadraticCurveTo(0, 0, r, 0);
                path.closePath();
                this._pathCache.set(key, path);
            }
            return path;
        }

        drawRoundRect(x, y, w, h, r) {
            const path = this.getRoundRectPath(w, h, r);
            this.ctx.save();
            this.ctx.translate(x, y);
            this.ctx.fill(path);
            this.ctx.restore();
        }

        roundRect(x, y, w, h, r) {
            this.drawRoundRect(x, y, w, h, r);
        }

        showWinDialog() {
            this.wonShown = true;
            this.drawOverlay('恭喜获胜!', '达成 2048!', [
                { text: '继续游戏', color: '#8F7A66', callback: () => { this.wonShown = true; this.setState(GameState.PLAYING); } },
                { text: '重新开始', color: '#8F7A66', callback: () => { this.newGame(); this.wonShown = false; } }
            ]);
        }

        showGameOverDialog() {
            this.drawOverlay('游戏结束', `最终得分: ${this.score}`, [
                { text: '重新开始', color: '#F2B179', callback: () => { this.newGame(); } },
                { text: '看广告复活', color: '#8F7A66', callback: () => { this.showRewardedAd(); } }
            ]);
        }

        drawOverlay(title, subtitle, buttons) {
            this.ctx.fillStyle = 'rgba(238, 228, 218, 0.95)';
            this.ctx.fillRect(0, 0, this.width, this.height);

            this.ctx.fillStyle = COLORS.text.dark;
            this.ctx.font = this.getFont('bold', 48);
            this.ctx.textAlign = 'center';
            this.ctx.fillText(title, this.width / 2, this.height / 2 - 80);

            this.ctx.font = this.getFont('normal', 28);
            this.ctx.fillText(subtitle, this.width / 2, this.height / 2 - 20);

            const btnY = this.height / 2 + 60;
            buttons.forEach((btn, i) => {
                const btnX = this.width / 2 + (i - (buttons.length - 1) / 2) * 160;
                this.ctx.fillStyle = btn.color;
                this.roundRect(btnX - 100, btnY - 30, 200, 60, 8);
                this.ctx.fill();

                this.ctx.fillStyle = COLORS.text.light;
                this.ctx.font = this.getFont('bold', 24);
                this.ctx.fillText(btn.text, btnX, btnY + 8);

                btn._rect = { x: btnX - 100, y: btnY - 30, w: 200, h: 60, callback: btn.callback };
            });

            this.overlayButtons = buttons;
        }

        checkOverlayTap(x, y) {
            if (!this.overlayButtons) return false;
            for (const btn of this.overlayButtons) {
                if (btn._rect && x >= btn._rect.x && x <= btn._rect.x + btn._rect.w &&
                    y >= btn._rect.y && y <= btn._rect.y + btn._rect.h) {
                    btn.callback();
                    this.overlayButtons = null;
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

console.log('FK2048 Native Started');
