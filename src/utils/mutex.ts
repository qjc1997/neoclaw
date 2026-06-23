/** Simple async FIFO mutex — at most one holder at a time, waiters served in order. */
export class Mutex {
  private _waiters: Array<() => void> = [];
  private _held = false;

  async acquire(): Promise<void> {
    if (!this._held) {
      this._held = true;
      return;
    }
    return new Promise<void>((resolve) => this._waiters.push(resolve));
  }

  /**
   * Non-blocking acquire. Returns true and marks as held if the mutex was
   * free; returns false without waiting if it was already held.
   * Used by the dispatcher to detect in-flight turns and queue messages
   * rather than blocking indefinitely.
   */
  tryAcquire(): boolean {
    if (this._held) return false;
    this._held = true;
    return true;
  }

  /** True if the mutex is currently held by any caller. */
  get isHeld(): boolean {
    return this._held;
  }

  release(): void {
    const next = this._waiters.shift();
    if (next) {
      next();
    } else {
      this._held = false;
    }
  }
}
