/**
 * 五子棋数据层（纯状态定义与初始化，无业务逻辑）
 */

export const SIZE = 15;

export type Player = 1 | 2;
export type Cell = 0 | Player;

export interface GameState {
  board: Cell[][];
  current: Player;
  moves: [number, number][];
  gameOver: boolean;
  winLine: [number, number][];
}

/** 创建空白游戏状态 */
export function createEmptyState(): GameState {
  return {
    board: Array.from({ length: SIZE }, () => Array(SIZE).fill(0) as Cell[]),
    current: 1,
    moves: [],
    gameOver: false,
    winLine: [],
  };
}

/** 深拷贝游戏状态 */
export function cloneState(state: GameState): GameState {
  return {
    board: state.board.map(row => [...row]),
    current: state.current,
    moves: state.moves.map(m => [...m] as [number, number]),
    gameOver: state.gameOver,
    winLine: state.winLine.map(w => [...w] as [number, number]),
  };
}
