/**
 * PCM conversion.
 *
 * The Voice Agent speaks raw 16-bit little-endian PCM in both directions:
 * microphone audio goes up as linear16, and the agent's voice comes back as
 * linear16 with no container, which means no decoder will touch it. These
 * conversions are the boundary between Web Audio's float samples and the
 * wire format, and they are pure so the arithmetic can be tested without a
 * browser.
 */

/*
 * The `<ArrayBuffer>` on these return types is not decoration. Since
 * TypeScript 5.7 a typed array is generic over its backing buffer, and a bare
 * `Float32Array` means `Float32Array<ArrayBufferLike>` — which could be a
 * SharedArrayBuffer. Web Audio's copyToChannel refuses that, so the concrete
 * buffer type has to be stated for these to be usable where they are meant to
 * be used.
 */

/**
 * Float samples (-1..1) to signed 16-bit.
 *
 * The asymmetric scaling is deliberate. Signed 16-bit runs -32768..32767, so
 * scaling both directions by 32767 wastes a step at the bottom while scaling
 * both by 32768 clips the top. Each direction is scaled by its own limit, and
 * the input is clamped first because Web Audio does not guarantee -1..1 after
 * gain has been applied.
 */
export function floatToInt16(input: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i]!;
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    out[i] = clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * 32_767);
  }
  return out;
}

/** Signed 16-bit back to float samples in -1..1. */
export function int16ToFloat(input: Int16Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i]!;
    out[i] = sample < 0 ? sample / 32_768 : sample / 32_767;
  }
  return out;
}

/**
 * Read a chunk of little-endian 16-bit PCM straight off the wire.
 *
 * Byte offsets are honoured and odd lengths are tolerated: a WebSocket frame
 * can split a sample across two messages, and dropping the trailing byte is
 * better than reading past the end. The caller keeps no remainder because at
 * 24kHz a single lost sample is forty microseconds.
 */
export function decodePcm16(bytes: ArrayBuffer | ArrayBufferView): Float32Array<ArrayBuffer> {
  const view =
    bytes instanceof ArrayBuffer
      ? new DataView(bytes)
      : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const sampleCount = Math.floor(view.byteLength / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = view.getInt16(i * 2, true);
    out[i] = sample < 0 ? sample / 32_768 : sample / 32_767;
  }
  return out;
}

/** Root mean square of a block, for a cheap "is anyone talking" reading. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < samples.length; i += 1) total += samples[i]! * samples[i]!;
  return Math.sqrt(total / samples.length);
}
