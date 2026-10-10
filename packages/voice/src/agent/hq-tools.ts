/**
 * The tools Jarwick uses inside HQ, answered through the HQ bridge
 * (server/hq-bridge.mjs) on the same origin. Pass the result as
 * `functions` to createVoiceAgent.
 */
export function createHqTools(base = ''): Record<string, (args: Record<string, unknown>) => Promise<string>> {
  const text = async (response: Response): Promise<string> => {
    const body = await response.text();
    if (!response.ok) throw new Error(body || `HTTP ${response.status}`);
    return body;
  };
  return {
    get_live_price: async () => text(await fetch(`${base}/api/hq/live`, { cache: 'no-store' })),
    refresh_hq: async () => text(await fetch(`${base}/api/hq/context`, { cache: 'no-store' })),
    log_trade_idea: async (args) =>
      text(
        await fetch(`${base}/api/hq/idea`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        }),
      ),
  };
}
