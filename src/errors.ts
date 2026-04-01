export class ExitError extends Error {
  public readonly code: number;

  constructor(message: string, code: number = 1) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
  }
}
