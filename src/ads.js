/**
 * 微信广告 SDK 模块（初始化 / 加载 / 按场景展示 / 奖励路由）
 * 场景：revive=复活  special=特技加速（闭环另有处理）  undo=后悔回撤
 * 通过 Object.assign(Game.prototype, FK_ADS) 混入
 */
(function (global) {
    'use strict';

    const C = (typeof require === 'function')
        ? require('./config.js')
        : (global && global.FK_CONFIG) || {};

    // 模块依赖：config → ads
    const { DEBUG_SKIP_AD } = C;

    const AdsMixin = {

        // ---------- 广告初始化与加载 ----------
        initRewardedAd() {
            if (DEBUG_SKIP_AD) return;
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
                // onClose 同时服务于「复活」「特技加速」「后悔回撤」三种场景
                const purpose = this._adPurpose;
                this._adPurpose = null;
                const watched = !!(res && res.isEnded);

                if (purpose === 'special') {
                    this.finishSpecialAd(watched);
                } else if (purpose === 'undo') {
                    try { wx.hideLoading(); } catch (e) { }
                    if (watched) {
                        console.log('广告观看完成，给予回撤奖励');
                        this.onUndoAdReward();
                    } else {
                        console.log('用户中途关闭广告');
                        this.trackSpecial('undo_ad_incomplete');
                        try { wx.showToast({ title: '完整观看广告才能回撤', icon: 'none' }); } catch (e) { }
                    }
                } else if (purpose === 'revive') {
                    try { wx.hideLoading(); } catch (e) { }
                    if (watched) {
                        console.log('广告观看完成，给予复活奖励');
                        this.onAdReward();
                    } else {
                        console.log('用户中途关闭广告');
                    }
                }

                this.adLoaded = false;
                this.adLoading = false;
                this._adLoadPromise = null;
                // 预加载下一条
                setTimeout(() => {
                    if (!this._adPurpose && !this._specialAdBusy) this.loadRewardedAd();
                }, 800);
            });
        },

        loadRewardedAd() {
            if (DEBUG_SKIP_AD) return Promise.resolve(true);
            if (this.adLoaded) return Promise.resolve(true);
            if (!wx.createRewardedVideoAd) return Promise.resolve(false);
            // 复用进行中的加载，避免重复 load 导致 SDK 报错
            if (this._adLoadPromise) return this._adLoadPromise;

            this.initRewardedAd();
            if (!this.rewardedAd) return Promise.resolve(false);

            this.adLoading = true;
            let loadResult;
            try {
                loadResult = this.rewardedAd.load();
            } catch (e) {
                this.adLoading = false;
                return Promise.resolve(false);
            }

            const p = Promise.resolve(loadResult).then(() => {
                this.adLoaded = true;
                if (this._adLoadPromise === p) {
                    this.adLoading = false;
                    this._adLoadPromise = null;
                }
                return true;
            }).catch((err) => {
                this.adLoaded = false;
                if (this._adLoadPromise === p) {
                    this.adLoading = false;
                    this._adLoadPromise = null;
                }
                console.error('广告加载失败', err);
                return false;
            });
            this._adLoadPromise = p;
            return p;
        },

        // ---------- 广告展示（按 scene 路由奖励） ----------
        showRewardedAd(scene) {
            const purpose = scene || 'revive';

            if (DEBUG_SKIP_AD) {
                this.trackSpecial('debug_skip_ad', { scene: purpose });
                try { wx.showToast({ title: '调测模式：跳过广告', icon: 'none' }); } catch (e) { }
                this.grantRewardedEffect(purpose);
                return;
            }
            if (!wx.createRewardedVideoAd) {
                wx.showToast({ title: '当前版本不支持广告', icon: 'none' });
                return;
            }
            if (this._adPurpose || this._specialAdBusy) return;

            this._adPurpose = purpose;
            const resetPurpose = () => {
                if (this._adPurpose === purpose) this._adPurpose = null;
            };

            const show = () => {
                if (!this.rewardedAd) {
                    resetPurpose();
                    wx.showToast({ title: '广告暂不可用', icon: 'none' });
                    return;
                }
                this.rewardedAd.show().catch((err) => {
                    console.error('广告展示失败', err);
                    resetPurpose();
                    this.adLoaded = false;
                    wx.showToast({ title: '广告展示失败', icon: 'none' });
                    this.loadRewardedAd();
                });
            };

            if (this.adLoaded && this.rewardedAd) {
                show();
            } else {
                wx.showLoading({ title: '广告加载中...' });
                this.loadRewardedAd().then((loaded) => {
                    wx.hideLoading();
                    if (loaded && this.rewardedAd) {
                        show();
                    } else {
                        resetPurpose();
                        wx.showToast({ title: '广告暂不可用', icon: 'none' });
                    }
                });
            }
        },

        // 按场景发放奖励（调试模式与 show 成功后的公共出口）
        grantRewardedEffect(purpose) {
            if (purpose === 'undo') {
                this.onUndoAdReward();
            } else {
                this.onAdReward();
            }
        },

        // ---------- 复活奖励 ----------
        onAdReward() {
            console.log('复活奖励：继续游戏');
            try { wx.hideLoading(); } catch (e) { }

            this.overlayButtons = null;
            this.closeSpecialPanel();

            // 复活必须真正腾出空间：移除 2 个最小方块，避免满盘复活后立刻再次 Game Over
            const cells = [];
            const n = this.gridSize;
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    const value = this.grid[y][x];
                    if (value) cells.push({ x, y, value });
                }
            }
            cells.sort((a, b) => a.value - b.value || b.y - a.y || b.x - a.x);
            const removeCount = Math.min(2, cells.length);
            for (let i = 0; i < removeCount; i++) {
                this.grid[cells[i].y][cells[i].x] = null;
            }

            this.syncTilesWithGrid();
            this.setState(C.GameState.PLAYING);
            this.trackSpecial('revive', { removed: removeCount });
        }
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = AdsMixin;
    } else {
        global.FK_ADS = AdsMixin;
    }
})(typeof GameGlobal !== 'undefined' ? GameGlobal : (typeof window !== 'undefined' ? window : this));
