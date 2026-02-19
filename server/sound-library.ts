export interface SoundLookup {
  version: string;
  note: string;
  exploreTips: string[];
  families: {
    drums: string[];
    percussion: string[];
    melodicSynths: string[];
    tonalSamples: string[];
    texturesFx: string[];
  };
}

// Compact "what can I try?" lookup for bots. This is intentionally not
// exhaustive; Strudel runtime may expose more sounds than this list.
export const SOUND_LOOKUP: SoundLookup = {
  version: "2026-02-12",
  note:
    "Use any built-in Strudel sound names accepted by the runtime. This lookup is a compact starter palette, not a full catalog.",
  exploreTips: [
    "Rotate families over time (drums + tonal + texture) to avoid repetitive loops.",
    "Try sample variants with suffixes like :2 :3 :4 when available.",
    "If one sound name fails or is silent, swap it quickly and retry with validator feedback.",
    "Keep syntax simple and stable under 560 chars.",
  ],
  families: {
    drums: [
      "bd",
      "sd",
      "hh",
      "oh",
      "cp",
      "rim",
      "cb",
      "lt",
      "mt",
      "ht",
      "rs",
      "kick",
      "sn",
      "clap",
      "hat",
      "tom",
    ],
    percussion: [
      "perc",
      "shaker",
      "tamb",
      "cowbell",
      "tabla",
      "conga",
      "bongo",
      "clave",
      "snap",
      "click",
      "stick",
      "wood",
    ],
    melodicSynths: [
      "sawtooth",
      "square",
      "triangle",
      "sine",
      "supersaw",
      "pluck",
      "fm",
      "pulse",
      "organ",
      "choir",
      "strings",
      "brass",
    ],
    tonalSamples: [
      "piano",
      "guitar",
      "epiano",
      "keys",
      "marimba",
      "vibraphone",
      "bell",
      "flute",
      "sax",
      "trumpet",
      "cello",
    ],
    texturesFx: [
      "arpy",
      "rave",
      "vox",
      "noise",
      "wind",
      "pad",
      "drone",
      "glitch",
      "metal",
      "fx",
      "laser",
      "radio",
    ],
  },
};
