import { ClobClient, type ApiKeyCreds } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

import type { ClobLike } from './liveBroker.ts';

/**
 * 用官方 `@polymarket/clob-client` 建实盘客户端。
 * - 私钥只从环境变量读，只在内存里；不落库、不打日志。
 * - 没给 L2 API 凭据时用私钥 `createOrDeriveApiKey()` 派生（官方推荐「派生而不是新建」）。
 * - signatureType：0 = 普通 EOA 钱包，1 = 邮箱 / Magic 登录，2 = 浏览器钱包的 Polymarket 代理钱包；1/2 需要 funder（充值地址）。
 */

export const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;

export interface ClobSetup {
  privateKey: string;
  funderAddress?: string;
  signatureType: 0 | 1 | 2;
  apiCreds: ApiKeyCreds | null;
}

export async function createClob(setup: ClobSetup): Promise<ClobLike> {
  const pk = (setup.privateKey.startsWith('0x') ? setup.privateKey : `0x${setup.privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account, chain: polygon, transport: http() });
  const creds = setup.apiCreds ?? (await new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, wallet).createOrDeriveApiKey());
  const client = new ClobClient(
    CLOB_HOST,
    POLYGON_CHAIN_ID,
    wallet,
    creds,
    setup.signatureType,
    setup.funderAddress,
    undefined, // geoBlockToken：不使用，地域限制按官方 geoblock 接口执行
    true, // useServerTime：签名时间戳用服务端时间，避免本机时钟漂移被拒
    undefined,
    undefined,
    undefined,
    undefined,
    true, // throwOnError
  );
  return client as unknown as ClobLike;
}
