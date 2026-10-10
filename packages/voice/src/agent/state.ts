import type { OrbState } from '@deadwick/orb-engine';

/** Where the WebSocket is. */
export type AgentConnection = 'closed' | 'connecting' | 'open' | 'failed';

/** Everything the orb's state depends on, in one plain object. */
export interface AgentStatus {
  readonly connection: AgentConnection;
  /** The mic latch: true from the moment the user switches it on. */
  readonly micOpen: boolean;
  /** getUserMedia is outstanding — asked for, nothing arriving yet. */
  readonly micArming: boolean;
  readonly agentThinking: boolean;
  readonly agentSpeaking: boolean;
}

export const IDLE_STATUS: AgentStatus = {
  connection: 'closed',
  micOpen: false,
  micArming: false,
  agentThinking: false,
  agentSpeaking: false,
};

/**
 * Map the agent's situation onto one of the orb's six states.
 *
 * Order matters, and it is a priority rather than a sequence: several of
 * these can be true at once. The agent can still be speaking when the user
 * opens the mic to interrupt it, and the mic can be open while the agent
 * thinks. What the orb shows is whatever is most worth knowing at that
 * instant, which is why this is a pure function with its own tests rather
 * than a scattering of setState calls across event handlers.
 */
export function resolveOrbState(status: AgentStatus): OrbState {
  // A broken connection outranks everything: nothing else is true any more.
  if (status.connection === 'failed') return 'error';

  // The agent's own voice is the most informative thing on screen.
  if (status.agentSpeaking) return 'speaking';
  if (status.agentThinking) return 'processing';

  // Asked for, not yet arrived — the honest in-between, whether that is the
  // socket opening or the microphone permission being considered.
  if (status.connection === 'connecting' || status.micArming) return 'arming';

  // The recording light, and only while there is genuinely a live microphone.
  if (status.micOpen && status.connection === 'open') return 'listening';

  return 'idle';
}
