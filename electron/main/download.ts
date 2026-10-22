// The verified download (DS5's download.ts, with Sonata's SHA-512): streamed to
// `path`, hashed on the way, deleted on any failure. Anything bigger than the
// signed feed declares is refused at once, and nothing is kept unless both size
// and SHA-512 match. A server that doesn't answer, or a download that stops
// sending data, fails instead of hanging. Free of Electron: the fetch is
// passed in (the updater gives it Electron's net.fetch), so vitest runs it
// against a local server (tests/unit/download.test.ts).
import { createHash } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";

export type FetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export const CONNECT_TIMEOUT_MS = 20_000;
export const STALL_TIMEOUT_MS = 60_000;

export interface Expected {
  url: string;
  size: number;
  sha512: string; // hex
}

export async function downloadVerified(
  fetchFn: FetchFn,
  want: Expected,
  path: string,
  progress: (got: number, total: number) => void,
  abort?: AbortSignal,
  stallMs: number = STALL_TIMEOUT_MS,
): Promise<void> {
  // loop: NOT-WORTH — removes one partial download before an update download (a local unlink)
  rmSync(path, { force: true });
  const connect = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
  const response = await fetchFn(want.url, { signal: abort ? AbortSignal.any([abort, connect]) : connect }).catch((cause: unknown) => {
    // error: PASSES-ON — rethrown in plain words to the updater, which shows it
    throw cause instanceof Error && cause.name === "TimeoutError" ? new Error("the download server didn't answer") : cause;
  });
  if (!response.ok || !response.body) throw new Error(`the download failed (HTTP ${response.status})`);
  if (Number(response.headers.get("content-length") ?? 0) > want.size) throw new Error("the download is bigger than the signed feed says; refused");
  const reader = response.body.getReader();
  const hash = createHash("sha512");
  const file = createWriteStream(path, { mode: 0o644 });
  // The first write error, surfaced at the next await instead of as an uncaught event.
  let writeError: Error | null = null;
  const failed = new Promise<never>((_, reject) =>
    // lifetime: OK — goes with the stream: ended on success, destroyed on any failure
    file.on("error", (err) => {
      writeError = err;
      reject(err);
    }),
  );
  // error: NOT-WORTH — only marks the write-error promise handled; the same rejection is awaited through Promise.race below and rethrown
  failed.catch(() => undefined);
  let got = 0;
  try {
    // loop: SERIAL-REQUIRED — stream order: each chunk is hashed and written in sequence, with a stall deadline
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // lifetime: OK — cleared in .finally() after every read
      // loop: SERIAL-REQUIRED — the stall timer: one per read, rejects after a minute without data
      const stall = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("the download stopped (no data for a minute)")), stallMs)));
      const { done, value } = await Promise.race([reader.read(), failed, stall]).finally(() => clearTimeout(timer));
      if (done) break;
      if (writeError) throw writeError;
      got += value.byteLength;
      if (got > want.size) throw new Error("the download is bigger than the signed feed says; refused");
      hash.update(value);
      // lifetime: OK — fires once on drain; the stream is destroyed if `failed` wins instead
      if (!file.write(value)) await Promise.race([new Promise<void>((r) => file.once("drain", () => r())), failed]);
      progress(got, want.size);
    }
    await Promise.race([new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve()))), failed]);
  } catch (cause) {
    // error: NOT-WORTH — cleanup while the real error is rethrown below; a failed cancel adds nothing
    void reader.cancel().catch(() => undefined);
    file.destroy();
    // loop: NOT-WORTH — removes a failed download (a local unlink)
    rmSync(path, { force: true });
    throw abort?.aborted ? new Error("the download was stopped") : cause;
  }
  if (got !== want.size) {
    // loop: NOT-WORTH — removes a failed download (a local unlink)
    rmSync(path, { force: true });
    throw new Error(`update refused: the download is ${got} bytes, the signed feed says ${want.size}`);
  }
  if (hash.digest("hex") !== want.sha512) {
    // loop: NOT-WORTH — removes a failed download (a local unlink)
    rmSync(path, { force: true });
    throw new Error("update refused: the download's SHA-512 doesn't match the signed feed");
  }
}
