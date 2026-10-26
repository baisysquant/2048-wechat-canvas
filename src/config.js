/**
 * 全局配置与常量模块
 * 双环境加载：微信小游戏 use require('./src/config.js')；浏览器测试 use window.FK_CONFIG
 */
(function (global) {
    'use strict';

    // ===== 调测开关（上线前必须改为 false） =====
    // true  = 调测模式：复活 / 特技加速 / 后悔回撤都跳过激励视频，直接发放效果
    // false = 正式模式：正常播放激励视频
    const DEBUG_SKIP_AD = false;

    // ===== 棋盘 =====
    const TILE_SIZE = 100;
    const GAP = 12;
    const DEFAULT_GRID_SIZE = 4;            // 默认 4x4，可在难度弹框中选择 5x5
    const DIFFICULTY_SAVE_KEY = 'fk2048_difficulty';  // 上次选择的难度（记录用）

    // ===== 动画 =====
    const ANIMATION_DURATION = 100;
    const ANIM_SCALE_SPEED = 10;      // pop-in speed
    const ANIM_MOVE_SPEED = 10;       // slide speed
    const ANIM_MERGE_POP_SPEED = 3;   // merge pop speed
    const ANIM_FADE_SPEED = 5;        // fade out speed
    const ANIM_POS_THRESHOLD = 0.05;  // position snap threshold

    // ===== UI =====
    const TITLE_FONT_SIZE = 64;
    const TITLE_MARGIN = 30;
    const SCORE_BOX_W = 160;
    const SCORE_BOX_H = 80;
    const SCORE_LABEL_Y = 25;
    const SCORE_VALUE_Y = 55;
    const BOARD_ADJACENT_GAP = 26; // 分数组/特技池与棋盘保持同一垂直间距
    const BOARD_TOP_MARGIN = 220;
    const BOARD_SIDE_MARGIN = 30;
    const BOARD_BOTTOM_RESERVE = 320;

    // ===== 特技加速（Special Boost） =====
    const SPECIAL_TRIGGER_VALUE = 512;      // 仅合成 512 触发（256 + 256）
    const SPECIAL_CAP = 10;                 // 特技池上限
    const SPECIAL_MAX_PER_GAME = 10;        // 单局最多获得次数
    const SPECIAL_REWARD = 2048;            // 每次广告奖励分数
    const SPECIAL_FLOAT_MS = 10000;         // 棋盘闪烁按钮存在时长
    const SPECIAL_FADE_MS = 260;            // 倒计时结束后的渐隐时长
    const SPECIAL_BANK_FLY_MS = 380;        // 沉入底池的飞行动画
    const SPECIAL_AD_LOAD_TIMEOUT = 5000;   // 广告加载超时
    const SPECIAL_AD_COOLDOWN = 1000;       // 点击冷却
    const SPECIAL_SAVE_KEY = 'fk2048_special_pool';
    const AD_PLAY_WATCHDOG_MS = 90000;      // 广告播放兜底看门狗：SDK 未回调 onClose 时释放锁

    // ===== 后悔回撤（Undo） =====
    const UNDO_STEPS = 5;             // 每次点击回撤步数
    const UNDO_FREE_COUNT = 5;        // 每盘局免费次数，之后需看广告
    const UNDO_HISTORY_CAP = 60;      // 操作历史上限
    const UNDO_ROW_GAP = 12;          // 后悔按钮与特技池的间距

    // ===== 游戏状态机 =====
    const GameState = {
        IDLE: 'idle',                 // 等待难度选择
        PLAYING: 'playing',
        ANIMATING: 'animating',
        WON: 'won',
        GAME_OVER: 'game_over',
        AD_PLAYING: 'ad_playing'
    };

    const StateTransitions = {
        [GameState.IDLE]: [GameState.PLAYING],
        [GameState.PLAYING]: [GameState.ANIMATING, GameState.WON, GameState.GAME_OVER],
        [GameState.ANIMATING]: [GameState.PLAYING, GameState.WON, GameState.GAME_OVER],
        [GameState.WON]: [GameState.PLAYING, GameState.IDLE],
        [GameState.GAME_OVER]: [GameState.IDLE, GameState.PLAYING, GameState.AD_PLAYING],
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

    const config = {
        DEBUG_SKIP_AD,
        TILE_SIZE, GAP, DEFAULT_GRID_SIZE, DIFFICULTY_SAVE_KEY,
        ANIMATION_DURATION,
        ANIM_SCALE_SPEED, ANIM_MOVE_SPEED, ANIM_MERGE_POP_SPEED, ANIM_FADE_SPEED, ANIM_POS_THRESHOLD,
        TITLE_FONT_SIZE, TITLE_MARGIN, SCORE_BOX_W, SCORE_BOX_H, SCORE_LABEL_Y, SCORE_VALUE_Y,
        BOARD_ADJACENT_GAP, BOARD_TOP_MARGIN, BOARD_SIDE_MARGIN, BOARD_BOTTOM_RESERVE,
        SPECIAL_TRIGGER_VALUE, SPECIAL_CAP, SPECIAL_MAX_PER_GAME, SPECIAL_REWARD,
        SPECIAL_FLOAT_MS, SPECIAL_FADE_MS, SPECIAL_BANK_FLY_MS,
        SPECIAL_AD_LOAD_TIMEOUT, SPECIAL_AD_COOLDOWN, SPECIAL_SAVE_KEY,
        UNDO_STEPS, UNDO_FREE_COUNT, UNDO_HISTORY_CAP, UNDO_ROW_GAP,
        GameState, StateTransitions, COLORS
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = config;
    } else {
        global.FK_CONFIG = config;
    }
})(typeof GameGlobal !== 'undefined' ? GameGlobal : (typeof window !== 'undefined' ? window : this));
