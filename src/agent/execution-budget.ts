export interface StageBudgetInput {
  nowMs: number;
  deadlineAtMs: number;
  reserveMs: number;
  stageCapMs: number;
}

export class WallClockDeadlineError extends Error {
  constructor() {
    super("The hard wall-clock deadline was reached.");
    this.name = "WallClockDeadlineError";
  }
}

interface SettleWithinDeadlineInput<T> {
  operation: Promise<T>;
  deadlineAtMs: number;
  now?: () => number;
  onDeadline: () => void;
}

export async function settleWithinDeadline<T>({
  operation,
  deadlineAtMs,
  now = () => performance.now(),
  onDeadline
}: SettleWithinDeadlineInput<T>): Promise<T> {
  if (!Number.isFinite(deadlineAtMs)) throw new Error("The wall-clock deadline must be finite.");
  const remainingMs = Math.max(0, Math.floor(deadlineAtMs - now()));
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      onDeadline();
      reject(new WallClockDeadlineError());
    }, remainingMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function remainingStageBudgetMs({
  nowMs,
  deadlineAtMs,
  reserveMs,
  stageCapMs
}: StageBudgetInput): number {
  if (![nowMs, deadlineAtMs, reserveMs, stageCapMs].every(Number.isFinite)) {
    throw new Error("Execution budget values must be finite numbers.");
  }
  if (reserveMs < 0 || stageCapMs <= 0) {
    throw new Error("Execution reserve must be nonnegative and the stage cap must be positive.");
  }
  return Math.max(0, Math.floor(Math.min(stageCapMs, deadlineAtMs - nowMs - reserveMs)));
}
