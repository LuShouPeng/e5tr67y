/** 领域错误码：HTTP 层据此映射状态码与前端提示，不含任何 I/O 语义 */
export type ErrorCode =
  | 'SIDE_INVALID'
  | 'AMOUNT_INVALID'
  | 'ROUND_NOT_FOUND'
  | 'ROUND_LOCKED'
  | 'BET_NOT_FOUND'
  | 'BET_NOT_ACTIVE'
  | 'CONTRACTS_INVALID'
  | 'PRICE_UNAVAILABLE'
  | 'INSUFFICIENT_BALANCE'
  | 'SETTLE_ILLEGAL';

export class DomainError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}
