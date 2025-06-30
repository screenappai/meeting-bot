import { Logger } from 'winston';

export interface ITask<I, O> {
  completed: boolean;
  faulted: boolean;
  running: boolean;
  runAsync: (input: I) => Promise<O>;
}

// Base class with some out-of-box properties to run ITask instance
export abstract class Task<I, O> implements ITask<I, O> {
  private _completed: boolean;
  private _faulted: boolean;
  private _running: boolean;
  
  protected _logger: Logger;

  constructor(logger: Logger) {
    this._logger = logger;
  }
  
  public async runAsync(input: I): Promise<O> {
    try {
      this._running = true;
      const result = await this.execute(input);
      this._running = false;
      this._completed = true;
      return result;
    } catch(error) {
      this._logger.error('Task failed:', error);
      this._running = false;
      this._faulted = true;
      throw error;
    }
  }

  public get completed() {
    return this._completed;
  }
  private set completed(anyValue: boolean) {
    // not accessible
  }
  public get faulted() {
    return this._faulted;
  }
  private set faulted(anyValue: boolean) {
    // not accessible
  }
  public get running() {
    return this._running;
  }
  private set running(anyValue: boolean) {
    // not accessible
  }

  protected abstract execute(input: I): Promise<O>;
}
