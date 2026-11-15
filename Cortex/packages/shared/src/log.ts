import { format } from "node:util";

// Transitional console-free output helpers. Keep these behavior-equivalent to
// Node console stdout/stderr writes; structured logging is a later migration.
function write(stream: NodeJS.WriteStream, args: unknown[]): void {
  stream.write(`${format(...args)}\n`);
}

export function writeStdout(...args: unknown[]): void {
  write(process.stdout, args);
}

export function writeStderr(...args: unknown[]): void {
  write(process.stderr, args);
}
