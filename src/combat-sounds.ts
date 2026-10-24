// The CC0 combat sound set for arpg #67 (67c audio), asset-tooling #297 (docs/combat-sounds.md).
// The recipe names every cue, its clip variants and, per clip, the catalog member(s) it is made from. The build
// (scripts/build-combat-sounds.ts) decodes each member through audio.decode@1 (FFmpeg) to 44.1 kHz mono, layers
// multi-part clips with audio.mix@1, then trims, fades and normalises with the deterministic PCM operations. The
// frame arithmetic for trimming and gain lives here, as pure integer functions, so tests can check it without
// FFmpeg or hydrated sources.

/** Every clip is mono, 16-bit PCM WAV at this rate. */
export const COMBAT_SOUND_SAMPLE_RATE = 44_100;
/** Normalised peak: round(32767 × 10^(−3/20)), about −3 dBFS. */
export const COMBAT_SOUND_PEAK_TARGET = 23_197;
/** Gain is applied as numerator / 10000 (audio.gain@1 caps the denominator at 10000). */
export const COMBAT_SOUND_GAIN_DENOMINATOR = 10_000;
/** Onset: the first sample at or above peak / 32 (about −30 dB below the peak). */
export const ONSET_DIVISOR = 32;
/** Tail: the last sample at or above peak / 256 (about −48 dB below the peak). */
export const TAIL_DIVISOR = 256;
/** Kept before the onset, so the transient starts within 5 ms of the clip start. */
export const PREROLL_MS = 2;
/** Kept after the last audible sample. */
export const TAIL_PAD_MS = 10;
/** Click-free edges: a 1 ms fade-in, and a 5 ms fade-out, or 30 ms when the clip is cut at its cue's maximum. */
export const FADE_IN_MS = 1;
export const FADE_OUT_MS = 5;
export const CUT_FADE_OUT_MS = 30;

export type Archive = {
  id: string; provider: "kenney" | "opengameart"; title: string; url: string; upstreamId: string; revision: string; path: string;
  evidenceUrl: string; author: string; tags: string[]; licenseNote?: string;
};
/** A catalog source a clip is made from: a member of an archive, or (archive undefined) a single file source. */
export type ClipSource = { id: string; archive?: string; path: string; mediaType: "audio/ogg" | "audio/wav"; title: string };
/** One input of a clip: a source placed at `offsetMs`, scaled by gain[0] / gain[1] before mixing. */
export type Layer = { source: string; offsetMs?: number; gain?: [number, number] };
export type Clip = { id: string; layers: Layer[] };
export type Bus = "effects" | "ui";
export type Cue = {
  /** Cue kind as game-audio's `CueSpec.kind`; arpg 67c maps its 67a cue events onto these. */
  kind: string; tag: string; event: string; sound: string; bus: Bus; spatial: boolean;
  priority: number; maxVoices: number; cooldownMs: number; pitchJitter: number;
  /** Playback gain relative to the normalised clip (every clip peaks at about −3 dBFS). */
  gainDb: number;
  /** Target duration range from #297; clips are cut (with a fade) at the maximum. */
  durationMs: [number, number];
  clips: Clip[];
};

