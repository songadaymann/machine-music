// Music theory utilities for world rituals (scale computation, validation)

const CHROMATIC = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

const SCALE_INTERVALS: Record<string, number[]> = {
  pentatonic: [0, 3, 5, 7, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

const VALID_KEYS = new Set<string>(CHROMATIC);

export const MIN_BPM = 60;
export const MAX_BPM = 200;
export const VALID_KEYS_LIST = [...CHROMATIC] as string[];
export const VALID_SCALES = Object.keys(SCALE_INTERVALS);

export function isValidKey(key: string): boolean {
  return VALID_KEYS.has(key);
}

export function isValidScale(scale: string): boolean {
  return scale in SCALE_INTERVALS;
}

export function computeScaleNotes(key: string, scale: string): string[] {
  const rootIndex = CHROMATIC.indexOf(key as (typeof CHROMATIC)[number]);
  if (rootIndex === -1) return [];
  const intervals = SCALE_INTERVALS[scale];
  if (!intervals) return [];
  return intervals.map((i) => CHROMATIC[(rootIndex + i) % 12] as string);
}
