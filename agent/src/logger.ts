import { appendFileSync, writeFileSync } from "node:fs";

export class Logger {
  constructor(private readonly path: string, private readonly prefix: string) {
    writeFileSync(path, "");
  }

  line(msg: string) {
    appendFileSync(this.path, `[${new Date().toISOString()}]${this.prefix} ${msg}\n`);
  }

  speech(msg: string) {
    this.line(`[speech] ${msg}`);
  }

  action(msg: string) {
    this.line(`[action] ${msg}`);
  }
}