const KENNEY_AUTHOR = "Kenney (www.kenney.nl)";
export const COMBAT_SOUND_ARCHIVES: readonly Archive[] = [
  {
    id: "kenney.impact-sounds", provider: "kenney", title: "Impact Sounds", author: KENNEY_AUTHOR, revision: "1.0",
    url: "https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip",
    upstreamId: "impact-sounds", path: "kenney_impact-sounds.zip", evidenceUrl: "https://kenney.nl/assets/impact-sounds",
    tags: ["audio", "game", "impact", "sfx"],
  },
  {
    id: "kenney.interface-sounds", provider: "kenney", title: "Interface Sounds", author: KENNEY_AUTHOR, revision: "1.0",
    url: "https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip",
    upstreamId: "interface-sounds", path: "kenney_interface-sounds.zip", evidenceUrl: "https://kenney.nl/assets/interface-sounds",
    tags: ["audio", "game", "sfx", "ui"],
  },
  {
    id: "kenney.rpg-audio", provider: "kenney", title: "RPG Audio", author: KENNEY_AUTHOR, revision: "1.0",
    url: "https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip",
    upstreamId: "rpg-audio", path: "kenney_rpg-audio.zip", evidenceUrl: "https://kenney.nl/assets/rpg-audio",
    tags: ["audio", "game", "rpg", "sfx"],
  },
  {
    id: "kenney.music-jingles", provider: "kenney", title: "Music Jingles", author: KENNEY_AUTHOR, revision: "1.0",
    url: "https://kenney.nl/media/pages/assets/music-jingles/f37e530b9e-1677590399/kenney_music-jingles.zip",
    upstreamId: "music-jingles", path: "kenney_music-jingles.zip", evidenceUrl: "https://kenney.nl/assets/music-jingles",
    tags: ["audio", "game", "jingle", "sfx"],
  },
  {
    id: "opengameart.rpg-sound-pack", provider: "opengameart", title: "RPG Sound Pack", author: "artisticdude", revision: "2012-02-06",
    url: "https://opengameart.org/sites/default/files/rpg_sound_pack.zip",
    upstreamId: "rpg-sound-pack", path: "rpg_sound_pack.zip", evidenceUrl: "https://opengameart.org/content/rpg-sound-pack",
    tags: ["audio", "game", "rpg", "sfx"],
  },
  {
    id: "opengameart.battle-sound-effects", provider: "opengameart", title: "Battle Sound Effects", author: "Ogrebane", revision: "2012-04-08",
    url: "https://opengameart.org/sites/default/files/battle_sound_effects_0.zip",
    upstreamId: "battle-sound-effects", path: "battle_sound_effects_0.zip", evidenceUrl: "https://opengameart.org/content/battle-sound-effects",
    tags: ["audio", "battle", "game", "sfx"],
    licenseNote: "Offered under CC0, CC-BY 3.0, CC-BY-SA 3.0, GPL 2.0 and GPL 3.0; used under the CC0 option.",
  },
];

/** The one single-file source (no archive). */
export const COMBAT_SOUND_FILES: readonly (Archive & { mediaType: "audio/ogg" })[] = [
  {
    id: "opengameart.their-coming-horn-ogg", provider: "opengameart", title: "Their Coming (generic horn sound)", author: "StumpyStrust",
    revision: "2014-10-10", url: "https://opengameart.org/sites/default/files/theircoming.ogg", upstreamId: "their-coming-generic-horn-sound",
    path: "theircoming.ogg", evidenceUrl: "https://opengameart.org/content/their-coming-generic-horn-sound", mediaType: "audio/ogg",
    tags: ["audio", "game", "horn", "sfx", "stinger"],
  },
];

const kebab = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase();
const member = (archive: string, path: string, title: string): ClipSource => {
  const base = path.split("/").pop()!, dot = base.lastIndexOf(".");
  const extension = base.slice(dot + 1).toLowerCase() as "ogg" | "wav";
  return { id: `${archive}.${kebab(base.slice(0, dot))}-${extension}`, archive, path, title, mediaType: extension === "ogg" ? "audio/ogg" : "audio/wav" };
};
const impact = (name: string) => member("kenney.impact-sounds", `Audio/${name}.ogg`, `Impact Sounds — ${name}`);
const ui = (name: string) => member("kenney.interface-sounds", `Audio/${name}.ogg`, `Interface Sounds — ${name}`);
const rpg = (name: string) => member("kenney.rpg-audio", `Audio/${name}.ogg`, `RPG Audio — ${name}`);
const jingle = (folder: string, name: string) => member("kenney.music-jingles", `Audio/${folder}/${name}.ogg`, `Music Jingles — ${name}`);
const artisticdude = (folder: string, name: string) => member("opengameart.rpg-sound-pack", `RPG Sound Pack/${folder}/${name}.wav`, `RPG Sound Pack — ${name}`);
const ogrebane = (name: string) => member("opengameart.battle-sound-effects", `battle_sound_effects/${name}.wav`, `Battle Sound Effects — ${name}`);
const HORN: ClipSource = { id: "opengameart.their-coming-horn-ogg", path: "theircoming.ogg", mediaType: "audio/ogg", title: "Their Coming (generic horn sound)" };

