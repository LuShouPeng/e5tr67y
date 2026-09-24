import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

import { questions } from '../questions.ts';
import type { Decision } from '../rules.ts';
import type { Position, Snapshot } from '../state.ts';
import { clamp01, type Judge, type Judgment } from './types.ts';

/**
 * Claude 判官：同一份 state、同样三道题，用结构化输出拿回概率与选择。
 * 与 Jev 判官可互换，方便 A/B：两者都只做「看盘 → 概率」，下不下单仍由 rules 与 runner 决定。
 *
 * 默认开服务端 fallbacks（`"default"`）：安全分类器偶发拒答时由服务端换模型重答，拒答仍兜底成失败。
 */

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

const SYSTEM =
  'You are a disciplined trader in Polymarket 5-minute BTC up/down markets. You receive a snapshot of what a player can see ' +
  'right now (`state`) and a set of questions. Every number you need is already computed in the snapshot; do not invent data. ' +
  'The `estimate` section is a random-walk baseline; decide whether order flow, liquidations, momentum and the market odds justify ' +
  'a true chance above or below it, and remember fees make marginal bets lose money. Answer every question with calibrated ' +
  'probabilities between 0 and 1. Keep the rationale to one or two short sentences.';

const EntrySchema = z.object({
  up_wins_probability: z.number(),
  down_wins_probability: z.number(),
  choice: z.enum(['BUY_UP', 'BUY_DOWN', 'PASS']),
  probabilities: z.object({ BUY_UP: z.number(), BUY_DOWN: z.number(), PASS: z.number() }),
  rationale: z.string(),
});

const ExitSchema = z.object({
  up_wins_probability: z.number(),
  down_wins_probability: z.number(),
  choice: z.enum(['HOLD', 'SELL']),
  probabilities: z.object({ HOLD: z.number(), SELL: z.number() }),
  rationale: z.string(),
});

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeJudgeOptions {
  /** 不传则按 SDK 默认顺序取 ANTHROPIC_API_KEY 等凭据 */
  apiKey?: string;
  model?: string;
  /** 每 15 秒一问，延迟敏感，默认 low；想要更细的判断可调高 */
  effort?: Effort;
  timeoutMs?: number;
  client?: Anthropic;
}

/** 选项概率归一化：模型给的和不一定正好是 1 */
function normalize(probs: Record<string, number>): Record<string, number> {
  const clean = Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, clamp01(v)]));
  const total = Object.values(clean).reduce((a, b) => a + b, 0);
  if (total <= 0) return clean;
  return Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, v / total]));
}

export function createClaudeJudge(options: ClaudeJudgeOptions = {}): Judge {
  const client =
    options.client ?? new Anthropic({ apiKey: options.apiKey, timeout: options.timeoutMs ?? 20_000, maxRetries: 1 });
  const model = options.model || DEFAULT_CLAUDE_MODEL;
  const effort = options.effort ?? 'low';

  return {
    name: 'claude',
    async judge(snap: Snapshot, position: Position | null): Promise<Judgment> {
      const holding = position != null;
      const started = Date.now();
      const prompt = JSON.stringify({ state: snap.state, questions: questions(holding) });
      const params = {
        model,
        max_tokens: 16000,
        system: SYSTEM,
        messages: [{ role: 'user' as const, content: prompt }],
        output_config: { effort },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default' as const,
      };
      const response = holding
        ? await client.beta.messages.parse({ ...params, output_config: { ...params.output_config, format: betaZodOutputFormat(ExitSchema) } })
        : await client.beta.messages.parse({ ...params, output_config: { ...params.output_config, format: betaZodOutputFormat(EntrySchema) } });
      if (response.stop_reason === 'refusal') throw new Error('Claude 拒答（refusal）');
      const out = response.parsed_output;
      if (out == null) throw new Error(`Claude 回包无法解析，stop_reason=${response.stop_reason}`);
      const probabilities = normalize(out.probabilities);
      const decision: Decision = { choice: out.choice, probabilities };
      return {
        judge: 'claude',
        model: response.model,
        decision,
        pUp: (clamp01(out.up_wins_probability) + 1 - clamp01(out.down_wins_probability)) / 2,
        latencyMs: Date.now() - started,
        inputTokens: response.usage.input_tokens,
        rationale: out.rationale,
        answers: out,
      };
    },
  };
}
