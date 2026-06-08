// Shape + ranges mirror the backend AmpParams (firmware-clamped).

export const PARAM_DEFS = [
  { key: "drive", label: "Drive", min: 1, max: 511 },
  { key: "delay_len", label: "Delay", min: 1, max: 512 },
  { key: "feedback", label: "Feedback", min: 0, max: 255 },
  { key: "mix", label: "Mix", min: 0, max: 255 },
  { key: "depth", label: "Depth", min: 1, max: 48 },
  { key: "rate", label: "Rate", min: 1, max: 20 },
];

export const RELEVANCE = {
  clean: [],
  overdrive: ["drive"],
  delay: ["delay_len", "feedback", "mix"],
  chorus: ["depth", "rate"],
  reverb: ["feedback", "mix"],
  tuner: [],
};

export const EFFECTS = ["clean", "overdrive", "delay", "chorus", "reverb", "tuner"];

export const EFFECT_BLURB = {
  clean: "Transparent passthrough",
  overdrive: "Hard-clip distortion",
  delay: "Echo with feedback",
  chorus: "Modulated shimmer",
  reverb: "Dense feedback wash",
  tuner: "Tune to standard pitch",
};

export const DEFAULTS = {
  effect: "clean",
  drive: 180,
  delay_len: 400,
  feedback: 190,
  mix: 220,
  depth: 24,
  rate: 8,
  auto_vga: true,
  gain: null,
};

// Suggestion chips for the chat — quick tones to tap.
export const SUGGESTIONS = [
  "Warm bluesy overdrive",
  "Spacious ambient reverb",
  "Tight slapback delay",
  "Lush chorus shimmer",
  "Gilmour lead tone",
  "Aggressive metal crunch",
];

// Diff two param objects → the set of changed keys (for highlight pulses).
export function changedKeys(prev, next) {
  const keys = new Set();
  for (const k of ["effect", ...PARAM_DEFS.map((d) => d.key), "auto_vga", "gain"]) {
    if (prev?.[k] !== next?.[k]) keys.add(k);
  }
  return keys;
}
