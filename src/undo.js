/**
 * 后悔回撤模块（Undo）
 * 点击「后悔」按钮：回撤最近 5 步，分数随之回滚；每盘局免费 5 次，之后需完整观看广告
 * 通过 Object.assign(Game.prototype, FK_UNDO) 混入
 */
(function (global) {
    'use strict';

    const C = (typeof require === 'function')
        ? require('./config.js')
        : (global && global.FK_CONFIG) || {};

    // 模块依赖：config → undo
    const {
        DEBUG_SKIP_AD, UNDO_STEPS, UNDO_FREE_COUNT, UNDO_HISTORY_CAP, GameState, COLORS
    } = C;

    const UndoMixin = {

        // ---------- 快照与历史 ----------
        // 快照仅包含棋盘数值与分数，不涉及特技池 / 闪烁机会
        takeUndoSnapshot() {
            const n = this.gridSize;
            const grid = [];
            for (let y = 0; y < n; y++) {
                grid.push(this.grid[y] ? this.grid[y].slice() : new Array(n).fill(null));
            }
            return { grid, score: this.score };
        },

        clearUndoHistory() {
            this._undoHistory = [];
            this._undoFreeLeft = UNDO_FREE_COUNT;  // 每盘局免费次数
        },

        // ---------- 入口：点击「后悔」按钮 ----------
        tryUndo() {
            // 动画中 / 广告进行中 / 特技弹窗打开时不可用
            if (this.animating || this._specialAdBusy || this._adPurpose || this.specialPanelOpen) return;

            // 仅允许在正常对局或失败弹窗（后悔可救回败局）时使用
            const st = this._state;
            if (st !== GameState.PLAYING && st !== GameState.GAME_OVER) return;

            if (!this._undoHistory || this._undoHistory.length === 0) {
                this.showHint('没有可回撤的操作');
                return;
            }

            // 每盘局 5 次免费，用完后需观看广告
            if (this._undoFreeLeft > 0) {
                this._undoFreeLeft--;
                const remain = this._undoFreeLeft;
                this.applyUndo(remain > 0 ? `免费剩 ${remain} 次` : '免费次数已用完');
                return;
            }

            if (DEBUG_SKIP_AD) {
                this.trackSpecial('debug_skip_ad', { scene: 'undo' });
                this.showHint('调测模式：跳过广告');
                this.applyUndo();
                return;
            }

            // 第 6 次起：完整观看广告后才生效
            this.showRewardedAd('undo');
        },

        // 广告完整观看后回撤
        onUndoAdReward() {
            try { wx.hideLoading(); } catch (e) { }
            this.clearOverlay();
            this.applyUndo();
        },

        // ---------- 执行回撤 ----------
        applyUndo(suffix) {
            const history = this._undoHistory || [];
            if (history.length === 0) return;

            // 弹出最近 min(UNDO_STEPS, len) 条快照，目标状态是其中最早的一条
            const k = Math.min(UNDO_STEPS, history.length);
            let target = null;
            for (let i = 0; i < k; i++) target = history.pop();

            // 还原棋盘与分数
            this.grid = target.grid.map(row => row.slice());
            this.score = target.score;
            this.clearOverlay();
            this.closeSpecialPanel();
            this.syncTilesWithGrid();

            // 失败 / 胜利 / 动画状态回撤后都回到可操作状态
            if (this._state === GameState.GAME_OVER || this._state === GameState.WON ||
                this._state === GameState.ANIMATING) {
                this.setState(GameState.PLAYING);
            }

            // 回撤后的棋盘若仍含 2048，标记已弹过胜利框，避免重复打扰
            if (this.grid.some(row => row.some(v => v >= 2048))) {
                this.wonShown = true;
            }

            try { if (wx.vibrateShort) wx.vibrateShort({ type: 'light' }); } catch (e) { }
            this.soundPlay('undo');   // 柔和下滑音
            this.showHint(`↩ 已回撤 ${k} 步` + (suffix ? ` · ${suffix}` : ''));
            this.trackSpecial('undo', { steps: k, freeLeft: this._undoFreeLeft, score: this.score });
        },

        // ---------- 绘制（与特技池同一行，位于其左侧） ----------
        drawUndoButton() {
            const rect = this.undoRect;
            if (!rect) return;
            const ctx = this.ctx;
            const count = (this._undoHistory || []).length;
            const usable = count > 0;
            const freeLeft = this._undoFreeLeft;
            const cy = rect.y + rect.h / 2;
            const cx = rect.x + rect.w / 2;

            ctx.save();

            // 背景胶囊
            ctx.fillStyle = usable ? '#8F7A66' : '#E4DDD4';
            this.roundRect(rect.x, rect.y, rect.w, rect.h, rect.h / 2);

            // 主文案
            ctx.fillStyle = usable ? COLORS.text.light : '#9C948B';
            ctx.font = this.getFont('bold', 18);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('后悔', cx, rect.y + rect.h / 2 - (rect.w >= 100 ? 7 : 0));

            // 副文案：免费次数 / 需看广告
            if (rect.w >= 100) {
                ctx.font = this.getFont('normal', 11);
                ctx.fillStyle = usable ? 'rgba(255,255,255,0.85)' : '#A79B8E';
                ctx.fillText(freeLeft > 0 ? `免费 ×${freeLeft}` : '完整看广告', cx, rect.y + rect.h - 12);
            }

            ctx.restore();
        }
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = UndoMixin;
    } else {
        global.FK_UNDO = UndoMixin;
    }
})(typeof GameGlobal !== 'undefined' ? GameGlobal : (typeof window !== 'undefined' ? window : this));