const S = {
  swing: artisticdude("battle", "swing"), swing2: artisticdude("battle", "swing2"), swing3: artisticdude("battle", "swing3"),
  swish2: ogrebane("swish_2"), bow: ogrebane("Bow"),
  punchMedium0: impact("impactPunch_medium_000"), punchMedium1: impact("impactPunch_medium_001"), punchMedium2: impact("impactPunch_medium_002"),
  punchHeavy0: impact("impactPunch_heavy_000"), punchHeavy1: impact("impactPunch_heavy_001"), punchHeavy2: impact("impactPunch_heavy_002"),
  softHeavy0: impact("impactSoft_heavy_000"), softHeavy1: impact("impactSoft_heavy_001"), softHeavy2: impact("impactSoft_heavy_002"),
  softMedium0: impact("impactSoft_medium_000"), softMedium1: impact("impactSoft_medium_001"), softMedium2: impact("impactSoft_medium_002"),
  metalMedium0: impact("impactMetal_medium_000"), metalMedium1: impact("impactMetal_medium_001"), metalMedium3: impact("impactMetal_medium_003"),
  metalHeavy0: impact("impactMetal_heavy_000"), metalHeavy1: impact("impactMetal_heavy_001"), metalHeavy3: impact("impactMetal_heavy_003"),
  metalLight1: impact("impactMetal_light_001"),
  woodHeavy0: impact("impactWood_heavy_000"), woodHeavy1: impact("impactWood_heavy_001"),
  woodMedium0: impact("impactWood_medium_000"), woodLight0: impact("impactWood_light_000"),
  mining0: impact("impactMining_000"), mining1: impact("impactMining_001"),
  coin: artisticdude("inventory", "coin"), coin3: artisticdude("inventory", "coin3"),
  creak1: rpg("creak1"),
  error8: ui("error_008"), glass1: ui("glass_001"), click1: ui("click_001"), confirm1: ui("confirmation_001"), back1: ui("back_001"),
  sax1: jingle("Sax jingles", "jingles_SAX01"), steel2: jingle("Steel jingles", "jingles_STEEL02"),
  horn: HORN,
} satisfies Record<string, ClipSource>;

export const COMBAT_SOUND_SOURCES: readonly ClipSource[] = Object.values(S);

const one = (id: string, source: ClipSource): Clip => ({ id, layers: [{ source: source.id }] });
const effects = { bus: "effects" as const, spatial: true };

