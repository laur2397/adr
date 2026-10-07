/** Error returned to the client as application/problem+json. Titles are Romanian and say how to fix the problem. */
export class AppError extends Error {
  /** Side effects that must survive the rollback of the failed transaction (e.g. notify the head of unit). */
  onRollback?: () => Promise<void>;

  constructor(
    public readonly status: number,
    public readonly title: string,
    public readonly errors: Array<{ field?: string; row?: number; message: string }> = [],
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(title);
  }
}

export const notFound = (what = 'Resursa') => new AppError(404, `${what}: nu există sau nu aveți acces.`);
export const forbidden = (msg = 'Nu aveți dreptul să efectuați această acțiune.') => new AppError(403, msg);
export const badRequest = (msg: string, errors: AppError['errors'] = []) => new AppError(400, msg, errors);
export const unprocessable = (msg: string, errors: AppError['errors'] = []) => new AppError(422, msg, errors);
export const conflict = (msg: string, extra: Record<string, unknown> = {}) => new AppError(409, msg, [], extra);
