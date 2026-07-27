/**
 * Shared test doubles. Nothing here touches the network or a real filesystem
 * path outside a per-test temp dir.
 */

import { mkdtempSync, rmSync } from "fs";
import { IncomingMessage, ServerResponse } from "http";
import { Socket } from "net";
import { tmpdir } from "os";
import { join } from "path";
import type { FetchLike } from "../src/types";

export interface StubResponse {
  status?: number;
  /** Object/array bodies are JSON-encoded; strings are sent verbatim. */
  body?: unknown;
  /** Raw bytes, for image-download paths that read arrayBuffer(). */
  bytes?: Buffer;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * Scripted fetch: hands back queued responses in order and records every call.
 * A function response lets a test react to the request it just received.
 */
export class FetchStub {
  readonly calls: RecordedCall[] = [];
  private readonly queue: Array<StubResponse | ((call: RecordedCall) => StubResponse)> = [];
  private fallback: StubResponse | null = null;

  /** Queue one response. */
  push(response: StubResponse | ((call: RecordedCall) => StubResponse)): this {
    this.queue.push(response);
    return this;
  }

  /** Queue the same response n times. */
  pushMany(n: number, response: StubResponse): this {
    for (let i = 0; i < n; i += 1) this.queue.push(response);
    return this;
  }

  /** Response used once the queue is drained (instead of throwing). */
  setFallback(response: StubResponse): this {
    this.fallback = response;
    return this;
  }

  get fetch(): FetchLike {
    return (async (url, init) => {
      const call: RecordedCall = {
        url,
        method: init?.method ?? "GET",
        headers: init?.headers ?? {},
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      this.calls.push(call);
      const next = this.queue.shift() ?? this.fallback;
      if (!next) {
        throw new Error(`FetchStub: unexpected ${call.method} ${url} (queue empty)`);
      }
      const spec = typeof next === "function" ? next(call) : next;
      return makeResponse(spec);
    }) as FetchLike;
  }

  /** Requests recorded so far, as "METHOD /path". */
  summary(): string[] {
    return this.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
  }

  /** Calls whose path ends with `suffix` (auth vs resource discrimination). */
  callsTo(suffix: string): RecordedCall[] {
    return this.calls.filter((c) => new URL(c.url).pathname.endsWith(suffix));
  }

  get pending(): number {
    return this.queue.length;
  }
}

function makeResponse(spec: StubResponse): {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
} {
  const status = spec.status ?? 200;
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(spec.headers ?? {})) {
    lower.set(key.toLowerCase(), value);
  }
  const text =
    spec.body === undefined
      ? ""
      : typeof spec.body === "string"
        ? spec.body
        : JSON.stringify(spec.body);
  const bytes = spec.bytes ?? Buffer.from(text, "utf8");
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    text: async () => text,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

/** Shoper list envelope, so a stub body matches what the client parses. */
export function listBody<T>(list: T[], extra: Partial<{ count: number; pages: number; page: number }> = {}): {
  count: number;
  pages: number;
  page: number;
  list: T[];
} {
  return {
    count: extra.count ?? list.length,
    pages: extra.pages ?? 1,
    page: extra.page ?? 1,
    list,
  };
}

/** Sleep recorder — asserts on backoff without spending wall-clock time. */
export function sleepSpy(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

/** Per-test temp directory, auto-cleaned by the returned function. */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fhshoper-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface InjectedResponse {
  status: number;
  headers: Record<string, string | number | string[] | undefined>;
  body: string;
  json: <T = Record<string, unknown>>() => T;
}

export interface InjectOptions {
  headers?: Record<string, string>;
  body?: unknown;
  /** Source address the throttle keys on. */
  remoteAddress?: string;
}

/**
 * Anything callable as an Express request handler. `Express`'s published type
 * hides the internal `handle()`, but the app object is itself the `(req, res)`
 * listener, so that is what the injector calls.
 */
export type RequestListenerLike = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Drive an Express app through its real middleware chain without binding a
 * port. The request/response pair are the genuine Node objects the app expects,
 * wired to a detached socket that is never connected — so the whole stack
 * (admin gate, CSRF check, throttle, error handler) runs for real while the
 * test stays offline.
 */
export function inject(
  app: RequestListenerLike,
  method: string,
  url: string,
  options: InjectOptions = {}
): Promise<InjectedResponse> {
  const payload =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);

  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method.toUpperCase();
  req.url = url;
  req.headers = {
    host: "localhost",
    ...(payload !== undefined
      ? {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        }
      : {}),
    ...lowerKeys(options.headers ?? {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: options.remoteAddress ?? "10.0.0.1",
    configurable: true,
  });

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];

  return new Promise<InjectedResponse>((resolve, reject) => {
    const finish = (): void => {
      const body = Buffer.concat(chunks).toString("utf8");
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        body,
        json: <T>() => JSON.parse(body) as T,
      });
    };
    res.on("finish", finish);
    // ServerResponse would try to flush through the unconnected socket, so the
    // write path is captured instead.
    (res as unknown as { write: (chunk?: unknown) => boolean }).write = (chunk?: unknown) => {
      if (chunk) chunks.push(Buffer.from(chunk as string));
      return true;
    };
    (res as unknown as { end: (chunk?: unknown) => unknown }).end = (chunk?: unknown) => {
      if (chunk) chunks.push(Buffer.from(chunk as string));
      res.emit("finish");
      return res;
    };

    try {
      app(req, res);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (payload !== undefined) req.emit("data", Buffer.from(payload, "utf8"));
    req.emit("end");
  });
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

/** Smallest byte sequence sniffImageMime accepts as a PNG (12-byte minimum). */
export const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
