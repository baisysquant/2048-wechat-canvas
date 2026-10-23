
// 无引擎依赖，包体 < 200KB，直接可在微信开发者工具运行

const Game2048 = (function () {
    'use strict';

    const GRID_SIZE = 4;
    const TILE_SIZE = 100;
    const GAP = 12;
    const ANIMATION_DURATION = 100;
    
    // Animation constants
    const ANIM_SCALE_SPEED = 10;      // pop-in speed
    const ANIM_MOVE_SPEED = 10;       // slide speed
    const ANIM_MERGE_POP_SPEED = 3;   // merge pop speed
    const ANIM_FADE_SPEED = 5;        // fade out speed
    const ANIM_POS_THRESHOLD = 0.05;  // position snap threshold
    
    // UI Constants
    const TITLE_FONT_SIZE = 64;
    const TITLE_MARGIN = 30;
    const SCORE_BOX_W = 160;
    const SCORE_BOX_H = 80;
    const SCORE_BOX_MARGIN = 30;
    const SCORE_LABEL_Y = 25;
    const SCORE_VALUE_Y = 55;
    const BOARD_TOP_MARGIN = 220;
    const BOARD_SIDE_MARGIN = 30;
    const BOARD_BOTTOM_RESERVE = 320;
    
    // Game States
    const GameState = {
        IDLE: 'idle',
        PLAYING: 'playing',
        ANIMATING: 'animating',
        WON: 'won',
        GAME_OVER: 'game_over',
        AD_PLAYING: 'ad_playing'
    };
    
    // State Transitions
    const StateTransitions = {
        [GameState.IDLE]: [GameState.PLAYING],
        [GameState.PLAYING]: [GameState.ANIMATING, GameState.WON, GameState.GAME_OVER],
        [GameState.ANIMATING]: [GameState.PLAYING, GameState.WON, GameState.GAME_OVER],
        [GameState.WON]: [GameState.PLAYING, GameState.IDLE],
        [GameState.GAME_OVER]: [GameState.IDLE, GameState.AD_PLAYING],
        [GameState.AD_PLAYING]: [GameState.PLAYING, GameState.GAME_OVER]
    };

    const COLORS = {
        bg: '#F9F6F2',
        grid: '#BBADA0',
        empty: '#CDC1B4',
        text: {
            dark: '#776E65',
            light: '#F9F6F2'
        },
        tiles: {
            2:    { bg: '#EEE4DA', text: '#776E65' },
            4:    { bg: '#EDE0C8', text: '#776E65' },
            8:    { bg: '#F2B179', text: '#F9F6F2' },
            16:   { bg: '#F59563', text: '#F9F6F2' },
            32:   { bg: '#F67C5F', text: '#F9F6F2' },
            64:   { bg: '#F65E3B', text: '#F9F6F2' },
            128:  { bg: '#EDCF72', text: '#F9F6F2' },
            256:  { bg: '#EDCC61', text: '#F9F6F2' },
            512:  { bg: '#EDC850', text: '#F9F6F2' },
            1024: { bg: '#EDC53F', text: '#F9F6F2' },
            2048: { bg: '#EDC22E', text: '#F9F6F2' },
            4096: { bg: '#3C3A32', text: '#F9F6F2' },
            8192: { bg: '#3C3A32', text: '#F9F6F2' }
        }
    };

    class Tile {
        constructor(value, x, y) {
            this.value = value;
            this.x = x;
            this.y = y;
            this.targetX = x;
            this.targetY = y;
            this.prevX = x;
            this.prevY = y;
            this.id = Math.random().toString(36).substr(2, 9);
            this.merged = false;
            this.new = true;
            this.scale = 0;
            this.opacity = 1;
        }
    }

    class Game {
        constructor(canvas) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.width = canvas.width;
            this.height = canvas.height;
            
            this.grid = [];
            this.tiles = [];
            this.score = 0;
            this.bestScore = 0;
            this._state = GameState.IDLE;
            this.tileIdCounter = 0;
            this.wonShown = false;

            this.touchStartX = 0;
            this.touchStartY = 0;
            
            this.adLoaded = false;
            this.adLoading = false;
            this._adInitialized = false;
            
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
            const fontSizes = [14, 20, 24, 28, 32, 42, 48, 64, 72];
            
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

        init() {
            this.loadBestScore();
            this.resize();
            this.bindEvents();
            this.newGame();
            this.initAd();
            this.loop();
            this.bindLifecycle();
        }

        bindLifecycle() {
            wx.onHide(() => {
                this.unbindEvents();
                if (this.rewardedAd) {
                    this.rewardedAd.offLoad();
                    this.rewardedAd.offError();
                    this.rewardedAd.offClose();
                }
            });
            wx.onShow(() => {
                // 确保动画状态重置，避免卡死
                if (this.animating) {
                    this.completeAnimationsImmediately();
                }
                this.resize();
                this.bindEvents();
                this.syncTilesWithGrid();
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

        // 同步 tiles 数组与 grid 状态
        syncTilesWithGrid() {
            const existingIds = new Set(this.tiles.map(t => t.id));
            const neededTiles = new Map();
            
            // 收集 grid 中需要的 tiles
            for (let y = 0; y < GRID_SIZE; y++) {
                for (let x = 0; x < GRID_SIZE; x++) {
                    const value = this.grid[y][x];
                    if (value !== null) {
                        const key = `${x},${y},${value}`;
                        neededTiles.set(key, { x, y, value });
                    }
                }
            }
            
            // 保留匹配的 tiles，标记位置
            const newTiles = [];
            for (const tile of this.tiles) {
                const key = `${tile.x},${tile.y},${tile.value}`;
                if (neededTiles.has(key)) {
                    tile.targetX = tile.x;
                    tile.targetY = tile.y;
                    newTiles.push(tile);
                    neededTiles.delete(key);
                }
            }
            
            // 为缺失的 grid 位置创建新 tiles
            for (const [, pos] of neededTiles) {
                const newTile = new Tile(pos.value, pos.x, pos.y);
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
            const maxBoardWidth = this.width - BOARD_SIDE_MARGIN * 2;
            const maxBoardHeight = this.height - BOARD_BOTTOM_RESERVE;
            const maxSize = Math.min(maxBoardWidth, maxBoardHeight);
            
            const boardSize = TILE_SIZE * GRID_SIZE + GAP * (GRID_SIZE - 1);
            const scale = Math.min(1, maxSize / boardSize);
            
            this.tileSize = Math.floor(TILE_SIZE * scale);
            this.gap = Math.floor(GAP * scale);
            const actualBoardSize = this.tileSize * GRID_SIZE + this.gap * (GRID_SIZE - 1);
            
            this.boardX = (this.width - actualBoardSize) / 2;
            this.boardY = BOARD_TOP_MARGIN + (maxBoardHeight - actualBoardSize) / 2;
        }

        bindEvents() {
            this._touchStartHandler = (e) => {
                const touch = e.touches[0];
                this.touchStartX = touch.clientX;
                this.touchStartY = touch.clientY;
            };
            
            this._touchEndHandler = (e) => {
                if (this.checkOverlayTap(e.changedTouches[0].clientX, e.changedTouches[0].clientY)) return;
                if (this.animating || this.gameOver) return;
                const touch = e.changedTouches[0];
                const dx = touch.clientX - this.touchStartX;
                const dy = touch.clientY - this.touchStartY;
                
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
            wx.onTouchEnd(this._touchEndHandler);
            wx.onWindowResize(this._resizeHandler);
        }

        unbindEvents() {
            wx.offTouchStart(this._touchStartHandler);
            wx.offTouchEnd(this._touchEndHandler);
            wx.offWindowResize(this._resizeHandler);
        }

        newGame() {
            this.grid = Array(GRID_SIZE).fill(null).map(() => Array(GRID_SIZE).fill(null));
            this.tiles = [];
            this.score = 0;
            this.setState(GameState.PLAYING);
            this.wonShown = false;
            this.tileIdCounter = 0;
            this.addRandomTile();
            this.addRandomTile();
        }

        addRandomTile() {
            const empty = [];
            for (let y = 0; y < GRID_SIZE; y++) {
                for (let x = 0; x < GRID_SIZE; x++) {
                    if (!this.grid[y][x]) empty.push({ x, y });
                }
            }
            if (empty.length === 0) return;
            
            const pos = empty[Math.floor(Math.random() * empty.length)];
            const value = Math.random() < 0.9 ? 2 : 4;
            this.grid[pos.y][pos.x] = value;
            const tile = new Tile(value, pos.x, pos.y);
            tile.id = `tile_${this.tileIdCounter++}`;
            this.tiles.push(tile);
        }

        move(direction) {
            if (!this.isState(GameState.PLAYING)) return;
            
            let moved = false;
            let scoreGained = 0;
            const merges = [];

            if (direction === 'left' || direction === 'right') {
                for (let y = 0; y < GRID_SIZE; y++) {
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
                for (let x = 0; x < GRID_SIZE; x++) {
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
            for (const merge of merges) {
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
                this.score += scoreGained;
                if (this.score > this.bestScore) {
                    this.bestScore = this.score;
                    this.saveBestScore();
                }
                this.setState(GameState.ANIMATING);
                this.addRandomTile();
            }
        }

        getRowWithTiles(y) {
            const row = [];
            const availableTiles = [...this.tiles]; // Copy to track used tiles
            for (let x = 0; x < GRID_SIZE; x++) {
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
            for (let y = 0; y < GRID_SIZE; y++) {
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
            for (let y = 0; y < GRID_SIZE; y++) {
                this.grid[y][x] = line[y];
            }
        }

        processLineWithTiles(line, forward) {
            const tiles = line.filter(t => t !== null);
            const result = new Array(GRID_SIZE).fill(null);
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
                        // 合并
                        const mergedValue = current.value * 2;
                        scoreGained += mergedValue;
                        result[write] = { ...current, value: mergedValue };
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
                let write = GRID_SIZE - 1;
                for (let read = tiles.length - 1; read >= 0; read--) {
                    const current = tiles[read];
                    
                    // 检查是否可以与前一个合并
                    if (read - 1 >= 0 && 
                        current.value === tiles[read - 1].value) {
                        // 合并
                        const mergedValue = current.value * 2;
                        scoreGained += mergedValue;
                        result[write] = { ...current, value: mergedValue };
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
                        if (write !== (GRID_SIZE - 1 - (tiles.length - 1 - read))) moved = true;
                    }
                    write--;
                }
            }

            // 检查是否有移动（位置变化或合并）
            for (let i = 0; i < GRID_SIZE; i++) {
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
            for (let x = 0; x < GRID_SIZE; x++) {
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
            for (let y = 0; y < GRID_SIZE; y++) {
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
                    if (tile.mergeScale > 1) allDone = false;
                }
            }

            if (this.isState(GameState.ANIMATING) && allDone) {
                // 动画完成，根据游戏状态决定下一状态
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
            if (!this.isState(GameState.WON)) {
                for (let y = 0; y < GRID_SIZE; y++) {
                    for (let x = 0; x < GRID_SIZE; x++) {
                        if (this.grid[y][x] >= 2048) {
                            this.setState(GameState.WON);
                            break;
                        }
                    }
                }
            }

            let hasEmpty = false;
            let canMerge = false;
            
            for (let y = 0; y < GRID_SIZE; y++) {
                for (let x = 0; x < GRID_SIZE; x++) {
                    if (!this.grid[y][x]) {
                        hasEmpty = true;
                    } else {
                        const val = this.grid[y][x];
                        if (x < GRID_SIZE - 1 && this.grid[y][x + 1] === val) canMerge = true;
                        if (y < GRID_SIZE - 1 && this.grid[y + 1][x] === val) canMerge = true;
                    }
                }
            }
            
            if (!hasEmpty && !canMerge) {
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
                this.render();
                
                requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        }

        render() {
            try {
                this.ctx.clearRect(0, 0, this.width, this.height);
                
                this.drawBackground();
                this.drawGrid();
                this.drawTiles();
                this.drawUI();
                
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
                this.ctx.fillText('渲染错误，请重启游戏', this.width/2, this.height/2);
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
            const boardSize = this.tileSize * GRID_SIZE + this.gap * (GRID_SIZE - 1);
            this.ctx.fillStyle = COLORS.grid;
            this.roundRect(this.boardX - this.gap/2, this.boardY - this.gap/2, boardSize + this.gap, boardSize + this.gap, 6);
            this.ctx.fill();
            
            for (let y = 0; y < GRID_SIZE; y++) {
                for (let x = 0; x < GRID_SIZE; x++) {
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
                this.ctx.fillText(tile.value.toString(), px + this.tileSize/2, py + this.tileSize/2);
                this.ctx.globalAlpha = 1;
            }
        }

        drawUI() {
            this.ctx.fillStyle = COLORS.text.dark;
            this.ctx.font = this.getFont('bold', TITLE_FONT_SIZE);
            this.ctx.textAlign = 'left';
            this.ctx.textBaseline = 'top';
            this.ctx.fillText('2048', TITLE_MARGIN, TITLE_MARGIN);

            const rightX = this.width - SCORE_BOX_MARGIN - SCORE_BOX_W;
            
            this.drawScoreBox(rightX, TITLE_MARGIN, '得分', this.score);
            this.drawScoreBox(rightX - SCORE_BOX_W - 20, TITLE_MARGIN, '最佳', this.bestScore);
        }

        drawScoreBox(x, y, label, value) {
            this.ctx.fillStyle = COLORS.grid;
            this.roundRect(x, y, SCORE_BOX_W, SCORE_BOX_H, 6);
            this.ctx.fill();
            
            this.ctx.fillStyle = '#EEE4DA';
            this.ctx.font = this.getFont('normal', 14);
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(label, x + SCORE_BOX_W / 2, y + SCORE_LABEL_Y);
            
            this.ctx.fillStyle = COLORS.text.light;
            this.ctx.font = this.getFont('bold', 32);
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(value.toString(), x + SCORE_BOX_W / 2, y + SCORE_VALUE_Y);
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
                { text: '继续游戏', color: '#8F7A66', callback: () => { this.wonShown = false; } },
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
            this.ctx.fillText(title, this.width/2, this.height/2 - 80);
            
            this.ctx.font = this.getFont('normal', 28);
            this.ctx.fillText(subtitle, this.width/2, this.height/2 - 20);
            
            const btnY = this.height/2 + 60;
            buttons.forEach((btn, i) => {
                const btnX = this.width/2 + (i - (buttons.length-1)/2) * 160;
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

        // ============ 微信广告 SDK ============
        
        initRewardedAd() {
            if (this._rewardedAdInited) return;
            if (!wx.createRewardedVideoAd) {
                console.warn('当前基础库不支持激励视频广告');
                return;
            }
            
            const adUnitId = 'adunit-xxxxxxxx'; // 替换为你的广告位ID
            this.rewardedAd = wx.createRewardedVideoAd({ adUnitId });
            this._rewardedAdInited = true;
            
            this.rewardedAd.onLoad(() => {
                console.log('激励视频广告加载成功');
                this.adLoaded = true;
                this.adLoading = false;
            });
            
            this.rewardedAd.onError((err) => {
                console.error('激励视频广告加载失败', err);
                this.adLoaded = false;
                this.adLoading = false;
            });
            
            this.rewardedAd.onClose((res) => {
                if (res && res.isEnded) {
                    console.log('广告观看完成，给予奖励');
                    this.onAdReward();
                } else {
                    console.log('用户中途关闭广告');
                }
                this.adLoaded = false;
                // 预加载下一条
                setTimeout(() => this.loadRewardedAd(), 500);
            });
        }

        loadRewardedAd() {
            if (this.adLoaded || this.adLoading) return Promise.resolve(this.adLoaded);
            if (!wx.createRewardedVideoAd) return Promise.resolve(false);
            
            this.initRewardedAd();
            if (!this.rewardedAd) return Promise.resolve(false);
            
            this.adLoading = true;
            return this.rewardedAd.load().then(() => {
                this.adLoaded = true;
                this.adLoading = false;
                return true;
            }).catch((err) => {
                this.adLoaded = false;
                this.adLoading = false;
                console.error('广告加载失败', err);
                return false;
            });
        }

        showRewardedAd() {
            if (!wx.createRewardedVideoAd) {
                wx.showToast({ title: '当前版本不支持广告', icon: 'none' });
                return;
            }
            
            if (this.adLoaded && this.rewardedAd) {
                this.rewardedAd.show().catch((err) => {
                    console.error('广告展示失败', err);
                    this.adLoaded = false;
                    this.loadRewardedAd();
                });
            } else {
                wx.showLoading({ title: '广告加载中...' });
                this.loadRewardedAd().then((loaded) => {
                    wx.hideLoading();
                    if (loaded && this.rewardedAd) {
                        this.rewardedAd.show().catch((err) => {
                            console.error('广告展示失败', err);
                            wx.showToast({ title: '广告展示失败', icon: 'none' });
                        });
                    } else {
                        wx.showToast({ title: '广告暂不可用', icon: 'none' });
                    }
                });
            }
        }

        onAdReward() {
            console.log('复活奖励：继续游戏');
            this.setState(GameState.PLAYING);
            this.overlayButtons = null;
        }
    }

    return Game;
})();

// 启动游戏
const canvas = wx.createCanvas();
const game = new Game2048(canvas);

console.log('FK2048 Native Started');