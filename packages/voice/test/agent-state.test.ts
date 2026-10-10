import { describe, expect, it } from 'vitest';
import { IDLE_STATUS, resolveOrbState } from '../src/agent/state.js';
import type { AgentStatus } from '../src/agent/state.js';

const status = (partial: Partial<AgentStatus>): AgentStatus => ({ ...IDLE_STATUS, ...partial });

describe('resolveOrbState', () => {
  it('is idle when nothing is happening', () => {
    expect(resolveOrbState(IDLE_STATUS)).toBe('idle');
  });

  it('arms while the socket is opening', () => {
    expect(resolveOrbState(status({ connection: 'connecting' }))).toBe('arming');
  });

  it('arms while the microphone permission is outstanding', () => {
    expect(resolveOrbState(status({ connection: 'open', micArming: true }))).toBe('arming');
  });

  it('listens only once there is genuinely a live microphone', () => {
    expect(resolveOrbState(status({ connection: 'open', micOpen: true }))).toBe('listening');
    // Latched on, but the socket is gone: nothing is being heard, so the
    // recording light must not be on.
    expect(resolveOrbState(status({ connection: 'closed', micOpen: true }))).toBe('idle');
    expect(resolveOrbState(status({ connection: 'connecting', micOpen: true }))).toBe('arming');
  });

  it('shows thinking over listening', () => {
    expect(
      resolveOrbState(status({ connection: 'open', micOpen: true, agentThinking: true })),
    ).toBe('processing');
  });

  it('shows speaking over thinking and listening', () => {
    expect(
      resolveOrbState(
        status({ connection: 'open', micOpen: true, agentThinking: true, agentSpeaking: true }),
      ),
    ).toBe('speaking');
  });

  it('keeps showing the agent speaking while the user interrupts it', () => {
    // Barge-in: the mic is open and the agent has not stopped yet. The useful
    // thing on screen is still the agent's voice.
    expect(
      resolveOrbState(status({ connection: 'open', micOpen: true, agentSpeaking: true })),
    ).toBe('speaking');
  });

  it('puts a failed connection above everything else', () => {
    expect(
      resolveOrbState(
        status({ connection: 'failed', micOpen: true, agentSpeaking: true, agentThinking: true }),
      ),
    ).toBe('error');
  });

  it('returns to idle when the mic latch closes and the agent is quiet', () => {
    expect(resolveOrbState(status({ connection: 'open', micOpen: false }))).toBe('idle');
  });

  it('lets the agent finish speaking after the mic latch closes', () => {
    expect(
      resolveOrbState(status({ connection: 'open', micOpen: false, agentSpeaking: true })),
    ).toBe('speaking');
  });

  it('only ever returns states the orb knows', () => {
    const known = ['idle', 'arming', 'listening', 'processing', 'speaking', 'error'];
    const flags = [true, false];
    for (const connection of ['closed', 'connecting', 'open', 'failed'] as const) {
      for (const micOpen of flags) {
        for (const micArming of flags) {
          for (const agentThinking of flags) {
            for (const agentSpeaking of flags) {
              const result = resolveOrbState({
                connection,
                micOpen,
                micArming,
                agentThinking,
                agentSpeaking,
              });
              expect(known).toContain(result);
            }
          }
        }
      }
    }
  });
});
