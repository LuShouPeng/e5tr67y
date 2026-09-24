import { questions, DOWN_WINS, ENTRY, EXIT, UP_WINS } from '../questions.ts';
import type { Decision } from '../rules.ts';
import type { Position, Snapshot } from '../state.ts';
import { clamp01, type Judge, type Judgment } from './types.ts';

/**
 * TypeSafe Jev 判官（移植自上游 `JevClient` + `PredictionJudge`）：
 * POST {baseUrl}/v1/systemone，一份 state 配三道题一次问完。
 * noul 题回 `noul` 概率；choice 题回 `choice` + 各项 `probabilities`。
 * 上涨概率 = UP 会赢与 1 − DOWN 会赢的平均，只记分。
 */

export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai';
export const DEFAULT_JEV_MODEL = 'jev-latest';

export interface JevAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface JevResponse {
  model: string | null;
  answers: Record<string, JevAnswer>;
  inputTokens: number;
}

export type PostJson = (url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) => Promise<unknown>;

async function defaultPostJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new Error(`Jev 返回 ${res.status}：${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export function parseJevResponse(json: unknown): JevResponse {
  const root = json as { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } };
  if (root == null || typeof root.answers !== 'object' || root.answers == null) {
    throw new Error(`Jev 回包没有 answers: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const answers: Record<string, JevAnswer> = {};
  for (const [key, raw] of Object.entries(root.answers as Record<string, unknown>)) {
    const a = raw as Record<string, unknown>;
    const probs = a.probabilities && typeof a.probabilities === 'object' ? (a.probabilities as Record<string, unknown>) : null;
    answers[key] = {
      type: typeof a.type === 'string' ? a.type : undefined,
      noul: typeof a.noul === 'number' ? a.noul : undefined,
      choice: typeof a.choice === 'string' ? a.choice : undefined,
      confidence: typeof a.confidence === 'number' ? a.confidence : undefined,
      probabilities: probs ? Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, clamp01(v)])) : undefined,
    };
  }
  return {
    model: typeof root.model === 'string' ? root.model : null,
    answers,
    inputTokens: Number(root.usage?.input_tokens ?? 0) || 0,
  };
}

export interface JevJudgeOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  postJson?: PostJson;
}

export function createJevJudge(options: JevJudgeOptions): Judge {
  const base = (options.baseUrl || DEFAULT_JEV_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
  const model = options.model || DEFAULT_JEV_MODEL;
  const post = options.postJson ?? defaultPostJson;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return {
    name: 'jev',
    async judge(snap: Snapshot, position: Position | null): Promise<Judgment> {
      const holding = position != null;
      const started = Date.now();
      const qs = questions(holding);
      const body = {
        model,
        state: snap.state,
        questions: Object.fromEntries(
          Object.entries(qs).map(([k, q]) => [k, { type: q.type, instructions: q.instructions, criteria: q.criteria }]),
        ),
      };
      const res = parseJevResponse(
        await post(`${base}/v1/systemone`, { Authorization: `Bearer ${options.apiKey}` }, body, timeoutMs),
      );
      const up = res.answers[UP_WINS];
      const down = res.answers[DOWN_WINS];
      const d = res.answers[holding ? EXIT : ENTRY];
      if (up?.noul == null || down?.noul == null || d == null) {
        throw new Error(`Jev 回包缺题，只有 ${Object.keys(res.answers).join(',')}`);
      }
      const options_ = holding ? ['HOLD', 'SELL'] : ['BUY_UP', 'BUY_DOWN', 'PASS'];
      if (d.choice == null || !options_.includes(d.choice) || d.probabilities?.[d.choice] == null) {
        throw new Error(`Jev 的选择不对: ${d.choice} ${JSON.stringify(d.probabilities)}`);
      }
      const decision: Decision = { choice: d.choice as Decision['choice'], probabilities: d.probabilities };
      return {
        judge: 'jev',
        model: res.model,
        decision,
        pUp: (up.noul + 1 - down.noul) / 2,
        latencyMs: Date.now() - started,
        inputTokens: res.inputTokens,
        answers: res.answers,
      };
    },
  };
}
