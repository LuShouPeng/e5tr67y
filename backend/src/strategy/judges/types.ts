import type { Decision } from '../rules.ts';
import type { Position, Snapshot } from '../state.ts';

export type JudgeName = 'math' | 'jev' | 'claude';

export interface Judgment {
  judge: JudgeName;
  /** 实际作答的模型版本；纯数学为 null */
  model: string | null;
  decision: Decision;
  /** 判官自己的上涨概率（记分用）；纯数学即 pModel */
  pUp: number | null;
  latencyMs: number;
  inputTokens: number;
  /** 判官给的简短理由（Claude 才有） */
  rationale?: string | null;
  /** 判官对三道题的原始回答，原样落库供事后复盘（up_wins / down_wins 单独记分要用） */
  answers?: unknown;
}

/** 判官：拿着 state 回答「买 UP / 买 DOWN / 不买」或「拿着 / 卖掉」 */
export interface Judge {
  readonly name: JudgeName;
  /** position 为 null 表示空仓（问入场），否则问离场 */
  judge(snap: Snapshot, position: Position | null): Promise<Judgment>;
}

export function clamp01(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
