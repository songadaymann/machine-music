// Strudel code validator -- safety-first checker with permissive function usage
// Phase 1: string-level validation (no AST parsing)

import type { SlotType } from "./state";

export const MAX_CODE_CHARS = 560;

// --- Hard-banned Strudel functions ---
// We keep composition freedom broad while blocking known crashers and global
// mutators that can destabilize the shared runtime for everyone.
const HARD_BANNED_FUNCTIONS = new Set([
  "voicings",
  "samples",
  "soundAlias",
]);

// Known functions that are syntactically plausible but missing in the current
// Strudel runtime used by this project.
const RUNTIME_UNSUPPORTED_FUNCTIONS = new Set([
  "space",
  "feedback",
  "reverb",
]);

// Strudel signals that are values, NOT callable functions.
// LLMs frequently hallucinate sine(...), saw(...), etc. as function calls.
// Correct usage: sine.range(200, 2000), saw.slow(4), etc.
const SIGNAL_NOT_FUNCTION = new Set([
  "sine",
  "cosine",
  "saw",
  "square",
  "tri",
  "rand",
  "irand",
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

  const name = match[1];
  const accidental = match[2] ?? "";
  const octaveStr = match[3];
  if (!name || !octaveStr) return null;

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
  charLimit: number = MAX_CODE_CHARS
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const trimmed = code.trim();

  // 1. Character limit
  if (code.length > charLimit) {
    errors.push(`Code exceeds ${charLimit} character limit (${code.length} chars)`);
  }

  if (trimmed.length === 0) {
    errors.push("Code cannot be empty");
    return { valid: false, errors, warnings };
  }

  // 1b. Structural guardrails: require a raw Strudel expression.
  const outsideStrings = stripQuotedContent(trimmed).trim();
  if (/^[{[]/.test(trimmed)) {
    errors.push("Code must be a Strudel expression only (no JSON/object wrapper)");
  }
  if (/^["']?[a-zA-Z_]\w*["']?\s*:/.test(outsideStrings)) {
    errors.push("Code must be a raw Strudel expression, not a labeled field like pattern:");
  }
  if (!/^\(?\s*[a-zA-Z_]\w*\s*\(/.test(trimmed)) {
    errors.push("Code must start with a Strudel expression call like s(...), note(...), n(...), or stack(...)");
  }

  // 2. Dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(`Forbidden pattern detected: ${pattern.source}`);
    }
  }

  // 3. Extract function calls and check hard bans
  // Match word( patterns -- these are function calls
  const functionCalls = code.match(/\b([a-zA-Z_]\w*)\s*\(/g);
  if (functionCalls) {
    for (const call of functionCalls) {
      const fnName = call.replace(/\s*\($/, "");
      if (HARD_BANNED_FUNCTIONS.has(fnName)) {
        errors.push(
          `Function "${fnName}()" is banned in this runtime. ` +
          `Use built-in sounds/synths without mutating sample maps.`
        );
      }
      if (RUNTIME_UNSUPPORTED_FUNCTIONS.has(fnName)) {
        const replacement = fnName === "feedback" ? "delayfeedback()" : "room()";
        errors.push(
          `Function "${fnName}()" is not available in the current SynthMob runtime. ` +
          `Use ${replacement} (or other supported effects) instead.`
        );
      }
      if (SIGNAL_NOT_FUNCTION.has(fnName)) {
        errors.push(
          `"${fnName}" is a signal value, not a function — do not call it as ${fnName}(). ` +
          `Use it as a value: ${fnName}.range(min, max), ${fnName}.slow(n), or pass it directly to an effect.`
        );
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

  // 5. Sound source functions must have quoted string arguments
  //    Catches: note(<[a3 c4]>) -- must be note("<[a3 c4]>")
  const QUOTED_ARG_FUNCTIONS = ["s", "note", "n"];
  for (const fn of QUOTED_ARG_FUNCTIONS) {
    const unquotedRegex = new RegExp(`\\b${fn}\\s*\\(\\s*[^"')\\s]`, "g");
    // But allow numeric args like n(3) -- only flag if it looks like mini-notation
    const unquotedMatches = code.match(unquotedRegex);
    if (unquotedMatches) {
      for (const m of unquotedMatches) {
        // Allow bare numbers: note(3), n(0), s(1)
        const argChar = m.charAt(m.length - 1);
        if (!/\d/.test(argChar)) {
          errors.push(
            `${fn}() argument must be a quoted string. ` +
            `Use ${fn}("...") not ${fn}(...). Mini-notation like <> [] must be inside quotes.`
          );
          break;
        }
      }
    }
  }

  // 5b. Known mini-notation parser pitfalls that frequently crash playback.
  // These are conservative guards until AST-level validation is introduced.
  const miniNotationArgs = QUOTED_ARG_FUNCTIONS.flatMap((fn) =>
    extractStringArgs(code, fn).map((arg) => ({ fn, arg }))
  );
  for (const { fn, arg } of miniNotationArgs) {
    // Empty or unbalanced parens inside mini-notation crash the Strudel parser.
    const parenError = hasMiniNotationParenError(arg);
    if (parenError) {
      errors.push(
        `${fn}() mini-notation has ${parenError} in "${arg}". ` +
        `Remove stray parentheses from the pattern string.`
      );
      continue;
    }

    // Example bad form: hh(1/4,1/8)
    if (/\(\s*\d+\s*\/\s*\d+\s*,\s*\d+\s*\/\s*\d+\s*\)/.test(arg)) {
      errors.push(
        `${fn}() mini-notation contains a fraction tuple with a comma (${arg}). ` +
        `Use stable patterns without fraction tuples inside () to avoid parser failures.`
      );
      continue;
    }

    // Example bad form seen from LLMs: fm(0.5,0.2,0.4,0.7) inside s("...")
    if (
      fn === "s" &&
      /\b[a-zA-Z_]\w*\s*\(\s*\d+\.\d+\s*(?:,\s*\d*\.?\d+\s*)+\)/.test(arg)
    ) {
      errors.push(
        `s() mini-notation appears to contain function-like decimal tuples (${arg}). ` +
        `Use plain sample tokens in s("..."), and apply effects as chained methods instead.`
      );
      continue;
    }

    // Example bad form: [a3,c4,e4]
    if (/\[[^\]]*,[^\]]*\]/.test(arg)) {
      errors.push(
        `${fn}() mini-notation uses comma-separated groups (${arg}). ` +
        `Use spaces inside [] groups, e.g. [a3 c4 e4].`
      );
      continue;
    }

    // Example bad form: note("<c4,e4,a4>")
    // In note()/n() mini-notation, comma separators commonly trigger parser failures.
    if ((fn === "note" || fn === "n") && arg.includes(",")) {
      errors.push(
        `${fn}() mini-notation contains commas (${arg}). ` +
        `Use spaces between notes/tokens, not commas.`
      );
    }
  }

  // 6. Basic syntax check: balanced parentheses and quotes
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
    const arg = match[1];
    if (typeof arg === "string") {
      results.push(arg);
    }
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
    const note = match[1];
    if (typeof note === "string") {
      notes.push(note);
    }
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

/** Check for paren problems inside a mini-notation string argument */
function hasMiniNotationParenError(arg: string): string | null {
  // Empty parens: bd() or sd() -- Strudel mini has no empty-paren construct
  if (/\(\s*\)/.test(arg)) {
    return "empty parentheses ()";
  }
  // Unbalanced parens
  let depth = 0;
  for (const ch of arg) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth < 0) return "stray closing parenthesis ')'";
  }
  if (depth > 0) return "unclosed parenthesis '('";
  return null;
}

function stripQuotedContent(input: string): string {
  let out = "";
  let inQuote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of input) {
    if (inQuote) {
      if (escaped) {
        escaped = false;
        out += " ";
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += " ";
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
        out += ch;
      } else {
        out += " ";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      out += ch;
      continue;
    }

    out += ch;
  }

  return out;
}

// --- Spatial music pattern validator (no slot-type constraints) ---

export function validateSpatialPattern(
  code: string,
  charLimit: number = MAX_CODE_CHARS
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const trimmed = code.trim();

  if (code.length > charLimit) {
    errors.push(`Code exceeds ${charLimit} character limit (${code.length} chars)`);
  }

  if (trimmed.length === 0) {
    errors.push("Code cannot be empty");
    return { valid: false, errors, warnings };
  }

  // Structural guardrails
  const outsideStrings = stripQuotedContent(trimmed).trim();
  if (/^[{[]/.test(trimmed)) {
    errors.push("Code must be a Strudel expression only (no JSON/object wrapper)");
  }
  if (/^["']?[a-zA-Z_]\w*["']?\s*:/.test(outsideStrings)) {
    errors.push("Code must be a raw Strudel expression, not a labeled field like pattern:");
  }
  if (!/^\(?\s*[a-zA-Z_]\w*\s*\(/.test(trimmed)) {
    errors.push("Code must start with a Strudel expression call like s(...), note(...), n(...), or stack(...)");
  }

  // Dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(`Forbidden pattern detected: ${pattern.source}`);
    }
  }

  // Function call checks
  const functionCalls = code.match(/\b([a-zA-Z_]\w*)\s*\(/g);
  if (functionCalls) {
    for (const call of functionCalls) {
      const fnName = call.replace(/\s*\($/, "");
      if (HARD_BANNED_FUNCTIONS.has(fnName)) {
        errors.push(
          `Function "${fnName}()" is banned in this runtime. ` +
          `Use built-in sounds/synths without mutating sample maps.`
        );
      }
      if (RUNTIME_UNSUPPORTED_FUNCTIONS.has(fnName)) {
        const replacement = fnName === "feedback" ? "delayfeedback()" : "room()";
        errors.push(
          `Function "${fnName}()" is not available in the current SynthMob runtime. ` +
          `Use ${replacement} (or other supported effects) instead.`
        );
      }
      if (SIGNAL_NOT_FUNCTION.has(fnName)) {
        errors.push(
          `"${fnName}" is a signal value, not a function — do not call it as ${fnName}(). ` +
          `Use it as a value: ${fnName}.range(min, max), ${fnName}.slow(n), or pass it directly to an effect.`
        );
      }
    }
  }

  // No slot-type constraints — spatial patterns are freeform

  // Sound source functions must have quoted string arguments
  const QUOTED_ARG_FUNCTIONS = ["s", "note", "n"];
  for (const fn of QUOTED_ARG_FUNCTIONS) {
    const unquotedRegex = new RegExp(`\\b${fn}\\s*\\(\\s*[^"')\\s]`, "g");
    const unquotedMatches = code.match(unquotedRegex);
    if (unquotedMatches) {
      for (const m of unquotedMatches) {
        const argChar = m.charAt(m.length - 1);
        if (!/\d/.test(argChar)) {
          errors.push(
            `${fn}() argument must be a quoted string. ` +
            `Use ${fn}("...") not ${fn}(...). Mini-notation like <> [] must be inside quotes.`
          );
          break;
        }
      }
    }
  }

  // Mini-notation checks
  const miniNotationArgs = QUOTED_ARG_FUNCTIONS.flatMap((fn) =>
    extractStringArgs(code, fn).map((arg) => ({ fn, arg }))
  );
  for (const { fn, arg } of miniNotationArgs) {
    const parenError = hasMiniNotationParenError(arg);
    if (parenError) {
      errors.push(
        `${fn}() mini-notation has ${parenError} in "${arg}". ` +
        `Remove stray parentheses from the pattern string.`
      );
      continue;
    }
    if (/\(\s*\d+\s*\/\s*\d+\s*,\s*\d+\s*\/\s*\d+\s*\)/.test(arg)) {
      errors.push(
        `${fn}() mini-notation contains a fraction tuple with a comma (${arg}). ` +
        `Use stable patterns without fraction tuples inside () to avoid parser failures.`
      );
      continue;
    }
    if (
      fn === "s" &&
      /\b[a-zA-Z_]\w*\s*\(\s*\d+\.\d+\s*(?:,\s*\d*\.?\d+\s*)+\)/.test(arg)
    ) {
      errors.push(
        `s() mini-notation appears to contain function-like decimal tuples (${arg}). ` +
        `Use plain sample tokens in s("..."), and apply effects as chained methods instead.`
      );
      continue;
    }
    if (/\[[^\]]*,[^\]]*\]/.test(arg)) {
      errors.push(
        `${fn}() mini-notation uses comma-separated groups (${arg}). ` +
        `Use spaces inside [] groups, e.g. [a3 c4 e4].`
      );
      continue;
    }
    if ((fn === "note" || fn === "n") && arg.includes(",")) {
      errors.push(
        `${fn}() mini-notation contains commas (${arg}). ` +
        `Use spaces between notes/tokens, not commas.`
      );
    }
  }

  // Balanced parens and quotes
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

// --- Creative session output validators ---

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_OUTPUT_JSON_SIZE = 32768; // 32KB (increased for voxel payloads)

function isValidColor(v: unknown): boolean {
  return typeof v === "string" && HEX_COLOR_RE.test(v);
}

function isFiniteInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

function optionalColor(obj: Record<string, unknown>, key: string, errors: string[]): void {
  if (obj[key] !== undefined && !isValidColor(obj[key])) {
    errors.push(`${key}: invalid hex color (use #rgb or #rrggbb)`);
  }
}

function optionalNumber(obj: Record<string, unknown>, key: string, min: number, max: number, errors: string[]): void {
  if (obj[key] !== undefined && !isFiniteInRange(obj[key], min, max)) {
    errors.push(`${key}: must be a number between ${min} and ${max}`);
  }
}

// --- Visual output validator ---

const VISUAL_ELEMENT_TYPES = new Set(["circle", "rect", "line", "ellipse", "text", "path", "polygon"]);
const MAX_VISUAL_ELEMENTS = 80;
const MAX_VISUAL_COORD = 2000;
const MAX_TEXT_CONTENT = 100;
const MAX_PATH_POINTS = 50;

export function validateVisualOutput(output: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    errors.push("Output must be a JSON object");
    return { valid: false, errors, warnings };
  }

  const raw = JSON.stringify(output);
  if (raw.length > MAX_OUTPUT_JSON_SIZE) {
    errors.push(`Output exceeds ${MAX_OUTPUT_JSON_SIZE} byte limit`);
    return { valid: false, errors, warnings };
  }

  const o = output as Record<string, unknown>;

  // Canvas settings
  if (o.canvas !== undefined) {
    if (typeof o.canvas !== "object" || o.canvas === null) {
      errors.push("canvas: must be an object");
    } else {
      const c = o.canvas as Record<string, unknown>;
      optionalNumber(c, "width", 100, 2000, errors);
      optionalNumber(c, "height", 100, 2000, errors);
      optionalColor(c, "background", errors);
    }
  }

  // Elements
  if (!Array.isArray(o.elements)) {
    errors.push("elements: required array");
    return { valid: errors.length === 0, errors, warnings };
  }

  if (o.elements.length > MAX_VISUAL_ELEMENTS) {
    errors.push(`elements: max ${MAX_VISUAL_ELEMENTS} elements allowed`);
    return { valid: false, errors, warnings };
  }

  for (let i = 0; i < o.elements.length; i++) {
    const el = o.elements[i] as Record<string, unknown>;
    if (typeof el !== "object" || el === null) {
      errors.push(`elements[${i}]: must be an object`);
      continue;
    }
    if (!VISUAL_ELEMENT_TYPES.has(el.type as string)) {
      errors.push(`elements[${i}].type: must be one of ${[...VISUAL_ELEMENT_TYPES].join(", ")}`);
      continue;
    }

    // Validate common properties
    optionalColor(el, "fill", errors);
    optionalColor(el, "stroke", errors);
    optionalNumber(el, "strokeWidth", 0, 20, errors);
    optionalNumber(el, "opacity", 0, 1, errors);
    optionalNumber(el, "rotation", -360, 360, errors);

    // Coordinate bounds per type
    const coordKeys = ["cx", "cy", "x", "y", "x1", "y1", "x2", "y2", "rx", "ry", "r", "w", "h"] as const;
    for (const key of coordKeys) {
      if ((el as Record<string, unknown>)[key] !== undefined) {
        optionalNumber(el as Record<string, unknown>, key, -MAX_VISUAL_COORD, MAX_VISUAL_COORD, errors);
      }
    }

    // Text content
    if (el.type === "text") {
      if (typeof el.content !== "string" || el.content.length === 0) {
        errors.push(`elements[${i}].content: required non-empty string for text elements`);
      } else if (el.content.length > MAX_TEXT_CONTENT) {
        errors.push(`elements[${i}].content: max ${MAX_TEXT_CONTENT} chars`);
      }
      optionalNumber(el, "fontSize", 8, 72, errors);
    }

    // Path/polygon points
    if (el.type === "path" || el.type === "polygon") {
      if (!Array.isArray(el.points)) {
        errors.push(`elements[${i}].points: required array for ${el.type}`);
      } else if (el.points.length > MAX_PATH_POINTS) {
        errors.push(`elements[${i}].points: max ${MAX_PATH_POINTS} points`);
      } else {
        for (let j = 0; j < el.points.length; j++) {
          const pt = el.points[j];
          if (!Array.isArray(pt) || pt.length !== 2 || !isFiniteInRange(pt[0], -MAX_VISUAL_COORD, MAX_VISUAL_COORD) || !isFiniteInRange(pt[1], -MAX_VISUAL_COORD, MAX_VISUAL_COORD)) {
            errors.push(`elements[${i}].points[${j}]: must be [x, y] with values in range`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// --- World output validator ---

const WORLD_ELEMENT_TYPES = new Set(["box", "sphere", "cylinder", "torus", "cone", "plane", "ring"]);
const WORLD_MOTION_TYPES = new Set(["float", "spin", "pulse", "none"]);
const MAX_WORLD_ELEMENTS = 50;
const MAX_WORLD_LIGHTS = 5;
const MAX_WORLD_COORD = 100;

// --- Voxel block types ---
export const VOXEL_BLOCK_TYPES = new Set([
  "stone", "brick", "wood", "plank", "glass", "metal",
  "grass", "dirt", "sand", "water", "ice", "lava",
  "concrete", "marble", "obsidian", "glow",
]);
const MAX_VOXELS = 500;
const MAX_VOXEL_Y = 100;

// --- Catalog & generated item limits ---
const MAX_CATALOG_ITEMS = 30;
const MAX_CATALOG_ITEM_NAME = 40;
const MAX_CATALOG_SCALE_MIN = 0.1;
const MAX_CATALOG_SCALE_MAX = 10;
const MAX_GENERATED_ITEMS = 10;
const GENERATED_ITEMS_URL_PREFIX = "/generated-world-objects/";

export function validateWorldOutput(output: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    errors.push("Output must be a JSON object");
    return { valid: false, errors, warnings };
  }

  const raw = JSON.stringify(output);
  if (raw.length > MAX_OUTPUT_JSON_SIZE) {
    errors.push(`Output exceeds ${MAX_OUTPUT_JSON_SIZE} byte limit`);
    return { valid: false, errors, warnings };
  }

  const o = output as Record<string, unknown>;

  // Sky
  optionalColor(o, "sky", errors);

  // Fog
  if (o.fog !== undefined) {
    if (typeof o.fog !== "object" || o.fog === null) {
      errors.push("fog: must be an object");
    } else {
      const f = o.fog as Record<string, unknown>;
      optionalColor(f, "color", errors);
      optionalNumber(f, "near", 0, 500, errors);
      optionalNumber(f, "far", 0, 500, errors);
    }
  }

  // Ground
  if (o.ground !== undefined) {
    if (typeof o.ground !== "object" || o.ground === null) {
      errors.push("ground: must be an object");
    } else {
      const g = o.ground as Record<string, unknown>;
      optionalColor(g, "color", errors);
      optionalColor(g, "emissive", errors);
      optionalNumber(g, "emissiveIntensity", 0, 1, errors);
      optionalNumber(g, "metalness", 0, 1, errors);
      optionalNumber(g, "roughness", 0, 1, errors);
    }
  }

  // Lighting
  if (o.lighting !== undefined) {
    if (typeof o.lighting !== "object" || o.lighting === null) {
      errors.push("lighting: must be an object");
    } else {
      const l = o.lighting as Record<string, unknown>;
      if (l.ambient !== undefined) {
        if (typeof l.ambient !== "object" || l.ambient === null) {
          errors.push("lighting.ambient: must be an object");
        } else {
          const a = l.ambient as Record<string, unknown>;
          optionalColor(a, "color", errors);
          optionalNumber(a, "intensity", 0, 5, errors);
        }
      }
      if (l.points !== undefined) {
        if (!Array.isArray(l.points)) {
          errors.push("lighting.points: must be an array");
        } else if (l.points.length > MAX_WORLD_LIGHTS) {
          errors.push(`lighting.points: max ${MAX_WORLD_LIGHTS} point lights`);
        } else {
          for (let i = 0; i < l.points.length; i++) {
            const p = l.points[i] as Record<string, unknown>;
            if (typeof p !== "object" || p === null) {
              errors.push(`lighting.points[${i}]: must be an object`);
              continue;
            }
            optionalColor(p, "color", errors);
            optionalNumber(p, "intensity", 0, 5, errors);
            if (p.pos !== undefined) {
              if (!Array.isArray(p.pos) || p.pos.length !== 3 || !p.pos.every((v: unknown) => isFiniteInRange(v, -MAX_WORLD_COORD, MAX_WORLD_COORD))) {
                errors.push(`lighting.points[${i}].pos: must be [x, y, z] in range ±${MAX_WORLD_COORD}`);
              }
            }
          }
        }
      }
    }
  }

  // Elements
  if (o.elements !== undefined) {
    if (!Array.isArray(o.elements)) {
      errors.push("elements: must be an array");
    } else if (o.elements.length > MAX_WORLD_ELEMENTS) {
      errors.push(`elements: max ${MAX_WORLD_ELEMENTS} elements`);
    } else {
      for (let i = 0; i < o.elements.length; i++) {
        const el = o.elements[i] as Record<string, unknown>;
        if (typeof el !== "object" || el === null) {
          errors.push(`elements[${i}]: must be an object`);
          continue;
        }
        if (!WORLD_ELEMENT_TYPES.has(el.type as string)) {
          errors.push(`elements[${i}].type: must be one of ${[...WORLD_ELEMENT_TYPES].join(", ")}`);
          continue;
        }

        // Position
        if (el.pos !== undefined) {
          if (!Array.isArray(el.pos) || el.pos.length !== 3 || !el.pos.every((v: unknown) => isFiniteInRange(v, -MAX_WORLD_COORD, MAX_WORLD_COORD))) {
            errors.push(`elements[${i}].pos: must be [x, y, z] in range ±${MAX_WORLD_COORD}`);
          }
        }

        // Rotation
        if (el.rotation !== undefined) {
          if (!Array.isArray(el.rotation) || el.rotation.length !== 3 || !el.rotation.every((v: unknown) => isFiniteInRange(v, -Math.PI * 2, Math.PI * 2))) {
            errors.push(`elements[${i}].rotation: must be [x, y, z] radians`);
          }
        }

        // Scale (number or [x,y,z])
        if (el.scale !== undefined) {
          if (typeof el.scale === "number") {
            if (!isFiniteInRange(el.scale, 0.05, 30)) {
              errors.push(`elements[${i}].scale: must be 0.05–30`);
            }
          } else if (Array.isArray(el.scale)) {
            if (el.scale.length !== 3 || !el.scale.every((v: unknown) => isFiniteInRange(v, 0.05, 30))) {
              errors.push(`elements[${i}].scale: must be [x, y, z] in range 0.05–30`);
            }
          } else {
            errors.push(`elements[${i}].scale: must be a number or [x, y, z]`);
          }
        }

        // Material properties
        optionalColor(el, "color", errors);
        optionalColor(el, "emissive", errors);
        optionalNumber(el, "emissiveIntensity", 0, 1, errors);
        optionalNumber(el, "metalness", 0, 1, errors);
        optionalNumber(el, "roughness", 0, 1, errors);
        optionalNumber(el, "opacity", 0, 1, errors);
        optionalNumber(el, "radius", 0.05, 30, errors);

        // Motion
        if (el.motion !== undefined && !WORLD_MOTION_TYPES.has(el.motion as string)) {
          errors.push(`elements[${i}].motion: must be one of ${[...WORLD_MOTION_TYPES].join(", ")}`);
        }
        optionalNumber(el, "motionSpeed", 0.1, 5, errors);
      }
    }
  }

  // Voxels
  if (o.voxels !== undefined) {
    if (!Array.isArray(o.voxels)) {
      errors.push("voxels: must be an array");
    } else if (o.voxels.length > MAX_VOXELS) {
      errors.push(`voxels: max ${MAX_VOXELS} blocks per agent`);
    } else {
      const seen = new Set<string>();
      for (let i = 0; i < o.voxels.length; i++) {
        const v = o.voxels[i] as Record<string, unknown>;
        if (typeof v !== "object" || v === null) {
          errors.push(`voxels[${i}]: must be an object`);
          continue;
        }
        // Block type
        if (!VOXEL_BLOCK_TYPES.has(v.block as string)) {
          errors.push(`voxels[${i}].block: must be one of ${[...VOXEL_BLOCK_TYPES].join(", ")}`);
          continue;
        }
        // Coordinates must be integers in range
        const x = v.x;
        const y = v.y;
        const z = v.z;
        if (typeof x !== "number" || !Number.isInteger(x) || x < -MAX_WORLD_COORD || x > MAX_WORLD_COORD) {
          errors.push(`voxels[${i}].x: must be an integer in range ±${MAX_WORLD_COORD}`);
          continue;
        }
        if (typeof y !== "number" || !Number.isInteger(y) || y < 0 || y > MAX_VOXEL_Y) {
          errors.push(`voxels[${i}].y: must be an integer 0–${MAX_VOXEL_Y}`);
          continue;
        }
        if (typeof z !== "number" || !Number.isInteger(z) || z < -MAX_WORLD_COORD || z > MAX_WORLD_COORD) {
          errors.push(`voxels[${i}].z: must be an integer in range ±${MAX_WORLD_COORD}`);
          continue;
        }
        // No duplicate positions
        const key = `${x},${y},${z}`;
        if (seen.has(key)) {
          errors.push(`voxels[${i}]: duplicate position ${key}`);
          continue;
        }
        seen.add(key);
      }
    }
  }

  // Catalog items
  if (o.catalog_items !== undefined) {
    if (!Array.isArray(o.catalog_items)) {
      errors.push("catalog_items: must be an array");
    } else if (o.catalog_items.length > MAX_CATALOG_ITEMS) {
      errors.push(`catalog_items: max ${MAX_CATALOG_ITEMS} items per agent`);
    } else {
      for (let i = 0; i < o.catalog_items.length; i++) {
        const item = o.catalog_items[i] as Record<string, unknown>;
        if (typeof item !== "object" || item === null) {
          errors.push(`catalog_items[${i}]: must be an object`);
          continue;
        }
        if (typeof item.item !== "string" || item.item.length === 0 || item.item.length > MAX_CATALOG_ITEM_NAME) {
          errors.push(`catalog_items[${i}].item: must be a non-empty string (max ${MAX_CATALOG_ITEM_NAME} chars)`);
          continue;
        }
        // Position (required)
        if (!Array.isArray(item.pos) || item.pos.length !== 3 || !item.pos.every((v: unknown) => isFiniteInRange(v, -MAX_WORLD_COORD, MAX_WORLD_COORD))) {
          errors.push(`catalog_items[${i}].pos: required [x, y, z] in range ±${MAX_WORLD_COORD}`);
          continue;
        }
        // Rotation
        if (item.rotation !== undefined) {
          if (!Array.isArray(item.rotation) || item.rotation.length !== 3 || !item.rotation.every((v: unknown) => isFiniteInRange(v, -Math.PI * 2, Math.PI * 2))) {
            errors.push(`catalog_items[${i}].rotation: must be [x, y, z] radians`);
          }
        }
        // Scale
        if (item.scale !== undefined) {
          if (!isFiniteInRange(item.scale, MAX_CATALOG_SCALE_MIN, MAX_CATALOG_SCALE_MAX)) {
            errors.push(`catalog_items[${i}].scale: must be ${MAX_CATALOG_SCALE_MIN}–${MAX_CATALOG_SCALE_MAX}`);
          }
        }
      }
    }
  }

  // Generated items (Meshy-generated world objects)
  if (o.generated_items !== undefined) {
    if (!Array.isArray(o.generated_items)) {
      errors.push("generated_items: must be an array");
    } else if (o.generated_items.length > MAX_GENERATED_ITEMS) {
      errors.push(`generated_items: max ${MAX_GENERATED_ITEMS} items per agent`);
    } else {
      for (let i = 0; i < o.generated_items.length; i++) {
        const item = o.generated_items[i] as Record<string, unknown>;
        if (typeof item !== "object" || item === null) {
          errors.push(`generated_items[${i}]: must be an object`);
          continue;
        }
        if (typeof item.url !== "string" || !item.url.startsWith(GENERATED_ITEMS_URL_PREFIX)) {
          errors.push(`generated_items[${i}].url: must start with ${GENERATED_ITEMS_URL_PREFIX}`);
          continue;
        }
        // Position (required)
        if (!Array.isArray(item.pos) || item.pos.length !== 3 || !item.pos.every((v: unknown) => isFiniteInRange(v, -MAX_WORLD_COORD, MAX_WORLD_COORD))) {
          errors.push(`generated_items[${i}].pos: required [x, y, z] in range ±${MAX_WORLD_COORD}`);
          continue;
        }
        // Rotation
        if (item.rotation !== undefined) {
          if (!Array.isArray(item.rotation) || item.rotation.length !== 3 || !item.rotation.every((v: unknown) => isFiniteInRange(v, -Math.PI * 2, Math.PI * 2))) {
            errors.push(`generated_items[${i}].rotation: must be [x, y, z] radians`);
          }
        }
        // Scale
        if (item.scale !== undefined) {
          if (!isFiniteInRange(item.scale, MAX_CATALOG_SCALE_MIN, MAX_CATALOG_SCALE_MAX)) {
            errors.push(`generated_items[${i}].scale: must be ${MAX_CATALOG_SCALE_MIN}–${MAX_CATALOG_SCALE_MAX}`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// --- Game output validator ---

const GAME_TEMPLATES = new Set(["click_target", "memory_match"]);
const MAX_GAME_TITLE = 60;
const MAX_GAME_JSON_SIZE = 4096; // 4KB

export function validateGameOutput(output: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    errors.push("Output must be a JSON object");
    return { valid: false, errors, warnings };
  }

  const raw = JSON.stringify(output);
  if (raw.length > MAX_GAME_JSON_SIZE) {
    errors.push(`Output exceeds ${MAX_GAME_JSON_SIZE} byte limit`);
    return { valid: false, errors, warnings };
  }

  const o = output as Record<string, unknown>;

  // Template
  if (!GAME_TEMPLATES.has(o.template as string)) {
    errors.push(`template: must be one of ${[...GAME_TEMPLATES].join(", ")}`);
    return { valid: false, errors, warnings };
  }

  // Title
  if (o.title !== undefined) {
    if (typeof o.title !== "string") {
      errors.push("title: must be a string");
    } else if (o.title.length > MAX_GAME_TITLE) {
      errors.push(`title: max ${MAX_GAME_TITLE} chars`);
    }
  }

  // Config
  if (typeof o.config !== "object" || o.config === null || Array.isArray(o.config)) {
    errors.push("config: required object");
    return { valid: false, errors, warnings };
  }

  const config = o.config as Record<string, unknown>;

  if (o.template === "click_target") {
    optionalNumber(config, "spawnRate", 0.5, 5, errors);
    optionalNumber(config, "targetSize", 0.3, 3, errors);
    optionalNumber(config, "lifetime", 1, 10, errors);
    optionalNumber(config, "maxTargets", 1, 20, errors);
    optionalNumber(config, "rounds", 1, 20, errors);
    if (config.colors !== undefined) {
      if (!Array.isArray(config.colors) || config.colors.length === 0 || config.colors.length > 6) {
        errors.push("config.colors: must be array of 1–6 hex colors");
      } else {
        for (let i = 0; i < config.colors.length; i++) {
          if (!isValidColor(config.colors[i])) {
            errors.push(`config.colors[${i}]: invalid hex color`);
          }
        }
      }
    }
  } else if (o.template === "memory_match") {
    if (config.gridSize !== undefined) {
      if (!Array.isArray(config.gridSize) || config.gridSize.length !== 2) {
        errors.push("config.gridSize: must be [cols, rows]");
      } else {
        if (!isFiniteInRange(config.gridSize[0], 2, 6) || !isFiniteInRange(config.gridSize[1], 2, 6)) {
          errors.push("config.gridSize: values must be 2–6");
        }
        const total = (config.gridSize[0] as number) * (config.gridSize[1] as number);
        if (total % 2 !== 0) {
          errors.push("config.gridSize: total cells must be even (for pairs)");
        }
      }
    }
    optionalNumber(config, "flipTime", 0.5, 5, errors);
    if (config.colors !== undefined) {
      if (!Array.isArray(config.colors) || config.colors.length === 0 || config.colors.length > 18) {
        errors.push("config.colors: must be array of 1–18 hex colors");
      } else {
        for (let i = 0; i < config.colors.length; i++) {
          if (!isValidColor(config.colors[i])) {
            errors.push(`config.colors[${i}]: invalid hex color`);
          }
        }
      }
    }
    if (config.theme !== undefined) {
      if (!["colors", "shapes", "notes"].includes(config.theme as string)) {
        errors.push("config.theme: must be colors, shapes, or notes");
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
