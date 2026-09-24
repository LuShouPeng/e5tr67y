import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { createPublicClient, createWalletClient, encodeFunctionData, http, zeroHash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

import type { RedeemChain } from './redeemer.ts';

/**
 * 领奖的两种链上执行方式：
 * - direct：普通钱包（POLY_SIGNATURE_TYPE=0）。份额就在私钥地址上，直接调 CTF.redeemPositions，需要少量 POL 付 gas；
 * - relayer：邮箱登录的代理钱包（1）/ 浏览器钱包的 Safe（2）。份额在代理合约里，走 Polymarket 官方 relayer
 *   （@polymarket/builder-relayer-client）代为执行，免 gas，但需要 Builder API 凭据。
 *
 * 合约地址取自官方 clob-client 的 Polygon 配置。
 */

export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
export const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
export const DEFAULT_RELAYER_URL = 'https://relayer-v2.polymarket.com';
export const DEFAULT_POLYGON_RPC = 'https://polygon-rpc.com';
const POLYGON_CHAIN_ID = 137;

export const CTF_ABI = [
  {
    name: 'redeemPositions',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    outputs: [],
  },
  {
    name: 'payoutDenominator',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** 二元市场两个结果的 indexSet：UP=1（0b01）、DOWN=2（0b10）；输的那边领到 0，不影响 */
export const INDEX_SETS = [1n, 2n] as const;

export function redeemCalldata(conditionId: string): Hex {
  return encodeFunctionData({
    abi: CTF_ABI,
    functionName: 'redeemPositions',
    args: [USDC_ADDRESS, zeroHash, conditionId as Hex, [...INDEX_SETS]],
  });
}

function normalizeKey(privateKey: string): Hex {
  return (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
}

export interface ChainSetup {
  privateKey: string;
  signatureType: 0 | 1 | 2;
  rpcUrl?: string;
  relayerUrl?: string;
  builderCreds?: { key: string; secret: string; passphrase: string } | null;
}

export class RedeemUnavailableError extends Error {}

export function createRedeemChain(setup: ChainSetup): RedeemChain {
  const account = privateKeyToAccount(normalizeKey(setup.privateKey));
  const transport = http(setup.rpcUrl || DEFAULT_POLYGON_RPC);
  const publicClient = createPublicClient({ chain: polygon, transport });
  const wallet = createWalletClient({ account, chain: polygon, transport });

  async function isResolved(conditionId: string): Promise<boolean> {
    const denom = await publicClient.readContract({
      address: CTF_ADDRESS,
      abi: CTF_ABI,
      functionName: 'payoutDenominator',
      args: [conditionId as Hex],
    });
    return denom > 0n;
  }

  if (setup.signatureType === 0) {
    return {
      mode: 'direct',
      isResolved,
      async redeem(conditionId) {
        const hash = await wallet.writeContract({
          address: CTF_ADDRESS,
          abi: CTF_ABI,
          functionName: 'redeemPositions',
          args: [USDC_ADDRESS, zeroHash, conditionId as Hex, [...INDEX_SETS]],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status !== 'success') throw new Error(`领奖交易失败：${hash}`);
        return { txHash: hash };
      },
    };
  }

  if (!setup.builderCreds) {
    throw new RedeemUnavailableError('代理 / Safe 钱包自动领奖需要 Builder API 凭据（POLY_BUILDER_API_KEY / SECRET / PASSPHRASE）');
  }
  const builderConfig = new BuilderConfig({ localBuilderCreds: setup.builderCreds });
  const txType = setup.signatureType === 2 ? RelayerTxType.SAFE : RelayerTxType.PROXY;
  const relay = new RelayClient(setup.relayerUrl || DEFAULT_RELAYER_URL, POLYGON_CHAIN_ID, wallet, builderConfig, txType);

  return {
    mode: setup.signatureType === 2 ? 'relayer-safe' : 'relayer-proxy',
    isResolved,
    async redeem(conditionId) {
      const resp = await relay.execute([{ to: CTF_ADDRESS, data: redeemCalldata(conditionId), value: '0' }], 'redeem positions');
      const result = await resp.wait();
      const hash = result?.transactionHash ?? resp.transactionHash;
      if (!result || !hash) throw new Error(`relayer 领奖未确认：${resp.transactionID}`);
      return { txHash: hash };
    },
  };
}
