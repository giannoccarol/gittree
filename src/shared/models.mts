/**
 * Cross-process domain models with runtime normalizers (ADR-0008, A8).
 * Every model crossing the IPC seam gets a `parse(unknown)` function so input
 * validation (ADR-0004) and typing are the same mechanism. Types and guards
 * only — no schema library.
 */

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function failure<T>(message: string): ParseResult<T> {
  return { ok: false, errors: [message] };
}

/**
 * Pending merge/rebase/cherry-pick state detected from git state files.
 * Producer: RepositoryOperations.getOperationState().
 */
export type OperationType = 'merge' | 'rebase' | 'cherry-pick';

export const OPERATION_TYPES: readonly OperationType[] = ['merge', 'rebase', 'cherry-pick'];

export interface OperationState {
  type: OperationType | null;
  conflicts: string[];
  canContinue: boolean;
}

export function parseOperationState(input: unknown): ParseResult<OperationState> {
  if (!isRecord(input)) return failure('operation state must be an object');
  const errors: string[] = [];

  const rawType = input.type;
  if (rawType !== null && !OPERATION_TYPES.includes(rawType as OperationType)) {
    errors.push(`type must be null or one of ${OPERATION_TYPES.join(', ')}`);
  }
  if (!Array.isArray(input.conflicts) || !input.conflicts.every(isString)) {
    errors.push('conflicts must be an array of strings');
  }
  if (typeof input.canContinue !== 'boolean') {
    errors.push('canContinue must be a boolean');
  }
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      type: rawType === null ? null : (rawType as OperationType),
      conflicts: input.conflicts as string[],
      canContinue: input.canContinue as boolean
    }
  };
}
