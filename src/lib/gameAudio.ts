let sharedAudioContext: AudioContext | null = null;

export function getGameAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;

  const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
  const AudioContextConstructor = window.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextConstructor) return null;

  try {
    sharedAudioContext ??= new AudioContextConstructor({ latencyHint: 'interactive' });
    return sharedAudioContext;
  } catch {
    return null;
  }
}

/**
 * Must be called from a trusted user gesture (pointer, click, or keyboard).
 * Reusing one context avoids browser limits and makes the soundtrack and UI
 * feedback obey the same autoplay policy.
 */
export async function unlockGameAudio(): Promise<AudioContext | null> {
  const context = getGameAudioContext();
  if (!context) return null;

  try {
    if (context.state !== 'running') await context.resume();
    return context.state === 'running' ? context : null;
  } catch {
    return null;
  }
}

export function playButtonFeedback(context: AudioContext): void {
  if (context.state !== 'running') return;

  const now = context.currentTime;
  const output = context.createGain();
  const tone = context.createOscillator();
  const overtone = context.createOscillator();
  const filter = context.createBiquadFilter();

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2400, now);
  output.gain.setValueAtTime(0.0001, now);
  output.gain.exponentialRampToValueAtTime(0.055, now + 0.008);
  output.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);

  tone.type = 'triangle';
  tone.frequency.setValueAtTime(620, now);
  tone.frequency.exponentialRampToValueAtTime(410, now + 0.065);
  overtone.type = 'sine';
  overtone.frequency.setValueAtTime(1240, now);
  overtone.frequency.exponentialRampToValueAtTime(820, now + 0.055);

  tone.connect(filter);
  overtone.connect(filter);
  filter.connect(output);
  output.connect(context.destination);

  tone.start(now);
  overtone.start(now);
  tone.stop(now + 0.08);
  overtone.stop(now + 0.06);
  tone.onended = () => {
    tone.disconnect();
    overtone.disconnect();
    filter.disconnect();
    output.disconnect();
  };
}

export async function closeGameAudioContext(): Promise<void> {
  const active = sharedAudioContext;
  sharedAudioContext = null;
  if (active && active.state !== 'closed') {
    try {
      await active.close();
    } catch {
      // Closing an already-interrupted browser context is safe to ignore.
    }
  }
}
