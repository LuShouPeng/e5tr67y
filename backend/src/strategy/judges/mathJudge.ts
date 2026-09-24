import { askOf, bidOf, edge, sellOver, sideP, type Decision } from '../rules.ts';
import type { Position, Snapshot } from '../state.ts';
import type { Judge, Judgment } from './types.ts';

/**
 * 纯数学判官：不调任何 LLM，只拿随机游走公平价比含费成本。
 * 空仓：哪边「胜率 − 卖价 − 吃单费」≥ minEdge 就买那边（两边都够取大的）；
 * 持仓：「买价 − 吃单费 − 胜率」≥ minEdge 就卖。
 * 用来当基线：LLM 判官的成绩要跟它比才知道有没有多看出东西。
 */
export function createMathJudge(minEdge = 0.03): Judge {
  return {
    name: 'math',
    async judge(snap: Snapshot, position: Position | null): Promise<Judgment> {
      const started = Date.now();
      const { pModel, book } = snap.raw;
      let decision: Decision;
      if (position != null) {
        const side = position.side;
        const bid = bidOf(book, side);
        const over = bid == null ? -1 : sellOver(sideP(pModel, side), bid);
        decision = over >= minEdge ? { choice: 'SELL', probabilities: { SELL: 1, HOLD: 0 } } : { choice: 'HOLD', probabilities: { HOLD: 1, SELL: 0 } };
      } else {
        const upAsk = askOf(book, 'UP');
        const downAsk = askOf(book, 'DOWN');
        const upEdge = upAsk == null ? -1 : edge(pModel, upAsk);
        const downEdge = downAsk == null ? -1 : edge(1 - pModel, downAsk);
        const best = upEdge >= downEdge ? 'BUY_UP' : 'BUY_DOWN';
        const bestEdge = Math.max(upEdge, downEdge);
        decision =
          bestEdge >= minEdge
            ? { choice: best, probabilities: { BUY_UP: best === 'BUY_UP' ? 1 : 0, BUY_DOWN: best === 'BUY_DOWN' ? 1 : 0, PASS: 0 } }
            : { choice: 'PASS', probabilities: { BUY_UP: 0, BUY_DOWN: 0, PASS: 1 } };
      }
      return { judge: 'math', model: null, decision, pUp: pModel, latencyMs: Date.now() - started, inputTokens: 0 };
    },
  };
}
