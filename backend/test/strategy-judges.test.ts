import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type Anthropic from '@anthropic-ai/sdk';

import { createClaudeJudge } from '../src/strategy/judges/claudeJudge.ts';
import { createJevJudge, parseJevResponse } from '../src/strategy/judges/jevJudge.ts';
import { createMathJudge } from '../src/strategy/judges/mathJudge.ts';
import type { Snapshot } from '../src/strategy/state.ts';

function snap(pModel: number, book = { upAsk: 0.6, upBid: 0.58, downAsk: 0.42, downBid: 0.4 }): Snapshot {
  return { state: { market: 'x' }, raw: { zModel: 0, pModel, sigma1m: 0.05, chainlinkAgeMs: 0, book } };
}

describe('数学判官', () => {
  it('公平价高出含费成本够多才买', async () => {
    assert.equal((await createMathJudge(0.03).judge(snap(0.8), null)).decision.choice, 'BUY_UP');
    assert.equal((await createMathJudge(0.03).judge(snap(0.62), null)).decision.choice, 'PASS');
    assert.equal((await createMathJudge(0.03).judge(snap(0.2), null)).decision.choice, 'BUY_DOWN');
  });

  it('持仓：买价扣费明显高于胜率就卖', async () => {
    const pos = { side: 'UP' as const, contracts: 10, avgPrice: 0.5 };
    assert.equal((await createMathJudge(0.03).judge(snap(0.4), pos)).decision.choice, 'SELL');
    assert.equal((await createMathJudge(0.03).judge(snap(0.7), pos)).decision.choice, 'HOLD');
  });
});

describe('Jev 判官', () => {
  const answers = {
    model: 'jev-2026-09',
    answers: {
      up_wins: { type: 'noul', noul: 0.7 },
      down_wins: { type: 'noul', noul: 0.3 },
      entry: { type: 'choice', choice: 'BUY_UP', probabilities: { BUY_UP: 0.66, BUY_DOWN: 0.04, PASS: 0.3 } },
    },
    usage: { input_tokens: 812 },
  };

  it('一次请求带三道题，回包解析出选择与上涨概率', async () => {
    let seen: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const judge = createJevJudge({
      apiKey: 'k',
      baseUrl: 'https://api.typesafe.ai/v1',
      postJson: async (url, headers, body) => {
        seen = { url, headers, body };
        return answers;
      },
    });
    const j = await judge.judge(snap(0.6), null);
    assert.equal(seen!.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(seen!.headers.Authorization, 'Bearer k');
    const body = seen!.body as { model: string; questions: Record<string, { type: string }> };
    assert.equal(body.model, 'jev-latest');
    assert.deepEqual(Object.keys(body.questions), ['up_wins', 'down_wins', 'entry']);
    assert.equal(j.decision.choice, 'BUY_UP');
    assert.ok(Math.abs(j.pUp! - 0.7) < 1e-12);
    assert.equal(j.model, 'jev-2026-09');
    assert.equal(j.inputTokens, 812);
    assert.deepEqual(Object.keys(j.answers as Record<string, unknown>), ['up_wins', 'down_wins', 'entry']);
  });

  it('缺题或选项不对就抛错', async () => {
    const bad = createJevJudge({ apiKey: 'k', postJson: async () => ({ answers: { up_wins: { noul: 0.5 } } }) });
    await assert.rejects(bad.judge(snap(0.5), null), /缺题/);
    const wrong = createJevJudge({
      apiKey: 'k',
      postJson: async () => ({ answers: { ...answers.answers, entry: { choice: 'HOLD', probabilities: { HOLD: 1 } } } }),
    });
    await assert.rejects(wrong.judge(snap(0.5), null), /选择不对/);
    assert.throws(() => parseJevResponse({}), /answers/);
  });
});

describe('Claude 判官', () => {
  function fakeClient(result: unknown, capture: { params?: Record<string, unknown> } = {}): Anthropic {
    return {
      beta: {
        messages: {
          parse: async (params: Record<string, unknown>) => {
            capture.params = params;
            return result;
          },
        },
      },
    } as unknown as Anthropic;
  }

  it('结构化输出 → 决定，概率归一，开 fallbacks', async () => {
    const cap: { params?: Record<string, unknown> } = {};
    const judge = createClaudeJudge({
      client: fakeClient(
        {
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1200 },
          parsed_output: {
            up_wins_probability: 0.3,
            down_wins_probability: 0.7,
            choice: 'BUY_DOWN',
            probabilities: { BUY_UP: 0.1, BUY_DOWN: 0.6, PASS: 0.5 },
            rationale: 'sellers dominate',
          },
        },
        cap,
      ),
    });
    const j = await judge.judge(snap(0.4), null);
    assert.equal(j.decision.choice, 'BUY_DOWN');
    assert.ok(Math.abs(j.decision.probabilities.BUY_DOWN! - 0.5) < 1e-12);
    assert.ok(Math.abs(j.pUp! - 0.3) < 1e-12);
    assert.equal(j.rationale, 'sellers dominate');
    assert.equal((j.answers as { choice: string }).choice, 'BUY_DOWN');
    assert.equal(cap.params!.model, 'claude-opus-5');
    assert.equal(cap.params!.fallbacks, 'default');
    assert.deepEqual(cap.params!.betas, ['server-side-fallback-2026-07-01']);
    assert.equal((cap.params!.output_config as { effort: string }).effort, 'low');
  });

  it('拒答或解析失败抛错', async () => {
    const refused = createClaudeJudge({ client: fakeClient({ stop_reason: 'refusal', usage: { input_tokens: 0 }, parsed_output: null }) });
    await assert.rejects(refused.judge(snap(0.5), null), /拒答/);
    const empty = createClaudeJudge({ client: fakeClient({ stop_reason: 'max_tokens', usage: { input_tokens: 0 }, parsed_output: null }) });
    await assert.rejects(empty.judge(snap(0.5), { side: 'UP', contracts: 1, avgPrice: 0.5 }), /无法解析/);
  });
});
