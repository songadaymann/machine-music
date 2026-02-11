// Strudel code validator -- allowlist-based function checker
// Phase 1: string-level validation (no AST parsing)

import type { SlotType } from "./state";

// --- Allowed functions ---

const ALLOWED_FUNCTIONS = new Set([
  // Sound sources
  "s",
  "note",
  "n",
  "bank",

  // Pattern modifiers
  "fast",
  "slow",
  "every",
  "rev",
  "jux",
  "struct",
  "off",
  "sometimes",

  // Sound shaping
  "gain",
  "pan",
  "speed",
  "attack",
  "decay",
  "sustain",
  "release",
  "lpf",
  "hpf",
  "cutoff",
  "resonance",
  "delay",
  "delaytime",
  "delayfeedback",
  "room",
  "roomsize",
  "vowel",

  // Chord / voicing
  "voicings",
]);

// --- Dangerous patterns ---

const DANGEROUS_PATTERNS = [
  /\beval\b/,
  /\bFunction\b/,
  /\bimport\b/,
  /\brequire\b/,
  /\bfetch\b/,
  /\bwindow\b/,
  /\bdocument\b/,
  /\bglobalThis\b/,
  /\bprocess\b/,
  /\b__proto__\b/,
  /\bconstructor\b/,
  /\bprototype\b/,
  /=>/, // arrow functions
  /\bfunction\b/, // function declarations
  /\bclass\b/,
  /\bnew\b/,
  /\bthis\b/,
  /\bvar\b/,
  /\blet\b/,
  /\bconst\b/,
  /\bfor\b/,
  /\bwhile\b/,
  /\bif\b/,
  /\breturn\b/,
];

// --- Note range validation ---

// Parse note names to MIDI-ish numbers for range checking
// Simple mapping: C0 = 0, C1 = 12, ..., C8 = 96
const NOTE_NAMES: Record<string, number> = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
};

function parseNoteToMidi(noteStr: string): number | null {
  // Match patterns like "a1", "c5", "e4", "g#3", "bb2"
  const match = noteStr.match(/^([a-g])([#b]?)(\d)$/i);
  if (!match) return null;

  const [, name, accidental, octaveStr] = match;
  const base = NOTE_NAMES[name.toLowerCase()];
  if (base === undefined) return null;

  const octave = parseInt(octaveStr, 10);
  let midi = base + (octave + 1) * 12; // C4 = 60

  if (accidental === "#") midi += 1;
  if (accidental === "b") midi -= 1;

  return midi;
}

// MIDI ranges for slot types
const SLOT_RANGES: Partial<Record<SlotType, { min: number; max: number; label: string }>> = {
  bass: { min: 24, max: 48, label: "C1-C3" }, // C1=24, C3=48
  chords: { min: 48, max: 72, label: "C3-C5" }, // C3=48, C5=72
  melody: { min: 60, max: 96, label: "C4-C7" }, // C4=60, C7=96
};

// --- Validation result ---

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// --- Main validator ---

export function validateStrudelCode(
  code: string,
  slotType: SlotType,
  charLimit: number = 280
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Character limit
  if (code.length > charLimit) {
    errors.push(`Code exceeds ${charLimit} character limit (${code.length} chars)`);
  }

  if (code.trim().length === 0) {
    errors.push("Code cannot be empty");
    return { valid: false, errors, warnings };
  }

  // 2. Dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(`Forbidden pattern detected: ${pattern.source}`);
    }
  }

  // 3. Extract function calls and check allowlist
  // Match word( patterns -- these are function calls
  const functionCalls = code.match(/\b([a-zA-Z_]\w*)\s*\(/g);
  if (functionCalls) {
    for (const call of functionCalls) {
      const fnName = call.replace(/\s*\($/, "");
      if (!ALLOWED_FUNCTIONS.has(fnName)) {
        errors.push(`Function "${fnName}" is not in the allowed set`);
      }
    }
  }

  // 4. Slot type constraints
  if (slotType === "drums") {
    // Drums: must use s(), should not use note() with pitched content
    if (/\bnote\s*\(/.test(code)) {
      // Check if it contains pitched notes (not just sample indices)
      const noteArgs = extractStringArgs(code, "note");
      for (const arg of noteArgs) {
        if (/[a-g][#b]?\d/i.test(arg)) {
          errors.push("DRUMS slots cannot use pitched notes. Use s() with percussion samples.");
          break;
        }
      }
    }
  }

  // For bass/chords/melody, check note ranges
  const range = SLOT_RANGES[slotType];
  if (range) {
    const noteArgs = extractStringArgs(code, "note");
    for (const arg of noteArgs) {
      // Extract individual notes from the pattern string
      const notes = extractNotesFromPattern(arg);
      for (const note of notes) {
        const midi = parseNoteToMidi(note);
        if (midi !== null) {
          if (midi < range.min || midi > range.max) {
            warnings.push(
              `Note "${note}" is outside ${slotType.toUpperCase()} range (${range.label})`
            );
          }
        }
      }
    }
  }

  // 5. Basic syntax check: balanced parentheses and quotes
  if (!hasBalancedParens(code)) {
    errors.push("Unbalanced parentheses");
  }
  if (!hasBalancedQuotes(code)) {
    errors.push("Unbalanced quotes");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// --- Helpers ---

/** Extract string arguments from a specific function call */
function extractStringArgs(code: string, fnName: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`\\b${fnName}\\s*\\(\\s*"([^"]*)"`, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code)) !== null) {
    results.push(match[1]);
  }
  return results;
}

/** Extract note names from a Strudel mini-notation pattern string */
function extractNotesFromPattern(pattern: string): string[] {
  const notes: string[] = [];
  // Match note patterns like a4, c#3, bb2, e5
  const regex = /\b([a-g][#b]?\d)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pattern)) !== null) {
    notes.push(match[1]);
  }
  return notes;
}

function hasBalancedParens(code: string): boolean {
  let depth = 0;
  let inString = false;
  let stringChar = "";
  for (const ch of code) {
    if (inString) {
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function hasBalancedQuotes(code: string): boolean {
  let singleCount = 0;
  let doubleCount = 0;
  for (const ch of code) {
    if (ch === "'") singleCount++;
    if (ch === '"') doubleCount++;
  }
  return singleCount % 2 === 0 && doubleCount % 2 === 0;
}