export const COMBAT_SOUND_CUES: readonly Cue[] = ([
  {
    kind: "combat.swing", event: "melee active phase starts (sword / heavy)", sound: "sword swing / whoosh", ...effects,
    priority: 50, maxVoices: 4, cooldownMs: 40, pitchJitter: 0.06, durationMs: [150, 350],
    clips: [one("combat.swing.1", S.swing), one("combat.swing.2", S.swing2), one("combat.swing.3", S.swing3)],
  },
  {
    kind: "combat.hit", event: "hit", sound: "blade-on-flesh / leather impact", ...effects,
    priority: 80, maxVoices: 4, cooldownMs: 30, pitchJitter: 0.05, durationMs: [100, 300],
    clips: [one("combat.hit.1", S.punchMedium0), one("combat.hit.2", S.punchMedium1), one("combat.hit.3", S.punchMedium2)],
  },
  {
    kind: "combat.hit.defeated", event: "hit with defeated (monster)", sound: "heavier impact + body fall", ...effects,
    priority: 85, maxVoices: 3, cooldownMs: 0, pitchJitter: 0.04, durationMs: [400, 800],
    clips: [
      { id: "combat.hit.defeated.1", layers: [{ source: S.punchHeavy0.id }, { source: S.softHeavy0.id, offsetMs: 160, gain: [3, 4] }] },
      { id: "combat.hit.defeated.2", layers: [{ source: S.punchHeavy1.id }, { source: S.softHeavy2.id, offsetMs: 140, gain: [3, 4] }] },
    ],
  },
  {
    kind: "combat.blocked", event: "blocked", sound: "sword on shield clank", ...effects,
    priority: 75, maxVoices: 4, cooldownMs: 30, pitchJitter: 0.05, durationMs: [100, 300],
    clips: [one("combat.blocked.1", S.metalMedium0), one("combat.blocked.2", S.metalMedium1), one("combat.blocked.3", S.metalMedium3)],
  },
  {
    kind: "combat.guardBroken", event: "guardBroken", sound: "shield crack / heavy clang", ...effects,
    priority: 90, maxVoices: 2, cooldownMs: 0, pitchJitter: 0.03, durationMs: [300, 600],
    clips: [
      { id: "combat.guard-broken.1", layers: [{ source: S.metalHeavy1.id }, { source: S.woodHeavy0.id, offsetMs: 20, gain: [4, 5] }] },
      { id: "combat.guard-broken.2", layers: [{ source: S.metalHeavy3.id }, { source: S.woodHeavy1.id, offsetMs: 20, gain: [4, 5] }] },
    ],
  },
  {
    kind: "combat.obstructed", event: "obstructed", sound: "blade on stone", ...effects,
    priority: 60, maxVoices: 2, cooldownMs: 40, pitchJitter: 0.05, durationMs: [100, 250],
    clips: [one("combat.obstructed.1", S.mining0), one("combat.obstructed.2", S.mining1)],
  },
  {
    kind: "combat.whiff", event: "whiff (optional; the swing covers it)", sound: "lighter whoosh", ...effects,
    priority: 30, maxVoices: 2, cooldownMs: 60, pitchJitter: 0.08, durationMs: [150, 350],
    gainDb: -6, clips: [one("combat.whiff.1", S.swish2)],
  },
  {
    kind: "combat.hurt", event: "hit on the player", sound: "non-verbal body / armour impact", ...effects,
    priority: 95, maxVoices: 2, cooldownMs: 60, pitchJitter: 0.05, durationMs: [150, 400],
    clips: [one("combat.hurt.1", S.softMedium0), one("combat.hurt.2", S.softMedium1), one("combat.hurt.3", S.softMedium2)],
  },
  {
    kind: "combat.defeat", event: "defeat (player)", sound: "low thud + falling sting", bus: "effects", spatial: false,
    priority: 100, maxVoices: 1, cooldownMs: 0, pitchJitter: 0, durationMs: [600, 1200],
    clips: [{ id: "combat.defeat.1", layers: [{ source: S.softHeavy1.id }, { source: S.sax1.id, offsetMs: 120, gain: [3, 5] }] }],
  },
  {
    kind: "combat.arrowRelease", event: "arrowRelease", sound: "bowstring twang", ...effects,
    priority: 55, maxVoices: 3, cooldownMs: 30, pitchJitter: 0.06, durationMs: [150, 350],
    clips: [one("combat.arrow-release.1", S.bow)],
  },
  {
    kind: "combat.arrowLanded", event: "arrowLanded (world)", sound: "arrow thunk into wood / ground", ...effects,
    priority: 45, maxVoices: 3, cooldownMs: 30, pitchJitter: 0.06, durationMs: [100, 300],
    clips: [one("combat.arrow-landed.1", S.woodMedium0), one("combat.arrow-landed.2", S.woodLight0)],
  },
  {
    kind: "combat.arrowBlocked", event: "blocked from an arrow", sound: "arrow on shield tick", ...effects,
    priority: 70, maxVoices: 3, cooldownMs: 30, pitchJitter: 0.05, durationMs: [100, 200],
    gainDb: -3, clips: [one("combat.arrow-blocked.1", S.metalLight1)],
  },
  {
    kind: "combat.counterOpen", event: "counterOpen", sound: "short bright opportunity ping", bus: "effects", spatial: false,
    priority: 90, maxVoices: 1, cooldownMs: 100, pitchJitter: 0, durationMs: [150, 300],
    clips: [one("combat.counter-open.1", S.glass1)],
  },
  {
    kind: "combat.counterUsed", event: "counterUsed", sound: "crisp heavy impact", ...effects,
    priority: 90, maxVoices: 2, cooldownMs: 0, pitchJitter: 0.03, durationMs: [200, 400],
    clips: [{ id: "combat.counter-used.1", layers: [{ source: S.punchHeavy2.id }, { source: S.metalHeavy0.id, gain: [3, 5] }] }],
  },
  {
    kind: "world.pickedUp.gold", event: "pickedUp (gold)", sound: "coin pickup jingle", ...effects,
    priority: 60, maxVoices: 2, cooldownMs: 50, pitchJitter: 0.05, durationMs: [200, 500],
    clips: [one("world.picked-up-gold.1", S.coin3), one("world.picked-up-gold.2", S.coin)],
  },
  {
    kind: "world.opened", event: "opened (crate / chest)", sound: "wooden chest open", ...effects,
    priority: 60, maxVoices: 2, cooldownMs: 100, pitchJitter: 0.04, durationMs: [300, 800],
    clips: [one("world.opened.1", S.creak1)],
  },
  {
    kind: "world.refused", event: "refused interaction", sound: "soft UI deny", bus: "ui", spatial: false,
    priority: 40, maxVoices: 1, cooldownMs: 150, pitchJitter: 0, durationMs: [100, 200],
    gainDb: -6, clips: [one("world.refused.1", S.error8)],
  },
  {
    kind: "encounter.start", event: "encounter start", sound: "low horn stinger", bus: "effects", spatial: false,
    priority: 100, maxVoices: 1, cooldownMs: 500, pitchJitter: 0, durationMs: [800, 1500],
    clips: [one("encounter.start.1", S.horn)],
  },
  {
    kind: "encounter.clear", event: "encounter clear", sound: "short resolve chime", bus: "effects", spatial: false,
    priority: 100, maxVoices: 1, cooldownMs: 500, pitchJitter: 0, durationMs: [800, 1500],
    clips: [one("encounter.clear.1", S.steel2)],
  },
  {
    kind: "ui.click", event: "UI click", sound: "interface click", bus: "ui", spatial: false, gainDb: -6,
    priority: 20, maxVoices: 2, cooldownMs: 20, pitchJitter: 0, durationMs: [50, 200],
    clips: [one("ui.click.1", S.click1)],
  },
  {
    kind: "ui.confirm", event: "UI confirm", sound: "interface confirm", bus: "ui", spatial: false, gainDb: -6,
    // 300 ms rather than #297's 200 ms: the two-note confirmation chime would otherwise be cut mid-note.
    priority: 20, maxVoices: 2, cooldownMs: 20, pitchJitter: 0, durationMs: [50, 300],
    clips: [one("ui.confirm.1", S.confirm1)],
  },
  {
    kind: "ui.back", event: "UI back", sound: "interface cancel", bus: "ui", spatial: false, gainDb: -6,
    priority: 20, maxVoices: 2, cooldownMs: 20, pitchJitter: 0, durationMs: [50, 200],
    clips: [one("ui.back.1", S.back1)],
  },
] satisfies (Omit<Cue, "tag" | "gainDb"> & { gainDb?: number })[]).map((cue) => ({ gainDb: 0, ...cue, tag: `sfx.${kebab(cue.kind)}` }));

