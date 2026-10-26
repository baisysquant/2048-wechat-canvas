/**
 * 特技加速模块（棋盘闪烁机会 / 特技池 / 弹窗 / 广告闭环 / 绘制）
 * 通过 Object.assign(Game.prototype, FK_SPECIAL) 混入，全部方法以 this 访问 Game 实例
 */
(function (global) {
    'use strict';

    const C = (typeof require === 'function')
        ? require('./config.js')
        : (global && global.FK_CONFIG) || {};

    // 模块依赖：config → special
    const {
        DEBUG_SKIP_AD,
        SPECIAL_TRIGGER_VALUE, SPECIAL_CAP, SPECIAL_MAX_PER_GAME, SPECIAL_REWARD,
        SPECIAL_FLOAT_MS, SPECIAL_FADE_MS, SPECIAL_BANK_FLY_MS,
        SPECIAL_AD_LOAD_TIMEOUT, SPECIAL_AD_COOLDOWN, SPECIAL_SAVE_KEY,
        COLORS
    } = C;

    const SpecialMixin = {

        pointInRect(x, y, rect) {
            return !!rect && x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
        }

        , hitSpecialPending(x, y) {
            const p = this.specialPending;
            if (!p) return false;
            const half = (this.specialButtonSize || 60) / 2 + 4;
            return Math.abs(x - p.x) <= half && Math.abs(y - p.y) <= half;
        }

        // 棋盘格子中心坐标（gx/gy 为 0 到 gridSize-1）
        , getCellCenter(gx, gy) {
            const step = this.tileSize + this.gap;
            return {
                x: this.boardX + gx * step + this.tileSize / 2,
                y: this.boardY + gy * step + this.tileSize / 2
            };
        }

        // 根据所在格子重算闪烁按钮的像素坐标（适配旋转/改尺寸）
        , positionPending() {
            const p = this.specialPending;
            if (!p || p.gx === undefined || p.gy === undefined) return;
            const c = this.getCellCenter(p.gx, p.gy);
            p.x = c.x;
            p.y = c.y;
        }

        , getEmptyCells() {
            const cells = [];
            const n = this.gridSize;
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    if (!this.grid[y][x]) cells.push({ x, y });
                }
            }
            return cells;
        }

        // ---------- 数据与持久化 ----------
        , loadSpecialPool() {
            try {
                const raw = wx.getStorageSync(SPECIAL_SAVE_KEY);
                if (!raw) return;
                const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
                const list = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
                this.specialPool = list
                    .filter(it => it && Number.isFinite(Number(it.id)))
                    .slice(0, SPECIAL_CAP)
                    .map(it => ({
                        id: Math.floor(Number(it.id)),
                        value: SPECIAL_TRIGGER_VALUE,
                        ts: Number(it.ts) || Date.now()
                    }));
                this._specialIdSeq = this.specialPool.reduce((m, it) => Math.max(m, it.id), 0) + 1;
            } catch (e) {
                this.specialPool = [];
            }
        }

        , saveSpecialPool() {
            try {
                wx.setStorageSync(SPECIAL_SAVE_KEY, JSON.stringify(this.specialPool));
            } catch (e) { }
        }

        // ---------- 数据埋点（运营分析，可在此接入上报 SDK） ----------
        , trackSpecial(event, extra) {
            console.log('[SpecialTrack]', event, extra || '');
        }

        // ---------- 触发与入池 ----------
        , trySpawnSpecial() {
            if (this._specialTriggered >= SPECIAL_MAX_PER_GAME) {
                this.trackSpecial('trigger_blocked', { reason: 'game_cap' });
                return; // 单局上限，静默
            }
            if (this.specialPool.length + (this.specialPending ? 1 : 0) >= SPECIAL_CAP) {
                this.trackSpecial('trigger_blocked', { reason: 'pool_full' });
                return; // 池满，静默
            }

            const replacing = !!this.specialPending;
            if (replacing) {
                this.trackSpecial('replace');
                // 旧机会立即沉入底池，数据不丢失
                this.bankPendingSpecial(false);
            }

            this._specialTriggered++;

            // 只在空格子里出现，绝不覆盖已有数字
            const cells = this.getEmptyCells();
            if (cells.length === 0) {
                // 满盘时没有安全位置，直接入池，机会不丢失
                this.pushSpecialPoolItem(this.boardX + this.boardSize / 2, this.boardY + this.boardSize / 2, false);
                this.trackSpecial('trigger', { index: this._specialTriggered, placed: 'pool_no_space' });
                return;
            }

            const cell = cells[Math.floor(Math.random() * cells.length)];
            this.specialPending = {
                gx: cell.x,
                gy: cell.y,
                x: 0,
                y: 0,
                spawnAt: Date.now()
            };
            this.positionPending();
            this.trackSpecial('trigger', { index: this._specialTriggered, gx: cell.x, gy: cell.y });
        }

        // 机会入池（含飞入动画），返回是否成功
        , pushSpecialPoolItem(x, y, fromClick) {
            if (this.specialPool.length >= SPECIAL_CAP) return false;
            this.specialPool.push({
                id: this._specialIdSeq++,
                value: SPECIAL_TRIGGER_VALUE,
                ts: Date.now()
            });
            this.saveSpecialPool();
            this._specialFlyers.push({ x, y, startAt: Date.now() });
            if (fromClick) {
                this.pushFloatText('⚡ 特技已入池', this.width / 2, this.specialPoolRect.y - 18, 1100, 20);
            }
            return true;
        }

        , bankPendingSpecial(fromClick) {
            const p = this.specialPending;
            if (!p) return;
            this.specialPending = null;
            this.pushSpecialPoolItem(p.x, p.y, fromClick);
        }

        , updateSpecial(now) {
            if (this.specialPending) {
                const p = this.specialPending;
                // 该格子被方块占用时，自动换到其他空格，保证任何数字都不会被遮挡
                const occupied = !!(this.grid[p.gy] && this.grid[p.gy][p.gx]);
                if (occupied) {
                    const cells = this.getEmptyCells();
                    if (cells.length > 0) {
                        const cell = cells[Math.floor(Math.random() * cells.length)];
                        p.gx = cell.x;
                        p.gy = cell.y;
                        this.positionPending();
                        this.trackSpecial('relocate', { gx: p.gx, gy: p.gy });
                    } else {
                        this.trackSpecial('bank_no_space');
                        this.bankPendingSpecial(false);
                    }
                }

                if (this.specialPending) {
                    const elapsed = now - this.specialPending.spawnAt;
                    if (elapsed >= SPECIAL_FLOAT_MS + SPECIAL_FADE_MS) {
                        this.trackSpecial('expire');
                        this.bankPendingSpecial(false);
                    }
                }
            }
            if (this._specialFlyers.length) {
                this._specialFlyers = this._specialFlyers.filter(f => now - f.startAt < SPECIAL_BANK_FLY_MS);
            }
            if (this._specialFloatTexts.length) {
                this._specialFloatTexts = this._specialFloatTexts.filter(f => now - f.startAt < f.duration);
            }
            if (this.specialPanelOpen) {
                const L = this.getSpecialPanelLayout();
                if (this._specialScroll > L.maxScroll) this._specialScroll = L.maxScroll;
            }
        }

        , pushFloatText(text, x, y, duration, size) {
            this._specialFloatTexts.push({
                text,
                x,
                y,
                startAt: Date.now(),
                duration: duration || 1400,
                size: size || 26
            });
        }

        // ---------- 底池弹窗 ----------
        , getSpecialPanelLayout() {
            const n = this.specialPool.length;
            const itemH = 54;
            const gap = 8;
            const padding = 16;
            const headerH = 78;
            const panelW = Math.min(this.width - 40, 360);
            const contentH = n > 0 ? n * itemH + (n - 1) * gap : 96;
            const maxListH = Math.max(140, this.height - 160 - headerH - padding);
            const listH = Math.min(contentH, maxListH);
            const panelH = headerH + listH + padding;
            const panelX = (this.width - panelW) / 2;
            const panelY = Math.max(60, (this.height - panelH) / 2);

            return {
                n, itemH, gap, padding, headerH, panelW, panelH, panelX, panelY,
                listX: panelX + padding,
                listY: panelY + headerH,
                listW: panelW - padding * 2,
                listH,
                contentH,
                maxScroll: Math.max(0, contentH - listH),
                closeRect: { x: panelX + panelW - 50, y: panelY + 12, w: 36, h: 36 }
            };
        }

        , getSpecialItemRect(index, L) {
            return {
                x: L.listX,
                y: L.listY + index * (L.itemH + L.gap) - this._specialScroll,
                w: L.listW,
                h: L.itemH
            };
        }

        , openSpecialPanel() {
            this.specialPanelOpen = true;
            this._specialScroll = 0;
            this._specialScrollDrag = null;
        }

        , closeSpecialPanel() {
            this.specialPanelOpen = false;
            this._specialScroll = 0;
            this._specialScrollDrag = null;
        }

        , toggleSpecialPanel() {
            if (this.specialPanelOpen) this.closeSpecialPanel();
            else this.openSpecialPanel();
        }

        , resetSpecialTouch() {
            this._specialTouchMode = null;
            this._specialScrollDrag = null;
        }

        , handleSpecialTouchStart(x, y) {
            if (this.specialPanelOpen) {
                const L = this.getSpecialPanelLayout();
                if (this.pointInRect(x, y, L.closeRect)) {
                    this._specialTouchMode = 'close';
                    return true;
                }
                if (this.pointInRect(x, y, { x: L.listX, y: L.listY, w: L.listW, h: L.listH })) {
                    this._specialTouchMode = 'panel';
                    this._specialScrollDrag = { startY: y, startScroll: this._specialScroll };
                    return true;
                }
                if (x >= L.panelX && x <= L.panelX + L.panelW && y >= L.panelY && y <= L.panelY + L.panelH) {
                    this._specialTouchMode = 'panel';
                    return true;
                }
                this._specialTouchMode = 'backdrop';
                return true;
            }

            if (this.specialPending && this.hitSpecialPending(x, y)) {
                this._specialTouchMode = 'float';
                return true;
            }
            if (this.pointInRect(x, y, this.specialPoolRect)) {
                this._specialTouchMode = 'pool';
                return true;
            }
            return false;
        }

        , handleSpecialTouchMove(x, y) {
            if (this._specialTouchMode !== 'panel' || !this._specialScrollDrag) return;
            const L = this.getSpecialPanelLayout();
            const next = this._specialScrollDrag.startScroll + (this._specialScrollDrag.startY - y);
            this._specialScroll = Math.max(0, Math.min(L.maxScroll, next));
        }

        , handleSpecialTouchEnd(x, y) {
            const mode = this._specialTouchMode;
            const moved = Math.abs(x - this.touchStartX) > 12 || Math.abs(y - this.touchStartY) > 12;

            if (mode === 'float') {
                if (!moved && this.specialPending && this.hitSpecialPending(x, y)) {
                    this.trackSpecial('float_click');
                    this.bankPendingSpecial(true);
                }
                return;
            }
            if (mode === 'pool') {
                if (!moved && this.pointInRect(x, y, this.specialPoolRect)) this.toggleSpecialPanel();
                return;
            }
            if (mode === 'close') {
                if (!moved) this.closeSpecialPanel();
                return;
            }
            if (mode === 'panel') {
                if (moved) return; // 拖拽滚动，不触发点击
                this.handleSpecialItemTap(x, y);
                return;
            }
            if (mode === 'backdrop') {
                this.closeSpecialPanel();
            }
        }

        , handleSpecialItemTap(x, y) {
            const L = this.getSpecialPanelLayout();
            if (x < L.listX || x > L.listX + L.listW) return;
            if (y < L.listY || y > L.listY + L.listH) return;

            for (let i = 0; i < this.specialPool.length; i++) {
                const r = this.getSpecialItemRect(i, L);
                // 只允许点击完整可见的条目，避免滚动时误触
                if (r.y < L.listY - 1 || r.y + r.h > L.listY + L.listH + 1) continue;
                if (this.pointInRect(x, y, r)) {
                    this.tryPlaySpecialAd(this.specialPool[i]);
                    return;
                }
            }
        }

        // ---------- 广告奖励闭环 ----------
        , tryPlaySpecialAd(item) {
            const now = Date.now();
            if (!item) return;
            if (this._specialAdBusy || this._adPurpose) return;
            if (!this.specialPanelOpen) return;
            if (!this.specialPool.some(it => it.id === item.id)) return;

            if (DEBUG_SKIP_AD) {
                this.trackSpecial('debug_skip_ad', { scene: 'special' });
                try { wx.showToast({ title: '调测模式：跳过广告', icon: 'none' }); } catch (e) { }
                this.grantSpecialReward(item.id);
                return;
            }

            // 每局第一次特技免广告，直接发放，用于让玩家体验效果
            if (!this._specialFreeUsed) {
                this._specialFreeUsed = true;
                this.trackSpecial('free_use', { itemId: item.id });
                try { wx.showToast({ title: '本局首次特技免费', icon: 'none' }); } catch (e) { }
                this.grantSpecialReward(item.id, true);
                return;
            }

            if (now < this._specialCooldownUntil) return;

            if (!wx.createRewardedVideoAd) {
                wx.showToast({ title: '当前版本暂不支持广告', icon: 'none' });
                this._specialCooldownUntil = now + SPECIAL_AD_COOLDOWN;
                return;
            }

            this._specialAdBusy = true;
            this._specialPendingItemId = item.id;
            this._adPurpose = 'special';
            this._specialCooldownUntil = now + SPECIAL_AD_COOLDOWN;

            let loadSettled = false;
            const timeoutId = setTimeout(() => {
                if (loadSettled) return;
                loadSettled = true;
                this.failSpecialAd('广告加载中，请稍后重试');
            }, SPECIAL_AD_LOAD_TIMEOUT);

            try { wx.showLoading({ title: '广告加载中...', mask: true }); } catch (e) { }

            const proceed = (loaded) => {
                if (loadSettled) return;
                if (!loaded || !this.rewardedAd) {
                    loadSettled = true;
                    clearTimeout(timeoutId);
                    this.failSpecialAd('广告暂不可用，请稍后重试');
                    return;
                }

                // 加载已完成，后面的等待属于「播放」，交给 onClose / 看门狗处理
                loadSettled = true;
                clearTimeout(timeoutId);

                let showPromise;
                try { showPromise = this.rewardedAd.show(); } catch (e) {
                    this.failSpecialAd('广告播放失败，请稍后重试');
                    return;
                }

                if (!showPromise || typeof showPromise.then !== 'function') {
                    // 老版本基础库 show() 不返回 Promise，仍等待 onClose
                    try { wx.hideLoading(); } catch (e) { }
                    this._specialAdWatchdog = setTimeout(() => {
                        if (this._adPurpose === 'special') {
                            this.failSpecialAd('广告未完成，请稍后重试');
                        }
                    }, 90000);
                    return;
                }

                // 兜底：广告 SDK 未回调 onClose 时释放锁，避免 UI 卡死
                this._specialAdWatchdog = setTimeout(() => {
                    if (this._adPurpose === 'special') {
                        this.failSpecialAd('广告未完成，请稍后重试');
                    }
                }, 90000);

                showPromise.then(() => {
                    try { wx.hideLoading(); } catch (e) { }
                }).catch(() => {
                    this.failSpecialAd('广告播放失败，请稍后重试');
                });
            };

            this.loadRewardedAd().then(proceed).catch(() => proceed(false));
        }

        , failSpecialAd(msg) {
            clearTimeout(this._specialAdWatchdog);
            this._specialAdWatchdog = null;
            try { wx.hideLoading(); } catch (e) { }

            this._specialAdBusy = false;
            this._specialPendingItemId = null;
            this._adPurpose = null;
            // 加载超时/失败后释放 SDK 加载缓存，允许立即重试
            this.adLoading = false;
            this._adLoadPromise = null;
            this._specialCooldownUntil = Date.now() + SPECIAL_AD_COOLDOWN;

            this.trackSpecial('ad_fail', { msg: msg || '' });
            if (msg) {
                try { wx.showToast({ title: msg, icon: 'none' }); } catch (e) { }
            }
        }

        , finishSpecialAd(watched) {
            clearTimeout(this._specialAdWatchdog);
            this._specialAdWatchdog = null;
            try { wx.hideLoading(); } catch (e) { }

            const itemId = this._specialPendingItemId;
            this._specialAdBusy = false;
            this._specialPendingItemId = null;
            this._adPurpose = null;
            this._specialCooldownUntil = Date.now() + SPECIAL_AD_COOLDOWN;

            if (!watched) {
                this.trackSpecial('ad_incomplete');
                // 中途关闭：条目保留、库存不变，可再次点击
                try { wx.showToast({ title: '完整观看广告才能领取奖励', icon: 'none' }); } catch (e) { }
                return;
            }
            this.trackSpecial('ad_complete');
            this.grantSpecialReward(itemId);
        }

        , grantSpecialReward(itemId, isFree) {
            const idx = this.specialPool.findIndex(it => it.id === itemId);
            if (idx === -1) return;

            this.specialPool.splice(idx, 1);
            this.saveSpecialPool();

            this.addScore(SPECIAL_REWARD);
            this.trackSpecial('reward', { score: this.score, remain: this.specialPool.length, free: !!isFree });
            this.pushFloatText(
                isFree ? '🎁 +2048 首次特技免费！' : '🚀 +2048 特技加速！',
                this.width / 2, this.height / 2, 1500, 28
            );

            try {
                if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
            } catch (e) { }
        }

        // ---------- 绘制 ----------
        , drawBolt(cx, cy, size, color) {
            const ctx = this.ctx;
            const s = size / 2;
            ctx.save();
            ctx.translate(cx, cy);
            ctx.beginPath();
            ctx.moveTo(-0.10 * s, -1.00 * s);
            ctx.lineTo(0.62 * s, -1.00 * s);
            ctx.lineTo(0.10 * s, -0.12 * s);
            ctx.lineTo(0.66 * s, -0.12 * s);
            ctx.lineTo(-0.44 * s, 1.00 * s);
            ctx.lineTo(-0.12 * s, 0.14 * s);
            ctx.lineTo(-0.66 * s, 0.14 * s);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();
            ctx.restore();
        }

        // 特技池入口条（已缩短，左侧由「后悔」按钮占位，两者同行且不超出棋盘边框）
        , drawSpecialPoolBar() {
            const rect = this.specialPoolRect;
            if (!rect) return;

            const ctx = this.ctx;
            const count = this.specialPool.length;
            const active = count > 0;
            const now = Date.now();
            const pulse = 0.5 + 0.5 * Math.sin(now / 320);
            const cx = rect.x + 28;
            const cy = rect.y + rect.h / 2;
            const compact = rect.w < 210;  // 缩短后的紧凑布局：省略「特技池」文字

            ctx.save();

            // 有库存时呼吸外发光
            if (active) {
                ctx.globalAlpha = 0.16 + 0.16 * pulse;
                ctx.fillStyle = '#F2B179';
                this.roundRect(rect.x - 4, rect.y - 4, rect.w + 8, rect.h + 8, (rect.h + 8) / 2);
            }
            ctx.globalAlpha = 1;
            ctx.fillStyle = active ? '#F2B179' : '#E4DDD4';
            this.roundRect(rect.x, rect.y, rect.w, rect.h, rect.h / 2);

            ctx.globalAlpha = active ? 0.95 : 0.55;
            ctx.fillStyle = active ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.5)';
            ctx.beginPath();
            ctx.arc(cx, cy, 16, 0, Math.PI * 2);
            ctx.fill();

            ctx.globalAlpha = 1;
            this.drawBolt(cx, cy, 18, active ? '#FFF7E6' : '#B7ADA2');

            if (!compact) {
                ctx.fillStyle = active ? '#5C4A3A' : '#9C948B';
                ctx.font = this.getFont('bold', 18);
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText('特技池', rect.x + 52, cy);
            }

            ctx.fillStyle = active ? '#FFFFFF' : '#9C948B';
            ctx.font = this.getFont('bold', 20);
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(`[ ${count} / ${SPECIAL_CAP} ]`, rect.x + rect.w - 20, cy);

            ctx.restore();
        }

        // 方形倒计时进度：沿正方形周长顺时针绘制
        , strokeSquareProgress(cx, cy, half, remain) {
            const ctx = this.ctx;
            const d = half * 2;
            let left = d * 4 * Math.max(0, Math.min(1, remain));
            const corners = [
                [cx - half, cy - half],
                [cx + half, cy - half],
                [cx + half, cy + half],
                [cx - half, cy + half],
                [cx - half, cy - half]
            ];

            ctx.beginPath();
            ctx.moveTo(corners[0][0], corners[0][1]);
            for (let i = 1; i < corners.length && left > 0; i++) {
                const [ax, ay] = corners[i - 1];
                const [bx, by] = corners[i];
                const t = Math.min(1, left / d);
                ctx.lineTo(ax + (bx - ax) * t, ay + (by - ay) * t);
                left -= d;
            }
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();
            ctx.lineCap = 'butt';
            ctx.lineJoin = 'miter';
        }

        , drawSpecialPending(now) {
            const p = this.specialPending;
            if (!p) return;

            const elapsed = now - p.spawnAt;
            const remain = Math.max(0, 1 - elapsed / SPECIAL_FLOAT_MS);
            let alpha = 1;
            if (elapsed > SPECIAL_FLOAT_MS) {
                alpha = Math.max(0, 1 - (elapsed - SPECIAL_FLOAT_MS) / SPECIAL_FADE_MS);
            }
            if (alpha <= 0) return;

            const ctx = this.ctx;
            const appear = Math.min(1, elapsed / 180);
            const pulse = 1 + Math.sin(now / 190) * 0.04;
            const size = (this.specialButtonSize || 60) * pulse * (0.72 + 0.28 * appear);
            const half = size / 2;

            ctx.save();
            ctx.globalAlpha = alpha;

            // 外发光（正方形）
            ctx.fillStyle = 'rgba(237, 194, 46, 0.18)';
            ctx.fillRect(p.x - half - 6, p.y - half - 6, size + 12, size + 12);

            // 磨砂方形按钮
            ctx.save();
            ctx.shadowColor = 'rgba(237, 194, 46, 0.65)';
            ctx.shadowBlur = 18;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.46)';
            ctx.fillRect(p.x - half, p.y - half, size, size);
            ctx.restore();

            // 加粗的方形倒计时：描边中心压在按钮边框上（一半在内、一半在外），
            // 加粗后依然不会超出所在格子，48~66px 按钮下宽度约 6~8px
            const band = Math.max(6, Math.min(8, Math.round(size * 0.12)));

            // 轨道（未走完的部分，进度条会覆盖上去）
            ctx.lineWidth = band;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.62)';
            ctx.strokeRect(p.x - half, p.y - half, size, size);

            // 进度主体：时间越少越偏红，并加强发光，方便一眼看到
            if (remain > 0) {
                const low = remain <= 0.3;
                ctx.save();
                ctx.lineWidth = band;
                ctx.strokeStyle = low ? '#E85D3A' : '#F2994A';
                ctx.shadowColor = low ? 'rgba(232, 93, 58, 0.85)' : 'rgba(232, 131, 58, 0.80)';
                ctx.shadowBlur = low ? 12 : 8;
                this.strokeSquareProgress(p.x, p.y, half, remain);
                ctx.restore();
            }

            this.drawBolt(p.x, p.y - size * 0.10, size * 0.40, '#D9730D');

            ctx.fillStyle = '#5C4A3A';
            ctx.font = this.getFont('bold', Math.max(12, Math.round(size * 0.20)));
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('×' + SPECIAL_TRIGGER_VALUE, p.x, p.y + size * 0.22);

            ctx.restore();
        }

        , drawSpecialFlyers(now) {
            if (!this._specialFlyers.length) return;
            const pool = this.specialPoolRect;
            if (!pool) return;

            const ctx = this.ctx;
            const tx = pool.x + 28;
            const ty = pool.y + pool.h / 2;

            for (const f of this._specialFlyers) {
                const t = Math.min(1, (now - f.startAt) / SPECIAL_BANK_FLY_MS);
                const ease = t * t * (3 - 2 * t);
                const x = f.x + (tx - f.x) * ease;
                const y = f.y + (ty - f.y) * ease;
                const r = 18 * (1 - 0.4 * t);

                ctx.save();
                ctx.globalAlpha = 1 - t;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fillStyle = '#F2B179';
                ctx.fill();
                this.drawBolt(x, y, r * 0.95, '#FFF7E6');
                ctx.restore();
            }
        }

        , drawSpecialFloatTexts(now) {
            if (!this._specialFloatTexts.length) return;
            const ctx = this.ctx;

            for (const f of this._specialFloatTexts) {
                const t = Math.min(1, (now - f.startAt) / f.duration);
                const fadeIn = Math.min(1, t / 0.12);
                const fadeOut = t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.4);
                const alpha = fadeIn * fadeOut;
                if (alpha <= 0) continue;

                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.font = this.getFont('bold', f.size);
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.lineWidth = 4;
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.fillStyle = '#E8833A';
                const y = f.y - t * 64;
                ctx.strokeText(f.text, f.x, y);
                ctx.fillText(f.text, f.x, y);
                ctx.restore();
            }
        }

        , drawSpecialPanel() {
            if (!this.specialPanelOpen) return;
            if (this.gameOver || this.won) {
                this.closeSpecialPanel();
                return;
            }

            const ctx = this.ctx;
            const L = this.getSpecialPanelLayout();
            const count = this.specialPool.length;

            // 半透明遮罩
            ctx.save();
            ctx.fillStyle = 'rgba(35, 28, 24, 0.55)';
            ctx.fillRect(0, 0, this.width, this.height);

            // 浮动面板
            ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
            ctx.shadowBlur = 24;
            ctx.shadowOffsetY = 8;
            ctx.fillStyle = 'rgba(250, 248, 239, 0.98)';
            this.roundRect(L.panelX, L.panelY, L.panelW, L.panelH, 18);
            ctx.restore();

            // 标题
            this.drawBolt(L.panelX + 32, L.panelY + 34, 20, '#F2B179');
            ctx.fillStyle = COLORS.text.dark;
            ctx.font = this.getFont('bold', 22);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText('特技池', L.panelX + 50, L.panelY + 34);

            ctx.fillStyle = this._specialFreeUsed ? '#9C8B7B' : '#4C9A63';
            ctx.font = this.getFont('normal', 13);
            ctx.fillText(
                this._specialFreeUsed ? '观看广告，每次 +2048 分' : '本局首次使用免广告',
                L.panelX + 50, L.panelY + 58
            );

            ctx.fillStyle = '#8C7B6B';
            ctx.font = this.getFont('bold', 18);
            ctx.textAlign = 'right';
            ctx.fillText(`${count} / ${SPECIAL_CAP}`, L.closeRect.x - 8, L.panelY + 34);

            // 关闭按钮
            ctx.fillStyle = '#9C8B7B';
            ctx.font = this.getFont('bold', 26);
            ctx.textAlign = 'center';
            ctx.fillText('×', L.closeRect.x + L.closeRect.w / 2, L.closeRect.y + L.closeRect.h / 2 + 1);

            // 列表
            ctx.save();
            ctx.beginPath();
            ctx.rect(L.listX, L.listY, L.listW, L.listH);
            ctx.clip();

            if (count === 0) {
                ctx.fillStyle = '#A79B8E';
                ctx.font = this.getFont('normal', 18);
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('暂无特技', L.listX + L.listW / 2, L.listY + L.listH / 2 - 14);
                ctx.font = this.getFont('normal', 14);
                ctx.fillText(`合成 ${SPECIAL_TRIGGER_VALUE} 即可获得特技机会`, L.listX + L.listW / 2, L.listY + L.listH / 2 + 16);
            } else {
                const now = Date.now();
                const busy = this._specialAdBusy;
                const cooling = now < this._specialCooldownUntil;

                for (let i = 0; i < count; i++) {
                    const item = this.specialPool[i];
                    const r = this.getSpecialItemRect(i, L);
                    if (r.y + r.h < L.listY - 1 || r.y > L.listY + L.listH + 1) continue;

                    const loading = busy && this._specialPendingItemId === item.id;
                    const disabled = cooling || busy;
                    const pulse = 0.5 + 0.5 * Math.sin(now / 300);

                    ctx.fillStyle = disabled ? '#EDE8E1' : '#FFF6E7';
                    this.roundRect(r.x, r.y, r.w, r.h, 12);

                    if (!disabled) {
                        // 呼吸描边：先填外圈，再覆盖内圈，形成稳定的 1.5px 边框
                        ctx.save();
                        ctx.globalAlpha = 0.30 + 0.30 * pulse;
                        ctx.fillStyle = '#F2B179';
                        this.roundRect(r.x, r.y, r.w, r.h, 12);
                        ctx.restore();
                        ctx.save();
                        ctx.fillStyle = '#FFF6E7';
                        this.roundRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3, 10.5);
                        ctx.restore();
                    }

                    const icy = r.y + r.h / 2;
                    ctx.beginPath();
                    ctx.arc(r.x + 28, icy, 15, 0, Math.PI * 2);
                    ctx.fillStyle = disabled ? '#DCD5CC' : '#FCE7C8';
                    ctx.fill();
                    this.drawBolt(r.x + 28, icy, 17, disabled ? '#AFA69B' : '#E8833A');

                    ctx.fillStyle = disabled ? '#AFA69B' : '#B08D63';
                    ctx.font = this.getFont('bold', 14);
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(`#${i + 1}`, r.x + 52, icy);

                    ctx.fillStyle = disabled ? '#AFA69B' : COLORS.text.dark;
                    ctx.font = this.getFont('bold', 24);
                    ctx.fillText(String(SPECIAL_TRIGGER_VALUE), r.x + 88, icy);

                    ctx.font = this.getFont(loading ? 'normal' : 'bold', 14);
                    ctx.textAlign = 'right';
                    ctx.fillStyle = disabled ? '#AFA69B' : '#E8833A';
                    const tip = loading ? '加载中…' : (busy ? '请稍候' : '+2048 分');
                    ctx.fillText(tip, r.x + r.w - 16, icy);
                }
            }
            ctx.restore();

            // 滚动条
            if (L.maxScroll > 0) {
                const trackX = L.listX + L.listW - 3;
                const trackY = L.listY + 2;
                const trackH = L.listH - 4;
                const thumbH = Math.max(24, trackH * (L.listH / L.contentH));
                const thumbY = trackY + (trackH - thumbH) * (this._specialScroll / L.maxScroll);

                ctx.fillStyle = 'rgba(187, 173, 160, 0.22)';
                this.roundRect(trackX, trackY, 3, trackH, 1.5);
                ctx.fillStyle = 'rgba(187, 173, 160, 0.6)';
                this.roundRect(trackX, thumbY, 3, thumbH, 1.5);
            }
        }
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = SpecialMixin;
    } else {
        global.FK_SPECIAL = SpecialMixin;
    }
})(typeof GameGlobal !== 'undefined' ? GameGlobal : (typeof window !== 'undefined' ? window : this));
