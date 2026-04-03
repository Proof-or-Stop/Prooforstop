/**
 * game 项目 test-runtime
 * 引用编译后的 game-logic.js，测试真实代码
 * 运行前：npx tsc --outDir dist --module commonjs --moduleResolution node
 */

const { Game } = require('../dist/game-logic.js');

let game = new Game();

module.exports = {
  createTestHandlers() {
    return {
      createGame() {
        game = new Game();
        return game;
      },
      Game() {
        game = new Game();
        return game;
      },
      reset() {
        return game.reset();
      },
      checkWin(input) {
        return game.checkWin(input.r, input.c, input.player);
      },
      place(input) {
        return game.place(input.r, input.c);
      },
      undo() {
        return game.undo();
      },
      getState() {
        return game.getState();
      },
    };
  },
};
