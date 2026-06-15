/**
 * Minimal console logger (PRD §13: local only, no telemetry, no phone-home).
 */

import type { Logger } from '../adapters/adapter.js';

export class ConsoleLogger implements Logger {
  constructor(private readonly verbose = false) {}

  info(msg: string): void {
    console.error(`  ${msg}`);
  }
  warn(msg: string): void {
    console.error(`  ⚠ ${msg}`);
  }
  error(msg: string): void {
    console.error(`  ✖ ${msg}`);
  }
  debug(msg: string): void {
    if (this.verbose) console.error(`  · ${msg}`);
  }
}

/** A logger that swallows everything (for tests / quiet mode). */
export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};
