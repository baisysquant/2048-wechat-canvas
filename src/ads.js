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
    const { DEBUG_SKIP_AD, SPECIAL_AD_LOAD_TIMEOUT, AD_PLAY_WATCHDOG_MS } = C;

    // ===== 广告位配置（上线前替换为真实 adUnitId） =====
    // 当前只创建一个激励视频实例，统一读取 revive；special / undo 为预留位，
    // 后续若要按场景拆分流量位，需要同步改造 special.js 的展示逻辑。
    const AD_UNIT_IDS = Object.assign({
        revive: 'adunit-xxxxxxxx',
        special: 'adunit-xxxxxxxx',
        undo: 'adunit-xxxxxxxx'
    }, (global && global.FK_AD_UNITS) || {});   // 测试环境可注入覆盖

    // 占位符（adunit-xxxx...）或格式不合法时视为未配置
    function isValidAdUnitId(id) {
        if (typeof id !== 'string') return false;
        if (!/^adunit-[0-9a-zA-Z]{6,}$/.test(id)) return false;
        return !/^adunit-x+$/i.test(id);
    }

    const AdsMixin = {

        // ---------- 广告初始化与加载 ----------
        initRewardedAd() {
            if (DEBUG_SKIP_AD) return;
            if (this._rewardedAdInited) return;
            if (!wx.createRewardedVideoAd) {
                console.warn('当前基础库不支持激励视频广告');
                return;
            }

            const adUnitId = AD_UNIT_IDS.revive;
            if (!isValidAdUnitId(adUnitId)) {
                // 记账，避免每次 onShow 重复报错；各广告入口统一走“广告暂不可用”降级
                this._rewardedAdInited = true;
                this._adConfigInvalid = true;
                console.error(
                    '[Ads] 广告位 ID 无效（仍是占位符或格式错误），广告功能已禁用。' +
                    '请到 src/ads.js 顶部替换 AD_UNIT_IDS 后重新上传。'
                );
                return;
            }

            this._adConfigInvalid = false;
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
                // 清理通用链路的加载超时与播放看门狗
                clearTimeout(this._adLoadTimer);
                this._adLoadTimer = null;
                clearTimeout(this._adWatchdog);
                this._adWatchdog = null;

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
                        this.showHint('完整观看广告才能回撤');
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

        // 通用链路失败出口：统一释放锁、清定时器、提示并埋点
        failGeneralAd(purpose, msg) {
            clearTimeout(this._adLoadTimer);
            this._adLoadTimer = null;
            clearTimeout(this._adWatchdog);
            this._adWatchdog = null;
            try { wx.hideLoading(); } catch (e) { }

            if (!purpose || this._adPurpose === purpose) this._adPurpose = null;
            this.adLoaded = false;
            this.adLoading = false;
            this._adLoadPromise = null;

            if (msg) {
                console.warn('[Ads]', msg);
                this.showHint(msg);
            }
            this.trackSpecial('ad_fail', { scene: purpose || 'unknown', msg: msg || '' });
        },

        // ---------- 广告展示（按 scene 路由奖励） ----------
        showRewardedAd(scene) {
            const purpose = scene || 'revive';

            if (DEBUG_SKIP_AD) {
                this.trackSpecial('debug_skip_ad', { scene: purpose });
                this.showHint('调测模式：跳过广告');
                this.grantRewardedEffect(purpose);
                return;
            }
            if (!wx.createRewardedVideoAd) {
                this.showHint('当前版本不支持广告');
                return;
            }
            if (this._adPurpose || this._specialAdBusy) return;

            // 懒初始化：启动后 2s 才预载，首次点击可能更早
            this.initRewardedAd();

            // 广告位未配置 / 无效：直接降级，绝不进入 loading 或占用 _adPurpose
            if (!this.rewardedAd) {
                this.showHint('广告暂不可用');
                return;
            }

            this._adPurpose = purpose;
            try { wx.showLoading({ title: '广告加载中...', mask: true }); } catch (e) { }

            const show = () => {
                // 加载超时 / 看门狗已判负时不再展示
                if (this._adPurpose !== purpose) return;

                let showResult;
                try {
                    showResult = this.rewardedAd.show();
                } catch (e) {
                    this.failGeneralAd(purpose, '广告播放失败，请稍后重试');
                    return;
                }

                if (showResult && typeof showResult.then === 'function') {
                    showResult.then(() => {
                        try { wx.hideLoading(); } catch (e) { }
                    }).catch(() => {
                        this.failGeneralAd(purpose, '广告播放失败，请稍后重试');
                    });
                } else {
                    // 老版本基础库 show() 不返回 Promise，仍等待 onClose
                    try { wx.hideLoading(); } catch (e) { }
                }

                // 播放看门狗：SDK 长时间不回调 onClose 时释放锁，
                // 避免复活 / 后悔 / 特技被 _adPurpose 永久锁死
                clearTimeout(this._adWatchdog);
                this._adWatchdog = setTimeout(() => {
                    if (this._adPurpose === purpose) {
                        this.failGeneralAd(purpose, '广告未完成，奖励未发放');
                    }
                }, AD_PLAY_WATCHDOG_MS);
            };

            if (this.adLoaded) {
                show();
                return;
            }

            // 加载超时：防止 loading 转圈永久挂起
            clearTimeout(this._adLoadTimer);
            this._adLoadTimer = setTimeout(() => {
                if (this._adPurpose === purpose) {
                    this.failGeneralAd(purpose, '广告加载超时，请稍后重试');
                }
            }, SPECIAL_AD_LOAD_TIMEOUT);

            this.loadRewardedAd().then((loaded) => {
                clearTimeout(this._adLoadTimer);
                this._adLoadTimer = null;
                if (this._adPurpose !== purpose) return;   // 已超时 / 已取消
                if (loaded && this.rewardedAd) {
                    show();
                } else {
                    this.failGeneralAd(purpose, '广告暂不可用，请稍后重试');
                }
            });
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

            this.clearOverlay();
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
