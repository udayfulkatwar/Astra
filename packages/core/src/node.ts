/**
 * Node-only helpers (entry point `@astra/core/node`). Kept out of the main entry so
 * `@astra/core` stays runnable in browsers (the dashboard demo runs the real engines there).
 */
import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
