/**
 * Types for the speech proxy.
 *
 * The proxy itself is plain JavaScript on purpose: it has to run unchanged as
 * Vite middleware, as a route in any Node server, and under `node` directly,
 * with no build step between it and production. These declarations give its
 * callers and its tests types without putting it behind a compiler.
 */

/**
 * The part of a `fetch` response the proxy touches.
 *
 * Narrower than `Response` on purpose: the real `fetch` satisfies it, and so
 * does a plain object, which is what makes the upstream mockable without
 * constructing whole Response instances in tests.
 */
export interface UpstreamResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface TtsProxyOptions {
  /** Where credentials are read from. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: (url: URL | string, init: RequestInit) => Promise<UpstreamResponse>;
}

/** A Connect-style handler: `(req, res, next?)`. */
export type TtsProxyHandler = (req: unknown, res: unknown, next?: () => void) => Promise<void>;

export function createTtsProxy(options?: TtsProxyOptions): TtsProxyHandler;

/** Readable alias: the proxy covers speech synthesis and agent tokens. */
export { createTtsProxy as createSpeechProxy };

export interface TtsProxyPlugin {
  readonly name: string;
  configureServer(server: { middlewares: { use(handler: TtsProxyHandler): void } }): void;
  configurePreviewServer(server: { middlewares: { use(handler: TtsProxyHandler): void } }): void;
}

export function ttsProxyPlugin(options?: TtsProxyOptions): TtsProxyPlugin;
