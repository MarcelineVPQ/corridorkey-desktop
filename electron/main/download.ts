// The verified download (DS5's download.ts, with Sonata's SHA-512): streamed to
// `path`, hashed on the way. Also the first-run install's downloads (install.ts):
// SHA-256 (what PyPI and our model release list), and `resume`, which keeps a
// partial file on failure, checks a complete one offline, and asks the server for
// the rest; without `resume` any failure deletes the file. Anything bigger than
// declared is refused at once, and nothing is kept unless size and hash match. A server that doesn't answer, or a download that stops
// sending data, fails instead of hanging. Free of Electron: the fetch is
// passed in (the updater gives it Electron's net.fetch), so vitest runs it
// against a local server (tests/unit/download.test.ts).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, rmSync, statSync } from "node:fs";

export type FetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export const CONNECT_TIMEOUT_MS = 20_000;
export const STALL_TIMEOUT_MS = 60_000;
// the errors said in two places each (the connect deadline and a failed fetch; the header's size and the body's)
const NO_ANSWER = "the download server didn't answer";
const tooBig = (source: string) => new Error(`the download is bigger than ${source} says; refused`);

export interface Expected {
  url: string;
  size: number;
  // one of the two, hex
  sha512?: string;
  sha256?: string;
  // whose numbers these are, for the refusals: "the signed feed" (the updater) unless set
  source?: string;
}

/** The bytes already in `path` (a partial download), hashed; 0 when there is none. */
async function hashExisting(path: string, hash: ReturnType<typeof createHash>, abort?: AbortSignal): Promise<number> {
  let size = 0;
  try {
    // loop: NOT-WORTH — one stat per resumed download
    size = statSync(path).size;
  } catch {
    // error: NOT-WORTH — no partial file: start from zero
    return 0;
  }
  // loop: SERIAL-REQUIRED — stream order: the partial file is hashed in sequence before the rest arrives
  // a Stop also stops this re-read (up to 1.7 GB for a model file)
  for await (const chunk of createReadStream(path, { signal: abort })) hash.update(chunk as Buffer);
  return size;
}

