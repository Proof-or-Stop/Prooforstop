/**
 * 五子棋逻辑层（纯业务规则，无 DOM 依赖）
 * 数据类型和状态初始化由 game-data.ts 提供
 */

import { SIZE, createEmptyState, type Player, type Cell } from './game-data.js';

// re-export 数据层，下游只需 import game-logic 即可
export { SIZE, createEmptyState, cloneState } from './game-data.js';
export type { Player, Cell, GameState } from './game-data.js';

export class Game {
  board: Cell[][];
  current: Player;
  moves: [number, number][];
  gameOver: boolean;
  winLine: [number, number][];

  constructor() {
    const s = createEmptyState();
    this.board = s.board;
    this.current = s.current;
    this.moves = s.moves;
    this.gameOver = s.gameOver;
    this.winLine = s.winLine;
  }

  reset(): Game {
    const s = createEmptyState();
    this.board = s.board;
    this.current = s.current;
    this.moves = s.moves;
    this.gameOver = s.gameOver;
    this.winLine = s.winLine;
    return this;
  }

  checkWin(r: number, c: number, player: Player): [number, number][] | null {
    const dirs: [number, number][] = [[0,1],[1,0],[1,1],[1,-1]];
    for (const [dr, dc] of dirs) {
      const line: [number, number][] = [[r, c]];
      for (let d = -1; d <= 1; d += 2) {
        for (let i = 1; i < 5; i++) {
          const nr = r + dr * d * i;
          const nc = c + dc * d * i;
          if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;
          if (this.board[nr][nc] !== player) break;
          line.push([nr, nc]);
        }
      }
      if (line.length >= 5) {
        line.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        return line;
      }
    }
    return null;
  }

  place(r: number, c: number): { success: boolean; win: boolean; draw: boolean } {
    if (this.gameOver || r < 0 || r >= SIZE || c < 0 || c >= SIZE || this.board[r][c] !== 0) {
      return { success: false, win: false, draw: false };
    }

    this.board[r][c] = this.current;
    this.moves.push([r, c]);

    const win = this.checkWin(r, c, this.current);
    if (win) {
      this.winLine = win;
      this.gameOver = true;
      return { success: true, win: true, draw: false };
    }

    if (this.moves.length === SIZE * SIZE) {
      this.gameOver = true;
      return { success: true, win: false, draw: true };
    }

    this.current = this.current === 1 ? 2 : 1;
    return { success: true, win: false, draw: false };
  }

  undo(): boolean {
    if (this.moves.length === 0 || this.gameOver) return false;
    const [r, c] = this.moves.pop()!;
    this.board[r][c] = 0;
    this.current = this.current === 1 ? 2 : 1;
    this.gameOver = false;
    this.winLine = [];
    return true;
  }

  getState(): { current: Player; moves: number; gameOver: boolean; winLine: [number, number][] } {
    return {
      current: this.current,
      moves: this.moves.length,
      gameOver: this.gameOver,
      winLine: this.winLine,
    };
  }
}
