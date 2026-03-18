/**
 * KARMA Agent Error Hierarchy
 *
 * Typed errors for agent execution. The controller uses `retryable`
 * to decide whether pg-boss should retry the job or mark it complete.
 */

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/** ML service errors are retryable (timeouts, 5xx, network) */
export class MlServiceError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super(message, true, cause);
    this.name = 'MlServiceError';
  }
}

/** Bad payload is terminal — retrying won't fix it */
export class PayloadError extends AgentError {
  constructor(message: string) {
    super(message, false);
    this.name = 'PayloadError';
  }
}

/** DB/Qdrant fetch failures are retryable */
export class DataFetchError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super(message, true, cause);
    this.name = 'DataFetchError';
  }
}
