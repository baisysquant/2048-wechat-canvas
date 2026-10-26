/**
 * 方块实体模块（微信小游戏 require / 浏览器 window 双环境）
 */
(function (global) {
    'use strict';

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

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Tile;
    } else {
        global.FK_TILE = Tile;
    }
})(typeof GameGlobal !== 'undefined' ? GameGlobal : (typeof window !== 'undefined' ? window : this));
