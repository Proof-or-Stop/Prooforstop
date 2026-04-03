"""CLI 入口"""

from game import play_round

def main():
    print("=== 石头剪刀布 ===")
    print("输入 1=石头 2=剪刀 3=布，q=退出")
    wins = losses = draws = 0

    while True:
        text = input("\n你的选择: ").strip()
        if text.lower() == 'q':
            break

        result = play_round(text)
        if 'error' in result:
            print(result['error'])
            continue

        print(result['message'])
        if result['result'] == 'win': wins += 1
        elif result['result'] == 'lose': losses += 1
        else: draws += 1

    print(f"\n战绩: {wins}胜 {losses}负 {draws}平")

if __name__ == '__main__':
    main()
