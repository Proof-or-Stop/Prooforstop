"""石头剪刀布 CLI 游戏"""

import random

MOVES = ['rock', 'scissors', 'paper']
NAMES = {'rock': '石头', 'scissors': '剪刀', 'paper': '布'}


def parse_move(text):
    """解析用户输入"""
    t = text.strip().lower()
    if t in ('1', 'rock', '石头'): return 'rock'
    if t in ('2', 'scissors', '剪刀'): return 'scissors'
    if t in ('3', 'paper', '布'): return 'paper'
    return None


def judge(player, computer):
    """判定胜负: win/lose/draw"""
    if player == computer:
        return 'draw'
    wins = {('rock', 'scissors'), ('scissors', 'paper'), ('paper', 'rock')}
    return 'win' if (player, computer) in wins else 'lose'


def random_move():
    """电脑随机出招"""
    return random.choice(MOVES)


def play_round(player_input, computer_move=None):
    """一轮游戏"""
    move = parse_move(player_input)
    if move is None:
        return {'error': '无效输入，请输入 1/2/3 或 石头/剪刀/布'}

    if computer_move is None:
        computer_move = random_move()

    result = judge(move, computer_move)
    return {
        'player': NAMES[move],
        'computer': NAMES[computer_move],
        'result': result,
        'message': f"你出{NAMES[move]}，电脑出{NAMES[computer_move]}，{'你赢了！' if result == 'win' else '你输了！' if result == 'lose' else '平局！'}"
    }
