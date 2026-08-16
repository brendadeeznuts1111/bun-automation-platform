/**
 * JSONL stream consumer — wraps Bun.JSONL.parseChunk() with state management
 * for incremental, zero-copy, error-resilient streaming.
 *
 * Ref: https://bun.com/docs/runtime/jsonl#parseChunk
 * Ref: node_modules/bun-types/docs/runtime/jsonl.mdx
 *
 * Features:
 *   - Zero-copy Uint8Array accumulation with subarray() for unconsumed bytes
 *   - Graceful error recovery: on a parse error, skips the bad line and
 *     continues parsing the rest of the stream (parseChunk never throws,
 *     but it gets stuck at the error position, so we manually advance past
 *     the malformed line)
 *   - Final flush: after the stream ends, parses any remaining buffered data
 *   - Callback-based: calls onValue for each parsed value, onError for each
 *     skipped bad line
 */

export interface JsonlStreamOptions {
  /** Called for each successfully parsed JSON value. */
  onValue: (value: unknown) => void;
  /** Called when a malformed line is skipped. Receives the error and the
   *  byte offset where the bad line started. */
  onError?: (error: SyntaxError, badLineStart: number) => void;
}

export interface JsonlStreamResult {
  /** Total number of values parsed. */
  count: number;
  /** Total number of malformed lines skipped. */
  errors: number;
  /** Number of bytes consumed from the stream. */
  bytesConsumed: number;
}

/**
 * Consume a ReadableStream<Uint8Array> of JSONL data, calling onValue for
 * each parsed value. Uses zero-copy subarray() for unconsumed bytes.
 *
 * Ref: https://bun.com/docs/runtime/jsonl#byte-offsets-with-uint8array
 */
export async function consumeJsonlStream(
  stream: ReadableStream<Uint8Array>,
  options: JsonlStreamOptions,
): Promise<JsonlStreamResult> {
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  let count = 0;
  let errors = 0;
  let bytesConsumed = 0;

  const parseBuffer = (): void => {
    while (buf.length > 0) {
      const result = Bun.JSONL.parseChunk(buf);

      for (const value of result.values) {
        options.onValue(value);
        count++;
      }

      if (result.error) {
        // parseChunk gets stuck at the error position (read=0 when the
        // buffer starts with invalid JSON). Manually skip past the bad
        // line to continue parsing the rest of the stream.
        errors++;
        const badLineStart = bytesConsumed;
        options.onError?.(result.error, badLineStart);

        // Skip leading newlines, then skip to the next newline (end of bad line)
        let skip = result.read;
        while (skip < buf.length && buf[skip] === 0x0a) skip++; // skip \n
        const nlIdx = buf.indexOf(0x0a, skip);
        if (nlIdx >= 0) {
          skip = nlIdx + 1;
        } else {
          // No newline found — skip the entire remaining buffer
          skip = buf.length;
        }
        bytesConsumed += skip;
        buf = buf.subarray(skip);
      } else {
        bytesConsumed += result.read;
        buf = buf.subarray(result.read);
        // No error and no progress (read=0) means we have a partial value
        // that needs more data from the stream. Break and wait for next chunk.
        if (result.read === 0) break;
      }

      if (result.done) break;
    }
  };

  let done = false;
  while (!done) {
    const { value, done: chunkDone } = await reader.read();
    done = chunkDone;
    if (value) {
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged;
    }
    parseBuffer();
  }

  // Final flush: parse any remaining data after the stream ends
  parseBuffer();

  reader.releaseLock();
  return { count, errors, bytesConsumed };
}
