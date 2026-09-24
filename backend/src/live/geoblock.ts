/**
 * 地域合规检查：实盘下单前先问 Polymarket 官方的 geoblock 接口，当前出口 IP 是否在受限地区。
 *
 * **失败即关闭（fail closed）**：被判受限、或者检查本身失败（连不上、回包不对），实盘一律不下单。
 * 本项目不提供、也不支持任何绕过地域限制的手段（代理、VPN 等）——受限地区的用户请只用模拟盘。
 */

export const GEOBLOCK_URL = 'https://polymarket.com/api/geoblock';
const RECHECK_MS = 10 * 60_000;
/** 受限或检查失败后隔 1 分钟再查，网络抖动不至于把实盘关 10 分钟 */
const RECHECK_BLOCKED_MS = 60_000;

export interface GeoStatus {
  allowed: boolean;
  checkedAtMs: number | null;
  country: string | null;
  region: string | null;
  reason: string | null;
}

export type GeoFetch = (url: string) => Promise<unknown>;

async function defaultGeoFetch(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  timer.unref?.();
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (res.status !== 200) throw new Error(`geoblock 返回 ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function parseGeoblock(json: unknown, nowMs: number): GeoStatus {
  const o = (json ?? {}) as Record<string, unknown>;
  const country = typeof o.country === 'string' ? o.country : null;
  const region = typeof o.region === 'string' ? o.region : null;
  if (typeof o.blocked !== 'boolean') {
    return { allowed: false, checkedAtMs: nowMs, country, region, reason: 'geoblock 回包缺少 blocked 字段' };
  }
  return {
    allowed: !o.blocked,
    checkedAtMs: nowMs,
    country,
    region,
    reason: o.blocked ? `当前所在地区受 Polymarket 限制（${country ?? '?'}${region ? `/${region}` : ''}），实盘已禁用` : null,
  };
}

export interface GeoGuard {
  /** 需要时重新检查；返回最新状态 */
  ensure(): Promise<GeoStatus>;
  status(): GeoStatus;
}

export function createGeoGuard(options: { fetchJson?: GeoFetch; now?: () => number } = {}): GeoGuard {
  const fetchJson = options.fetchJson ?? defaultGeoFetch;
  const now = options.now ?? Date.now;
  let current: GeoStatus = { allowed: false, checkedAtMs: null, country: null, region: null, reason: '尚未检查' };

  return {
    async ensure() {
      const t = now();
      const ttl = current.allowed ? RECHECK_MS : RECHECK_BLOCKED_MS;
      if (current.checkedAtMs != null && t - current.checkedAtMs < ttl) return current;
      try {
        current = parseGeoblock(await fetchJson(GEOBLOCK_URL), t);
      } catch (e) {
        current = {
          allowed: false,
          checkedAtMs: t,
          country: null,
          region: null,
          reason: `地域检查失败，按受限处理：${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return current;
    },
    status: () => current,
  };
}
