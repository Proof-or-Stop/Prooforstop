export interface GuessResult {
  correct: boolean;
  hint: 'too-high' | 'too-low' | 'correct';
  attempts: number;
}

export interface GameState {
  target: number;
  min: number;
  max: number;
  attempts: number;
  finished: boolean;
}

export function createGame(min = 1, max = 100): GameState {
  const target = Math.floor(Math.random() * (max - min + 1)) + min;
  return { target, min, max, attempts: 0, finished: false };
}

export function createGameWithTarget(target: number, min = 1, max = 100): GameState {
  return { target, min, max, attempts: 0, finished: false };
}

export function guess(state: GameState, value: number): GuessResult {
  if (state.finished) {
    throw new Error('Game is already finished');
  }

  state.attempts++;

  if (value === state.target) {
    state.finished = true;
    return { correct: true, hint: 'correct', attempts: state.attempts };
  }

  return {
    correct: false,
    hint: value > state.target ? 'too-high' : 'too-low',
    attempts: state.attempts,
  };
}

export function isValidGuess(state: GameState, value: number): string | null {
  if (!Number.isInteger(value)) return '请输入整数';
  if (value < state.min || value > state.max) return `请输入 ${state.min}-${state.max} 之间的数字`;
  return null;
}
