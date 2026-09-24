import type { DatabaseSync } from 'node:sqlite';

/**
 * 策略决策日志：每个检查点一行，记下判官看到的 state、给的概率、执行结果，事后回填回合结果与盈亏。
 * 建在所用通道自己的库里：模拟盘在游戏库，实盘在 live 库，两边互不串。
 */

export const DECISION_SCHEMA = `
CREATE TABLE IF NOT EXISTS strategy_decision (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  broker        TEXT    NOT NULL,
  judge         TEXT    NOT NULL,
  window_start  INTEGER NOT NULL,
  checkpoint    TEXT    NOT NULL,
  decided_at    INTEGER NOT NULL,
  action        TEXT    NOT NULL,
  reason        TEXT,
  p_model       REAL,
  p_judge       REAL,
  p_mkt         REAL,
  judge_choice  TEXT,
  judge_choice_p REAL,
  edge          REAL,
  up_ask        REAL,
  up_bid        REAL,
  down_ask      REAL,
  down_bid      REAL,
  fill_id       TEXT,
  stake         REAL,
  shares        REAL,
  avg_price     REAL,
  model         TEXT,
  latency_ms    INTEGER,
  input_tokens  INTEGER,
  rationale     TEXT,
  state_json    TEXT    NOT NULL DEFAULT '{}',
  error         TEXT,
  outcome       TEXT,
  pnl           REAL,
  UNIQUE (broker, window_start, checkpoint)
);
CREATE INDEX IF NOT EXISTS idx_decision_pending ON strategy_decision(outcome, window_start);
`;

export interface DecisionRow {
  id?: number;
  broker: string;
  judge: string;
  windowStart: number;
  checkpoint: string;
  decidedAt: number;
  action: string;
  reason: string | null;
  pModel: number | null;
  pJudge: number | null;
  pMkt: number | null;
  judgeChoice: string | null;
  judgeChoiceP: number | null;
  edge: number | null;
  upAsk: number | null;
  upBid: number | null;
  downAsk: number | null;
  downBid: number | null;
  fillId: string | null;
  stake: number | null;
  shares: number | null;
  avgPrice: number | null;
  model: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  rationale: string | null;
  stateJson: string;
  error: string | null;
  outcome: string | null;
  pnl: number | null;
}

const COLUMNS: [keyof DecisionRow, string][] = [
  ['broker', 'broker'], ['judge', 'judge'], ['windowStart', 'window_start'], ['checkpoint', 'checkpoint'],
  ['decidedAt', 'decided_at'], ['action', 'action'], ['reason', 'reason'], ['pModel', 'p_model'], ['pJudge', 'p_judge'],
  ['pMkt', 'p_mkt'], ['judgeChoice', 'judge_choice'], ['judgeChoiceP', 'judge_choice_p'], ['edge', 'edge'],
  ['upAsk', 'up_ask'], ['upBid', 'up_bid'], ['downAsk', 'down_ask'], ['downBid', 'down_bid'], ['fillId', 'fill_id'],
  ['stake', 'stake'], ['shares', 'shares'], ['avgPrice', 'avg_price'], ['model', 'model'], ['latencyMs', 'latency_ms'],
  ['inputTokens', 'input_tokens'], ['rationale', 'rationale'], ['stateJson', 'state_json'], ['error', 'error'],
  ['outcome', 'outcome'], ['pnl', 'pnl'],
];

function toRow(r: Record<string, unknown>): DecisionRow {
  const out: Record<string, unknown> = { id: Number(r.id) };
  for (const [key, col] of COLUMNS) out[key] = r[col] ?? null;
  return out as unknown as DecisionRow;
}

export interface DecisionRepo {
  exists(broker: string, windowStart: number, checkpoint: string): boolean;
  insert(row: DecisionRow): void;
  recent(broker: string, limit: number): DecisionRow[];
  /** 还没回填结果、窗口已结束的行 */
  pendingSettle(broker: string, beforeWindowStart: number, sinceWindowStart: number): DecisionRow[];
  fill(id: number, outcome: string | null, pnl: number | null): void;
  /** 买入行的战绩汇总 */
  summary(broker: string): { decisions: number; bets: number; settledBets: number; wins: number; pnl: number };
}

export function createDecisionRepo(db: DatabaseSync): DecisionRepo {
  db.exec(DECISION_SCHEMA);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO strategy_decision (${COLUMNS.map(([, c]) => c).join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
  );
  const exists = db.prepare('SELECT 1 FROM strategy_decision WHERE broker = ? AND window_start = ? AND checkpoint = ?');

  return {
    exists(broker, ws, cp) {
      return exists.get(broker, ws, cp) != null;
    },
    insert(row) {
      insert.run(...COLUMNS.map(([key]) => (row[key] ?? null) as string | number | null));
    },
    recent(broker, limit) {
      return (db.prepare('SELECT * FROM strategy_decision WHERE broker = ? ORDER BY id DESC LIMIT ?').all(broker, limit) as Record<string, unknown>[]).map(toRow);
    },
    pendingSettle(broker, before, since) {
      return (
        db
          .prepare(
            `SELECT * FROM strategy_decision WHERE broker = ? AND window_start < ? AND window_start >= ?
             AND (outcome IS NULL OR (fill_id IS NOT NULL AND pnl IS NULL AND action IN ('BUY_UP', 'BUY_DOWN')))`,
          )
          .all(broker, before, since) as Record<string, unknown>[]
      ).map(toRow);
    },
    fill(id, outcome, pnl) {
      db.prepare('UPDATE strategy_decision SET outcome = COALESCE(?, outcome), pnl = COALESCE(?, pnl) WHERE id = ?').run(outcome, pnl, id);
    },
    summary(broker) {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS decisions,
                  SUM(CASE WHEN action IN ('BUY_UP','BUY_DOWN') THEN 1 ELSE 0 END) AS bets,
                  SUM(CASE WHEN action IN ('BUY_UP','BUY_DOWN') AND pnl IS NOT NULL THEN 1 ELSE 0 END) AS settled,
                  SUM(CASE WHEN action IN ('BUY_UP','BUY_DOWN') AND pnl > 0 THEN 1 ELSE 0 END) AS wins,
                  COALESCE(SUM(CASE WHEN action IN ('BUY_UP','BUY_DOWN') THEN pnl ELSE 0 END), 0) AS pnl
           FROM strategy_decision WHERE broker = ?`,
        )
        .get(broker) as Record<string, unknown>;
      return {
        decisions: Number(r.decisions ?? 0),
        bets: Number(r.bets ?? 0),
        settledBets: Number(r.settled ?? 0),
        wins: Number(r.wins ?? 0),
        pnl: Number(r.pnl ?? 0),
      };
    },
  };
}
