/**
 * Per-ticket ring buffer for raw agent output.
 * Stores output lines and handles partial line buffering.
 */

export class TicketOutputBuffer {
  private lines: string[] = [];
  private partial = '';

  constructor(private maxLines = 10_000) {}

  /** Append a raw chunk, splitting into lines and handling partials */
  append(chunk: string): void {
    const text = this.partial + chunk;
    const parts = text.split('\n');
    // Last element is either empty (chunk ended with \n) or a partial line
    this.partial = parts.pop() || '';

    for (const line of parts) {
      this.lines.push(line);
    }

    // Enforce ring buffer limit
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(this.lines.length - this.maxLines);
    }
  }

  /** Get full content for display (joins all complete lines + partial) */
  getContent(): string {
    const result = this.lines.join('\n');
    if (this.partial) {
      return result ? result + '\n' + this.partial : this.partial;
    }
    return result;
  }

  /** Number of complete lines stored */
  get lineCount(): number {
    return this.lines.length;
  }

  /** Get last N lines as a string */
  tail(n: number): string {
    const start = Math.max(0, this.lines.length - n);
    const tailLines = this.lines.slice(start);
    if (this.partial) {
      tailLines.push(this.partial);
    }
    return tailLines.join('\n');
  }

  /** Truncate back to a specific line count (for replacing blocks) */
  truncateTo(lineCount: number): void {
    if (lineCount < this.lines.length) {
      this.lines.length = lineCount;
      this.partial = '';
    }
  }

  /** Clear all stored output */
  clear(): void {
    this.lines = [];
    this.partial = '';
  }
}
