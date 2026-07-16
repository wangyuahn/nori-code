export type NotificationSound = 'complete' | 'agent-complete' | 'attention' | 'error';

export interface SoundPreferences {
  enabled: boolean;
  volume: number;
}

const STORAGE_KEY = 'nori-notification-sounds';
const DEFAULT_PREFERENCES: SoundPreferences = { enabled: true, volume: 0.32 };
const lastPlayed = new Map<NotificationSound, number>();
let audioContext: AudioContext | null = null;

export function loadSoundPreferences(): SoundPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<SoundPreferences> | null;
    return {
      enabled: typeof parsed?.enabled === 'boolean' ? parsed.enabled : DEFAULT_PREFERENCES.enabled,
      volume: clampVolume(typeof parsed?.volume === 'number' ? parsed.volume : DEFAULT_PREFERENCES.volume),
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function saveSoundPreferences(preferences: SoundPreferences): SoundPreferences {
  const normalized = { enabled: preferences.enabled, volume: clampVolume(preferences.volume) };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch {}
  window.dispatchEvent(new CustomEvent('nori:sound-preferences-changed', { detail: normalized }));
  return normalized;
}

export function installSoundUnlock(): () => void {
  const unlock = () => {
    if (!loadSoundPreferences().enabled) return;
    const context = ensureAudioContext();
    void context?.resume().catch(() => undefined);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  return () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
}

export function playNotificationSound(sound: NotificationSound, force = false): void {
  const preferences = loadSoundPreferences();
  if (!force && !preferences.enabled) return;
  const now = Date.now();
  const throttle = sound === 'agent-complete' ? 1600 : 700;
  if (!force && now - (lastPlayed.get(sound) ?? 0) < throttle) return;
  lastPlayed.set(sound, now);
  const context = ensureAudioContext();
  if (!context) return;
  void context.resume().then(() => playSequence(context, SOUND_SEQUENCES[sound], preferences.volume)).catch(() => undefined);
}

const SOUND_SEQUENCES: Record<NotificationSound, Array<{ frequency: number; offset: number; duration: number; gain: number; type?: OscillatorType }>> = {
  complete: [
    { frequency: 523.25, offset: 0, duration: 0.12, gain: 0.7 },
    { frequency: 659.25, offset: 0.07, duration: 0.13, gain: 0.62 },
    { frequency: 783.99, offset: 0.14, duration: 0.22, gain: 0.52 },
  ],
  'agent-complete': [
    { frequency: 392, offset: 0, duration: 0.1, gain: 0.52 },
    { frequency: 523.25, offset: 0.075, duration: 0.14, gain: 0.48 },
    { frequency: 659.25, offset: 0.15, duration: 0.18, gain: 0.42 },
  ],
  attention: [
    { frequency: 740, offset: 0, duration: 0.1, gain: 0.5 },
    { frequency: 740, offset: 0.16, duration: 0.13, gain: 0.46 },
  ],
  error: [
    { frequency: 246.94, offset: 0, duration: 0.13, gain: 0.5, type: 'triangle' },
    { frequency: 196, offset: 0.12, duration: 0.22, gain: 0.45, type: 'triangle' },
  ],
};

function ensureAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;
  const Constructor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) return null;
  audioContext = new Constructor();
  return audioContext;
}

function playSequence(context: AudioContext, sequence: typeof SOUND_SEQUENCES[NotificationSound], volume: number): void {
  const start = context.currentTime + 0.01;
  for (const note of sequence) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = start + note.offset;
    const noteEnd = noteStart + note.duration;
    oscillator.type = note.type ?? 'sine';
    oscillator.frequency.setValueAtTime(note.frequency, noteStart);
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * note.gain), noteStart + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteEnd + 0.01);
  }
}

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : DEFAULT_PREFERENCES.volume));
}