export async function downloadVerified(
  fetchFn: FetchFn,
  want: Expected,
  path: string,
  progress: (got: number, total: number) => void,
  abort?: AbortSignal,
  stallMs: number = STALL_TIMEOUT_MS,
  opts: { resume?: boolean; connectMs?: number } = {},
): Promise<void> {
  const source = want.source ?? "the signed feed";
  const refused = want.source ? "refused" : "update refused";
  const algorithm = want.sha256 ? "sha256" : "sha512";
  const expectHex = want.sha256 ?? want.sha512 ?? "";
  let hash = createHash(algorithm);
  let have = 0;
  if (opts.resume) {
    have = await hashExisting(path, hash, abort);
    if (have === want.size) {
      // already complete (a stop after it arrived): keep it if it checks out, without going online
      if (hash.digest("hex") === expectHex) {
        progress(have, want.size);
        return;
      }
    }
    if (have >= want.size) {
      // a complete leftover that doesn't check out, or an oversized one: start over
      // loop: NOT-WORTH — removes one stale partial download (a local unlink)
      rmSync(path, { force: true });
      hash = createHash(algorithm);
      have = 0;
    }
  } else {
    // loop: NOT-WORTH — removes one partial download before an update download (a local unlink)
    rmSync(path, { force: true });
  }
  // The connect deadline covers only the wait for the server's answer: the same signal also governs the
  // body, so a deadline left running cut every download longer than CONNECT_TIMEOUT_MS (found by the first-run
  // install's 1.7 GB file, 2026-10-24). The stall deadline below watches the body instead.
  const connect = new AbortController();
  // lifetime: OK — cleared as soon as the server answers (or the fetch fails)
  // loop: NOT-WORTH — one connect deadline per download [bounded: CONNECT_TIMEOUT_MS]
  const connectTimer = setTimeout(() => connect.abort(new DOMException(NO_ANSWER, "TimeoutError")), opts.connectMs ?? CONNECT_TIMEOUT_MS);
  const headers = have > 0 ? { Range: `bytes=${have}-` } : undefined;
  const response = await fetchFn(want.url, { signal: abort ? AbortSignal.any([abort, connect.signal]) : connect.signal, ...(headers ? { headers } : {}) })
    .catch((cause: unknown) => {
      // error: PASSES-ON — rethrown in plain words to the updater / installer, which show it
      throw connect.signal.aborted || (cause instanceof Error && cause.name === "TimeoutError") ? new Error(NO_ANSWER) : cause;
    })
    .finally(() => clearTimeout(connectTimer));
  if (!response.ok || !response.body) throw new Error(`the download failed (HTTP ${response.status})`);
  if (have > 0 && response.status !== 206) {
    // the server sent the whole file instead of the rest: start over
    hash = createHash(algorithm);
    have = 0;
  }
  if (have + Number(response.headers.get("content-length") ?? 0) > want.size) throw tooBig(source);
  const reader = response.body.getReader();
  const file = createWriteStream(path, { mode: 0o644, flags: have > 0 ? "a" : "w" });
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
  let got = have;
  // One stall timer for the whole download, pushed back after every chunk; it (or a write error) cancels the
  // reader, so the read below ends without racing a promise per chunk (the old race kept one reaction per chunk
  // alive until the end: tens of thousands on a 1.7 GB model file).
  let stallError: Error | null = null;
  // lifetime: OK — one timer per download, refreshed per chunk, cleared in finally
  // loop: NOT-WORTH — one stall deadline per download [bounded: stallMs without data]
  const stallTimer = setTimeout(() => {
    stallError = new Error("the download stopped (no data for a minute)");
    // error: NOT-WORTH — the cancel only ends the pending read; stallError is what gets thrown
    void reader.cancel().catch(() => undefined);
  }, stallMs);
  // lifetime: OK — goes with the stream (see `failed`)
  // error: NOT-WORTH — the cancel only ends the pending read; writeError is what gets thrown
  file.on("error", () => void reader.cancel().catch(() => undefined));
  try {
    // loop: SERIAL-REQUIRED — stream order: each chunk is hashed and written in sequence, with a stall deadline
    for (;;) {
      const { done, value } = await reader.read();
      stallTimer.refresh();
      if (stallError) throw stallError;
      if (writeError) throw writeError;
      if (done) break;
      got += value.byteLength;
      if (got > want.size) throw tooBig(source);
      hash.update(value);
      // lifetime: OK — fires once on drain; the stream is destroyed if `failed` wins instead
      if (!file.write(value)) await Promise.race([new Promise<void>((r) => file.once("drain", () => r())), failed]);
      progress(got, want.size);
    }
    await Promise.race([new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve()))), failed]);
  } catch (cause) {
    clearTimeout(stallTimer);
    // error: NOT-WORTH — cleanup while the real error is rethrown below; a failed cancel adds nothing
    void reader.cancel().catch(() => undefined);
    file.destroy();
    // a resumable download keeps what arrived (the next try asks for the rest); others leave nothing
    // loop: NOT-WORTH — removes a failed download (a local unlink)
    if (!opts.resume) rmSync(path, { force: true });
    throw abort?.aborted ? new Error("the download was stopped") : cause;
  }
  clearTimeout(stallTimer);
  if (got !== want.size) {
    // loop: NOT-WORTH — removes a failed download (a local unlink)
    rmSync(path, { force: true });
    throw new Error(`${refused}: the download is ${got} bytes, ${source} says ${want.size}`);
  }
  if (hash.digest("hex") !== expectHex) {
    // loop: NOT-WORTH — removes a failed download (a local unlink)
    rmSync(path, { force: true });
    throw new Error(`${refused}: the download's ${algorithm === "sha256" ? "SHA-256" : "SHA-512"} doesn't match ${source}`);
  }
}
