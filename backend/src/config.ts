import type { FeedMode } from './market/feed.ts';
import type { JudgeName } from './strategy/judges/types.ts';
import { DEFAULT_RUNNER_CONFIG, type RunnerConfig } from './strategy/runner.ts';

/**
 * 全部环境变量在这里一次解析、一次校验：填错直接启动失败，而不是带着错配置悄悄跑
 * （之前 MARKET_FEED 拼错会一直按真盘跑、永不降级）。
 */

export type BrokerChoice = 'paper' | 'live';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  feedMode: FeedMode;
  feedPollMs: number;
  binanceApiBase: string | undefined;
  binanceLiquidations: boolean;
  strategy: {
    enabled: boolean;
    autostart: boolean;
    judge: JudgeName;
    broker: BrokerChoice;
    adminToken: string | null;
    mathMinEdge: number;
    runner: RunnerConfig;
  };
  jev: { apiKey: string; baseUrl: string | undefined; model: string | undefined };
  claude: { model: string | undefined; effort: Effort };
  live: {
    enabled: boolean;
    dryRun: boolean;
    dbPath: string;
    privateKey: string;
    funderAddress: string | undefined;
    signatureType: 0 | 1 | 2;
    apiCreds: { key: string; secret: string; passphrase: string } | null;
    maxStakeUsd: number;
    maxOpenCostUsd: number;
    maxDailyLossUsd: number;
  };
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const v = str(env, key);
  if (v === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new ConfigError(`${key}=${v} 不合法，只能是 ${allowed.join(' / ')}`);
  }
  return v as T;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = str(env, key)?.toLowerCase();
  if (v === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`${key}=${v} 不是布尔值（true/false）`);
}

function number(env: Env, key: string, fallback: number, min = -Infinity, max = Infinity): number {
  const v = str(env, key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`${key}=${v} 需是 [${min}, ${max}] 内的数字`);
  return n;
}

function list(env: Env, key: string, fallback: number[]): number[] {
  const v = str(env, key);
  if (v === undefined) return fallback;
  const out = v.split(',').map((s) => Number(s.trim()));
  if (out.length === 0 || out.some((n) => !Number.isInteger(n) || n < 0 || n >= 300)) {
    throw new ConfigError(`${key}=${v} 需是逗号分隔的 0~299 整数秒`);
  }
  return out;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const feedMode = oneOf<FeedMode>(env, 'MARKET_FEED', ['polymarket', 'simulated', 'auto'], 'auto');
  const broker = oneOf<BrokerChoice>(env, 'STRATEGY_BROKER', ['paper', 'live'], 'paper');
  const judge = oneOf<JudgeName>(env, 'STRATEGY_JUDGE', ['math', 'jev', 'claude'], 'math');
  const strategyEnabled = bool(env, 'STRATEGY_ENABLED', false);
  const liveEnabled = bool(env, 'LIVE_TRADING_ENABLED', false);

  const apiKey = str(env, 'POLY_API_KEY');
  const apiSecret = str(env, 'POLY_API_SECRET');
  const apiPass = str(env, 'POLY_API_PASSPHRASE');
  const signatureType = number(env, 'POLY_SIGNATURE_TYPE', 0, 0, 2);

  const cfg: AppConfig = {
    port: number(env, 'PORT', 8787, 1, 65535),
    host: str(env, 'HOST') ?? '0.0.0.0',
    dbPath: str(env, 'WIIB_DB') ?? 'data/prediction.sqlite',
    feedMode,
    feedPollMs: number(env, 'FEED_POLL_MS', 5000, 1000, 60_000),
    binanceApiBase: str(env, 'BINANCE_API_BASE'),
    binanceLiquidations: bool(env, 'BINANCE_LIQUIDATIONS', true),
    strategy: {
      enabled: strategyEnabled,
      autostart: bool(env, 'STRATEGY_AUTOSTART', false),
      judge,
      broker,
      adminToken: str(env, 'STRATEGY_ADMIN_TOKEN') ?? null,
      mathMinEdge: number(env, 'STRATEGY_MATH_MIN_EDGE', 0.03, 0, 1),
      runner: {
        ...DEFAULT_RUNNER_CONFIG,
        checkpointSeconds: list(env, 'STRATEGY_CHECKPOINTS', DEFAULT_RUNNER_CONFIG.checkpointSeconds),
        baseStake: number(env, 'STRATEGY_BASE_STAKE', DEFAULT_RUNNER_CONFIG.baseStake, 1, 10_000),
        actThreshold: number(env, 'STRATEGY_ACT_THRESHOLD', DEFAULT_RUNNER_CONFIG.actThreshold, 0, 1),
        fillDelayMs: number(env, 'STRATEGY_FILL_DELAY_MS', DEFAULT_RUNNER_CONFIG.fillDelayMs, 0, 10_000),
        bookMaxAgeMs: number(env, 'STRATEGY_BOOK_MAX_AGE_MS', DEFAULT_RUNNER_CONFIG.bookMaxAgeMs, 500, 60_000),
      },
    },
    jev: { apiKey: str(env, 'JEV_API_KEY') ?? '', baseUrl: str(env, 'JEV_BASE_URL'), model: str(env, 'JEV_MODEL') },
    claude: {
      model: str(env, 'CLAUDE_MODEL'),
      effort: oneOf<Effort>(env, 'CLAUDE_EFFORT', ['low', 'medium', 'high', 'xhigh', 'max'], 'low'),
    },
    live: {
      enabled: liveEnabled,
      dryRun: bool(env, 'LIVE_DRY_RUN', true),
      dbPath: str(env, 'LIVE_DB') ?? 'data/live.sqlite',
      privateKey: str(env, 'POLY_PRIVATE_KEY') ?? '',
      funderAddress: str(env, 'POLY_FUNDER_ADDRESS'),
      signatureType: signatureType as 0 | 1 | 2,
      apiCreds: apiKey && apiSecret && apiPass ? { key: apiKey, secret: apiSecret, passphrase: apiPass } : null,
      maxStakeUsd: number(env, 'LIVE_MAX_STAKE_USD', 5, 1, 100_000),
      maxOpenCostUsd: number(env, 'LIVE_MAX_OPEN_COST_USD', 20, 1, 1_000_000),
      maxDailyLossUsd: number(env, 'LIVE_MAX_DAILY_LOSS_USD', 20, 1, 1_000_000),
    },
  };

  if (strategyEnabled && judge === 'jev' && cfg.jev.apiKey === '') {
    throw new ConfigError('STRATEGY_JUDGE=jev 需要 JEV_API_KEY');
  }
  if (strategyEnabled && broker === 'live') {
    if (!liveEnabled) throw new ConfigError('STRATEGY_BROKER=live 需要显式设置 LIVE_TRADING_ENABLED=true');
    if (feedMode !== 'polymarket') {
      throw new ConfigError('实盘只能用真实行情：STRATEGY_BROKER=live 时 MARKET_FEED 必须是 polymarket（不许降级到模拟价下真单）');
    }
    if (cfg.live.privateKey === '') throw new ConfigError('实盘需要 POLY_PRIVATE_KEY');
    if (signatureType !== 0 && !cfg.live.funderAddress) {
      throw new ConfigError('POLY_SIGNATURE_TYPE 为 1/2（邮箱 / 代理钱包）时需要 POLY_FUNDER_ADDRESS');
    }
  }
  return cfg;
}
