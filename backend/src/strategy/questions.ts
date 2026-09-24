/**
 * 问判官（Jev / Claude）的题，移植自上游 `PredictionQuestions`，题目一律英文。
 * 空仓问买 UP / 买 DOWN / 不买，持仓问拿着 / 卖掉；UP 会不会赢、DOWN 会不会赢正反两问每次都带，只记分不管买卖。
 * 买卖两题明说 state 里的 estimate 是随机游走基线，要判官自己看盘判断真实胜率比它高还是低，再拿真实胜率比成本。
 */

export const UP_WINS = 'up_wins';
export const DOWN_WINS = 'down_wins';
export const ENTRY = 'entry';
export const EXIT = 'exit';

export interface Question {
  type: 'noul' | 'choice';
  instructions: string;
  /** noul：{true, false} 的说明；choice：{选项: 说明}（有序） */
  criteria: Record<string, string>;
}

export const UP_WINS_Q: Question = {
  type: 'noul',
  instructions:
    "Will this window settle UP: BTC's average price over the final minute at or above its average at the open?",
  criteria: {
    true: 'UP wins: the final-minute average ends at or above the opening average.',
    false: 'DOWN wins: the final-minute average ends below the opening average.',
  },
};

export const DOWN_WINS_Q: Question = {
  type: 'noul',
  instructions:
    "Will this window settle DOWN: BTC's average price over the final minute below its average at the open?",
  criteria: {
    true: 'DOWN wins: the final-minute average ends below the opening average.',
    false: 'UP wins: the final-minute average ends at or above the opening average.',
  },
};

export const ENTRY_Q: Question = {
  type: 'choice',
  instructions:
    'You are playing `market` and hold nothing. Decide what to do right now. A share of either side pays 100¢ if that side wins ' +
    'and nothing otherwise, so it is worth buying only if its true chance of winning is higher than its cost with the fee in `odds`. ' +
    '`estimate` gives a random-walk chance for each side and how far its cost sits above or below that; judge from `clock`, `btc`, ' +
    '`binance_flow` and `odds` whether the true chance is higher or lower than the estimate, then choose.',
  criteria: {
    BUY_UP: "Buy UP now: UP's true chance of winning is higher than what a share of UP costs.",
    BUY_DOWN: "Buy DOWN now: DOWN's true chance of winning is higher than what a share of DOWN costs.",
    PASS: "Buy nothing now: neither side's true chance of winning is higher than what its share costs.",
  },
};

export const EXIT_Q: Question = {
  type: 'choice',
  instructions:
    'You are playing `market` and hold the bet described in `position`. Decide what to do right now. Held to the close, each share ' +
    "pays 100¢ if your side wins and nothing otherwise, so holding is worth your side's true chance of winning; selling now returns " +
    'the after-fee amount in `position`. `estimate` gives a random-walk chance for your side; judge from `clock`, `btc`, ' +
    '`binance_flow` and `odds` whether the true chance is higher or lower than that, then choose.',
  criteria: {
    HOLD: "Keep the bet: your side's true chance of winning is worth more than what selling now returns.",
    SELL: "Sell now: what selling now returns is worth more than your side's true chance of winning.",
  },
};

/** 记分两问每次都带；空仓加入场题，持仓加离场题 */
export function questions(holding: boolean): Record<string, Question> {
  return {
    [UP_WINS]: UP_WINS_Q,
    [DOWN_WINS]: DOWN_WINS_Q,
    [holding ? EXIT : ENTRY]: holding ? EXIT_Q : ENTRY_Q,
  };
}
