import type { ErrorCode } from '../domain/errors.ts';
import { isDomainError } from '../domain/errors.ts';

/**
 * 领域错误码 → HTTP 状态码。
 * 分类依据是「调用方该怎么做」：改参数（400）、换目标（404）、
 * 等状态变化（409）、稍后重试（503）。
 */
const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  SIDE_INVALID: 400,
  AMOUNT_INVALID: 400,
  CONTRACTS_INVALID: 400,
  INSUFFICIENT_BALANCE: 400,
  ROUND_NOT_FOUND: 404,
  BET_NOT_FOUND: 404,
  ROUND_LOCKED: 409,
  BET_NOT_ACTIVE: 409,
  PRICE_UNAVAILABLE: 503,
  SETTLE_ILLEGAL: 409,
};

export interface HttpErrorBody {
  error: { code: string; message: string };
}

export function toHttpError(e: unknown): { status: number; body: HttpErrorBody } {
  if (isDomainError(e)) {
    return {
      status: STATUS_BY_CODE[e.code] ?? 400,
      body: { error: { code: e.code, message: e.message } },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: e instanceof Error ? e.message : '服务内部错误',
      },
    },
  };
}
