import * as readline from 'node:readline';
import { createGame, createGameWithTarget, guess, isValidGuess, type GameState } from './game-logic.js';
import { createRpsState, parseMove, play, moveName } from './rps-logic.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ===== 猜数字 =====

async function playGuessRound(): Promise<void> {
  const fixedTarget = Number(process.env.GUESS_TARGET);
  const state: GameState = fixedTarget ? createGameWithTarget(fixedTarget, 1, 100) : createGame(1, 100);
  console.log(`\n🎯 我想了一个 ${state.min}-${state.max} 之间的数字，猜猜看！`);

  while (!state.finished) {
    const input = await ask('你的猜测（输入 q 退出）: ');

    if (input.trim().toLowerCase() === 'q') {
      console.log(`答案是 ${state.target}，下次再来！`);
      return;
    }

    const value = Number(input);
    if (isNaN(value)) {
      console.log('请输入有效数字');
      continue;
    }

    const error = isValidGuess(state, value);
    if (error) {
      console.log(error);
      continue;
    }

    const result = guess(state, value);
    if (result.correct) {
      console.log(`🎉 恭喜！你用了 ${result.attempts} 次猜中了！`);
    } else if (result.hint === 'too-high') {
      console.log('📉 太大了，再小一点');
    } else {
      console.log('📈 太小了，再大一点');
    }
  }
}

async function playGuessNumber(): Promise<void> {
  console.log('\n=== 猜数字游戏 ===');
  let playing = true;
  while (playing) {
    await playGuessRound();
    const again = await ask('\n再来一局？(y/n): ');
    playing = again.trim().toLowerCase() === 'y';
  }
}

// ===== 石头剪刀布 =====

async function playRps(): Promise<void> {
  console.log('\n=== 石头剪刀布 ===');
  console.log('输入 1=石头  2=剪刀  3=布  q=退出\n');

  const state = createRpsState();

  while (true) {
    const input = await ask('你的出招: ');

    if (input.trim().toLowerCase() === 'q') {
      console.log(`\n📊 战绩: ${state.rounds} 局 — 赢 ${state.wins} / 输 ${state.losses} / 平 ${state.draws}`);
      return;
    }

    const playerMove = parseMove(input);
    if (!playerMove) {
      console.log('无效输入，请输入 1(石头) 2(剪刀) 3(布)');
      continue;
    }

    const result = play(state, playerMove);
    const playerName = moveName(result.playerMove);
    const computerName = moveName(result.computerMove);

    if (result.outcome === 'win') {
      console.log(`✌️  ${playerName} vs ${computerName} — 你赢了！`);
    } else if (result.outcome === 'lose') {
      console.log(`😅 ${playerName} vs ${computerName} — 你输了！`);
    } else {
      console.log(`🤝 ${playerName} vs ${computerName} — 平局！`);
    }
  }
}

// ===== 主菜单 =====

async function main(): Promise<void> {
  console.log('=== 迷你游戏合集 ===');

  let running = true;
  while (running) {
    console.log('\n请选择游戏:');
    console.log('  1. 猜数字');
    console.log('  2. 石头剪刀布');
    console.log('  q. 退出');

    const choice = await ask('\n你的选择: ');

    switch (choice.trim()) {
      case '1':
        await playGuessNumber();
        break;
      case '2':
        await playRps();
        break;
      case 'q':
      case 'Q':
        running = false;
        break;
      default:
        console.log('无效选择，请重新输入');
    }
  }

  console.log('再见！');
  rl.close();
}

main();