/** Purpose tags per catalog source, from every cue that uses it. */
export function combatSoundSourceTags(): Map<string, string[]> {
  const tags = new Map<string, Set<string>>();
  for (const cue of COMBAT_SOUND_CUES) for (const clip of cue.clips) for (const layer of clip.layers) {
    (tags.get(layer.source) ?? tags.set(layer.source, new Set()).get(layer.source)!).add(cue.tag);
  }
  return new Map([...tags].map(([id, set]) => [id, [...set].sort()]));
}

export const msToFrames = (ms: number, sampleRate = COMBAT_SOUND_SAMPLE_RATE) => Math.round((ms * sampleRate) / 1000);

export function peakOf(samples: Int16Array): number {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

/**
 * The trim window of a mono clip: from PREROLL_MS before the onset to TAIL_PAD_MS after the last sample above the
 * tail threshold, cut at `maxMs`. `cut` says whether the cue maximum ended the clip before its natural tail.
 */
export function trimWindow(samples: Int16Array, maxMs: number, sampleRate = COMBAT_SOUND_SAMPLE_RATE) {
  const peak = peakOf(samples);
  if (peak === 0) throw new Error("clip is silent");
  const onsetLevel = Math.max(1, Math.ceil(peak / ONSET_DIVISOR)), tailLevel = Math.max(1, Math.ceil(peak / TAIL_DIVISOR));
  let onset = 0;
  while (Math.abs(samples[onset]!) < onsetLevel) onset += 1;
  let last = samples.length - 1;
  while (Math.abs(samples[last]!) < tailLevel) last -= 1;
  const startFrame = Math.max(0, onset - msToFrames(PREROLL_MS, sampleRate));
  const naturalEnd = Math.min(samples.length, last + 1 + msToFrames(TAIL_PAD_MS, sampleRate));
  const maxEnd = startFrame + msToFrames(maxMs, sampleRate);
  const cut = naturalEnd > maxEnd;
  return { startFrame, endFrame: cut ? maxEnd : naturalEnd, onsetFrame: onset, cut };
}

/** Fade lengths for a trimmed clip of `frames` frames. */
export function fadeFrames(frames: number, cut: boolean, sampleRate = COMBAT_SOUND_SAMPLE_RATE) {
  const fadeOutFrames = Math.min(Math.floor(frames / 2), msToFrames(cut ? CUT_FADE_OUT_MS : FADE_OUT_MS, sampleRate));
  return { fadeInFrames: Math.min(msToFrames(FADE_IN_MS, sampleRate), frames - fadeOutFrames), fadeOutFrames };
}

/** The rational audio.gain@1 parameters that bring `peak` to COMBAT_SOUND_PEAK_TARGET. */
export function normaliseGain(peak: number) {
  const numerator = Math.round((COMBAT_SOUND_PEAK_TARGET * COMBAT_SOUND_GAIN_DENOMINATOR) / peak);
  if (numerator > 160_000) throw new Error(`clip peak ${peak} is too quiet to normalise within audio.gain@1's range`);
  return { numerator, denominator: COMBAT_SOUND_GAIN_DENOMINATOR };
}

const round2 = (value: number) => Math.round(value * 100) / 100;
/** Peak and RMS level in dBFS (full scale 32768), rounded to 0.01 dB. RMS is unweighted, not LUFS. */
export function loudness(samples: Int16Array) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  return { peakDbfs: round2(20 * Math.log10(peakOf(samples) / 32768)), rmsDbfs: round2(20 * Math.log10(rms / 32768)) };
}
