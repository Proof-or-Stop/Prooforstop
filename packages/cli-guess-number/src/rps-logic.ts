export type Move = 'rock' | 'paper' | 'scissors';
export type RpsOutcome = 'win' | 'lose' | 'draw';

export interface RpsResult {
  playerMove: Move;
  computerMove: Move;
  outcome: RpsOutcome;
}

export interface RpsState {
  wins: number;
  losses: number;
  draws: number;
  rounds: number;
}

const MOVE_NAMES: Record<Move, string> = {
  rock: '石头',
  paper: '布',
  scissors: '剪刀',
};

const INPUT_MAP: Record<string, Move> = {
  '1': 'rock',
  '2': 'scissors',
  '3': 'paper',
  rock: 'rock',
  scissors: 'scissors',
  paper: 'paper',
  '石头': 'rock',
  '剪刀': 'scissors',
  '布': 'paper',
};

export function createRpsState(): RpsState {
  return { wins: 0, losses: 0, draws: 0, rounds: 0 };
}

export function parseMove(input: string): Move | null {
  return INPUT_MAP[input.trim().toLowerCase()] ?? null;
}

export function randomMove(): Move {
  const moves: Move[] = ['rock', 'paper', 'scissors'];
  return moves[Math.floor(Math.random() * 3)];
}

export function judge(player: Move, computer: Move): RpsOutcome {
  if (player === computer) return 'draw';
  if (
    (player === 'rock' && computer === 'scissors') ||
    (player === 'scissors' && computer === 'paper') ||
    (player === 'paper' && computer === 'rock')
  ) {
    return 'win';
  }
  return 'lose';
}

export function play(state: RpsState, playerMove: Move, computerMove?: Move): RpsResult {
  const cm = computerMove ?? randomMove();
  const outcome = judge(playerMove, cm);
  state.rounds++;
  if (outcome === 'win') state.wins++;
  else if (outcome === 'lose') state.losses++;
  else state.draws++;
  return { playerMove, computerMove: cm, outcome };
}

export function moveName(move: Move): string {
  return MOVE_NAMES[move];
}
