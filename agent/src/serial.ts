export class SerialExecutor {
  private chain: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(() => task());
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}
