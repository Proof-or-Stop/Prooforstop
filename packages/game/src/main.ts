import { SIZE, Game, type Player } from './game-logic.js';

const CELL = 40;
const PAD = 30;
const BOARD_PX = PAD * 2 + CELL * (SIZE - 1);
const PIECE_R = CELL * 0.42;

let game = new Game();

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statusEl = document.getElementById('status')!;
const undoBtn = document.getElementById('undo') as HTMLButtonElement;

canvas.width = BOARD_PX;
canvas.height = BOARD_PX;

function init() {
  game = new Game();
  render();
}

function render() {
  drawBoard();
  drawPieces();
  drawWinLine();
  updateStatus();
  updateUndoButton();
}

function drawBoard() {
  ctx.fillStyle = '#dcb35c';
  ctx.fillRect(0, 0, BOARD_PX, BOARD_PX);

  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    const p = PAD + i * CELL;
    ctx.beginPath();
    ctx.moveTo(PAD, p);
    ctx.lineTo(PAD + (SIZE - 1) * CELL, p);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p, PAD);
    ctx.lineTo(p, PAD + (SIZE - 1) * CELL);
    ctx.stroke();
  }

  const stars = SIZE === 15 ? [[3,3],[3,11],[7,7],[11,3],[11,11]] : [[3,3],[3,9],[6,6],[9,3],[9,9]];
  for (const [r, c] of stars) {
    ctx.beginPath();
    ctx.arc(PAD + c * CELL, PAD + r * CELL, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#333';
    ctx.fill();
  }
}

function drawPieces() {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (game.board[r][c] === 0) continue;
      drawPiece(r, c, game.board[r][c] as Player);
    }
  }
}

function drawPiece(r: number, c: number, player: Player) {
  const x = PAD + c * CELL;
  const y = PAD + r * CELL;

  ctx.beginPath();
  ctx.arc(x, y, PIECE_R, 0, Math.PI * 2);

  if (player === 1) {
    const grad = ctx.createRadialGradient(x - 3, y - 3, 2, x, y, PIECE_R);
    grad.addColorStop(0, '#555');
    grad.addColorStop(1, '#111');
    ctx.fillStyle = grad;
  } else {
    const grad = ctx.createRadialGradient(x - 3, y - 3, 2, x, y, PIECE_R);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(1, '#ccc');
    ctx.fillStyle = grad;
  }
  ctx.fill();

  ctx.strokeStyle = player === 1 ? '#000' : '#999';
  ctx.lineWidth = 1;
  ctx.stroke();

  if (game.moves.length > 0) {
    const [lr, lc] = game.moves[game.moves.length - 1];
    if (r === lr && c === lc) {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#e44';
      ctx.fill();
    }
  }
}

function drawWinLine() {
  if (game.winLine.length === 0) return;
  const [r0, c0] = game.winLine[0];
  const [r1, c1] = game.winLine[game.winLine.length - 1];
  ctx.beginPath();
  ctx.moveTo(PAD + c0 * CELL, PAD + r0 * CELL);
  ctx.lineTo(PAD + c1 * CELL, PAD + r1 * CELL);
  ctx.strokeStyle = '#e44';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function updateStatus() {
  if (game.gameOver && game.winLine.length > 0) {
    const color = game.current === 1 ? 'black' : 'white';
    const name = game.current === 1 ? '黑棋' : '白棋';
    statusEl.innerHTML = `<span class="dot ${color}"></span>${name} 获胜!`;
  } else if (game.gameOver) {
    statusEl.textContent = '平局!';
  } else {
    const color = game.current === 1 ? 'black' : 'white';
    const name = game.current === 1 ? '黑棋' : '白棋';
    statusEl.innerHTML = `<span class="dot ${color}"></span>${name} 落子`;
  }
}

function updateUndoButton() {
  undoBtn.disabled = game.moves.length === 0;
}

function doPlace(r: number, c: number) {
  const result = game.place(r, c);
  if (result.success) render();
}

function doUndo() {
  if (game.undo()) render();
}

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const c = Math.round((x - PAD) / CELL);
  const r = Math.round((y - PAD) / CELL);
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return;
  doPlace(r, c);
});

canvas.addEventListener('mousemove', (e) => {
  if (game.gameOver) { canvas.style.cursor = 'default'; return; }
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const c = Math.round((x - PAD) / CELL);
  const r = Math.round((y - PAD) / CELL);
  if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && game.board[r][c] === 0) {
    canvas.style.cursor = 'pointer';
  } else {
    canvas.style.cursor = 'default';
  }
});

document.getElementById('restart')!.addEventListener('click', init);
undoBtn.addEventListener('click', doUndo);

init();
