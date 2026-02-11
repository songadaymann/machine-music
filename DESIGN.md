# Multiplayer Browser DAW

## Vision

A collaborative, browser-based music production tool where multiple people (and LLMs) can create music together in real-time. Not a real-time jam tool -- a shared arrangement/production environment. Think "Figma for music production."

The goal is not to replace Ableton or Logic. It's to be the tool where you go from zero to a loop in 30 seconds with a friend. Sketch pad, not studio. Instant load, no install, share a link to join.

---

## Core Features

- **Record sounds** directly in the browser via microphone/line-in
- **Split recordings into samples** -- auto-detect transients or manually chop
- **Drop in samples** from Splice, Freesound, or local files
- **Play MIDI instruments** -- built-in synths, samplers, SoundFont support
- **Make drum loops** -- step sequencer / drum machine grid
- **Arrange and mix** -- timeline, effects, volume/pan/sends
- **Collaborate in real-time** -- multiple people editing the same project simultaneously with live cursors and presence
- **LLM as collaborator** -- AI can read project state and make changes through the same system as human users, compatible with OpenClaw

---

## Core Architectural Insight

This is a **collaborative arrangement tool**, not a real-time audio streaming tool. The distinction is critical:

- Users share **project state**, not audio streams
- Audio files are **shared assets** stored centrally
- Collaboration happens on the **arrangement, MIDI data, mixer settings, effects**
- Each client **renders audio locally** from shared state + shared assets

Real-time audio jamming over the internet requires <10ms latency, which is physically impossible. But collaborative production doesn't need that -- you're editing a shared document that happens to describe music.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     CLIENTS (Browser)                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Human (UI) │  │  Human (UI) │  │ LLM (API)   │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │             │
│    ┌────┴────────────────┴────────────────┴────┐        │
│    │         Yjs CRDT Document (Project)       │        │
│    │  Tempo, tracks, clips, mixer, effects...  │        │
│    └────────────────────┬──────────────────────┘        │
│                         │                               │
├─────────────────────────┼───────────────────────────────┤
│                    WebSocket Sync                        │
├─────────────────────────┼───────────────────────────────┤
│                   SERVER / INFRA                         │
│  ┌──────────────┐  ┌───┴────────┐  ┌────────────────┐  │
│  │ y-websocket  │  │ Asset Store│  │ Auth / Rooms   │  │
│  │ (sync+persist)│  │ (R2 / S3) │  │                │  │
│  └──────────────┘  └────────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Why CRDTs (Yjs)

The project file is a structured document. Yjs gives you:

- **Automatic conflict resolution** -- two people edit different tracks simultaneously with no issues; edits to the same clip merge deterministically
- **Offline support** -- changes queue locally and merge on reconnect
- **Per-user undo/redo** -- Yjs UndoManager tracks each user's changes independently
- **Awareness protocol** -- built-in presence (cursors, selections, who's looking at what)
- **Battle-tested** -- used by Notion, Jupyter, and many production collaborative editors

### Project State Model (CRDT Document)

```
Project (Y.Map)
├── meta: { tempo, timeSignature, key, name }
├── assets: Y.Map<assetId -> { url, name, duration, waveformData }>
├── tracks: Y.Array<Track>
│   └── Track (Y.Map)
│       ├── id, name, type (audio|midi|drum), color
│       ├── mixer: { volume, pan, mute, solo, sends[] }
│       ├── effects: Y.Array<{ type, params }>
│       └── clips: Y.Array<Clip>
│           ├── AudioClip: { assetId, startTime, duration, offset, gain }
│           ├── MIDIClip:  { startTime, duration, notes: Y.Array<Note> }
│           └── DrumClip:  { startTime, steps, pattern: Y.Map<row -> hits> }
├── master: { volume, effects[] }
├── markers: Y.Array<{ time, name, color }>
└── automation: Y.Map<trackId.param -> Y.Array<{time, value}>>
```

---

## Audio Engine

### Design Principle

The audio engine is a **renderer of project state**. When the Yjs document changes (from any source -- local user, remote collaborator, or LLM), the engine reconciles its Web Audio graph to match:

```
CRDT State Change -> Diff -> Audio Graph Update
```

This is React-like thinking applied to audio: state drives rendering.

### Technology

- **Web Audio API** -- AudioContext, AudioWorkletNode for custom DSP
- **AudioWorklet + WASM** -- compile real DSP algorithms (C++, Rust, or FAUST) to WASM, run inside AudioWorklet for effects and synths
- **Tone.js** as a foundation layer -- handles transport/scheduling, has built-in instruments and effects, wraps Web Audio API idiomatically. Build on top of it rather than starting from zero.

### Recording Flow

1. `navigator.mediaDevices.getUserMedia()` -> MediaStream
2. Route through Web Audio API for monitoring (with effects if desired)
3. Capture raw PCM via AudioWorklet (not MediaRecorder -- gives sample-accurate control)
4. On stop: create AudioBuffer -> encode to WAV/FLAC -> upload to asset store -> insert AudioClip in CRDT

### Sample Splitting

- Render waveform to Canvas (or use wavesurfer.js)
- **Auto-split** via transient/onset detection (energy-based or spectral flux algorithm)
- **Manual split** by clicking on waveform
- Each resulting slice becomes a new asset in the project

---

## MIDI & Instruments

### Piano Roll Editor

- Canvas-based grid (DOM is too slow for thousands of note rectangles)
- Snap-to-grid with configurable quantization (1/4, 1/8, 1/16, 1/32, triplets)
- Velocity editing (bar heights below notes)
- Standard DAW piano roll UX -- click to place notes, drag to resize, shift-click to select multiple

### Built-in Instruments

- **Subtractive synth** -- oscillators -> filter -> amp envelope. Classic architecture, straightforward to implement in AudioWorklet/WASM
- **FM synth** -- Tone.js has a solid implementation to start with
- **Sampler** -- load SoundFont (.sf2) files or individual samples, map to MIDI notes. Provides piano, strings, brass, etc.
- **Drum machine** -- see below

### External MIDI

Web MIDI API for external controllers (keyboards, pads, knobs). Well-supported in Chrome/Edge.

---

## Drum Machine

```
┌──────────────────────────────────────────────────────────┐
│  DRUM MACHINE                               BPM: 120    │
│  ┌────┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐│
│  │KICK│X │  │  │X │  │  │X │  │X │  │  │X │  │  │X │  ││
│  │SNAR│  │  │  │  │X │  │  │  │  │  │  │  │X │  │  │  ││
│  │HHAT│X │X │X │X │X │X │X │X │X │X │X │X │X │X │X │X ││
│  │CLAP│  │  │  │  │X │  │  │  │  │  │  │  │X │  │  │X ││
│  │PERC│  │X │  │  │  │  │X │  │  │X │  │  │  │  │X │  ││
│  └────┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┘│
│  [Swing: 55%]  [Steps: 16]  [Play]  [Pattern: A]        │
│                                                          │
│  Drop samples here or browse library...                  │
└──────────────────────────────────────────────────────────┘
```

- Step sequencer grid: each cell is a boolean or velocity value (0-127) in the CRDT
- Configurable step count (16, 32, 64)
- Swing, velocity, and probability per step
- Multiple patterns (A/B/C/D) that can be chained in the arrangement
- Drag-and-drop sample assignment per row
- Two people can edit the same pattern simultaneously -- CRDT handles the merge

---

## LLM Participation & OpenClaw

### Core Concept

An LLM is just another client that reads and writes to the same CRDT document. It doesn't need to "hear" audio -- it operates on the **symbolic representation**: MIDI notes, arrangement structure, effect parameters, drum patterns. This is exactly what LLMs are good at.

### Tool Interface

```typescript
interface DAWTools {
  // Read state
  getProjectState(): ProjectSnapshot
  getTrack(trackId: string): TrackData
  getClipNotes(clipId: string): Note[]

  // Create / modify
  createTrack(type: 'audio' | 'midi' | 'drum', name: string): string
  addMIDIClip(trackId: string, startBeat: number, notes: Note[]): string
  setDrumPattern(trackId: string, pattern: DrumPattern): string
  setEffect(trackId: string, effect: EffectConfig): void
  setMixer(trackId: string, params: MixerParams): void

  // Higher-level / generative
  generateChordProgression(key: string, style: string, bars: number): Note[]
  generateMelody(scale: string, range: NoteRange, rhythmDensity: number): Note[]
  suggestArrangement(sections: string[]): ArrangementMap

  // Sample operations
  listAvailableSamples(query: string): Sample[]
  assignSampleToSlot(sampleId: string, trackId: string, slot: number): void
}
```

### OpenClaw Compatibility

Expose the tool interface in the OpenClaw schema so any compatible LLM can connect as a participant. The LLM's changes flow through Yjs just like human changes -- other users see them appear in real-time and can undo/modify them.

### Example Interactions

- "Add a bass line that follows the chord progression in track 2"
- "Make the drums more syncopated"
- "This section needs a build-up -- add a riser and open the filter"
- "Remix the arrangement: ABAB -> AABA with a bridge"
- LLM watches changes and offers suggestions proactively

---

## UI Layout

```
┌─────────────────────────────────────────────────────┐
│ Transport Bar (play/stop/record/tempo/BPM/key)      │
├──────────┬──────────────────────────────────────────┤
│          │  Timeline / Arrangement View              │
│  Track   │  ┌──────────────────────────────────┐    │
│  Headers │  │ Audio clips, MIDI clips, drum     │    │
│  (name,  │  │ patterns -- drag, resize, move    │    │
│   mute,  │  │                                    │    │
│   solo,  │  │                                    │    │
│   vol)   │  │                                    │    │
│          │  └──────────────────────────────────┘    │
├──────────┴──────────────────────────────────────────┤
│ Bottom Panel (switchable):                           │
│   Piano Roll | Drum Grid | Mixer | Sample Editor    │
├─────────────────────────────────────────────────────┤
│ Collaborators: [Alice] [Bob] [Claude-LLM]           │
└─────────────────────────────────────────────────────┘
```

---

## Technical Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Web Audio latency too high for recording monitoring | Medium | Use minimal buffer sizes (128 samples), offer direct monitoring option |
| Large audio files slow down collaboration | High | Assets stored separately from CRDT doc; lazy-load waveform data; stream audio on demand |
| Browser audio engine can't handle complex projects | Medium | Limit track count initially; use WASM for DSP; bounce/freeze tracks to audio |
| CRDT merge conflicts on simultaneous MIDI note edits | Low | Yjs handles deterministically; last-write-wins at the property level is acceptable for this domain |
| Cross-browser AudioWorklet support | Low | Supported in all modern browsers now including Safari |

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | SvelteKit or Next.js | Svelte has better perf for real-time UI; Next.js has larger ecosystem |
| Audio | Tone.js + custom AudioWorklet | Tone handles transport/scheduling; custom worklets for anything it can't do |
| DSP / WASM | FAUST or Rust -> WASM | FAUST is purpose-built for audio DSP and compiles to WASM; Rust is more flexible |
| Canvas rendering | PixiJS or raw Canvas2D | Timeline, waveforms, piano roll all need fast canvas rendering |
| Collaboration | Yjs + y-websocket | Proven CRDT library with great ecosystem |
| Asset storage | Cloudflare R2 | S3-compatible, no egress fees (audio files get downloaded frequently) |
| Server | Cloudflare Workers or Bun | Workers for edge deployment; Bun for WebSocket server |
| Auth | Simple room codes initially | Share a link to join, like Excalidraw; add user accounts later |

---

## Phased Build Order

### Phase 1 -- Audio Engine + Single-User Shell

Transport, timeline, record audio, play clips, basic waveform display. Prove the audio engine works.

### Phase 2 -- Multiplayer

Yjs integration, WebSocket sync, presence/cursors, shared asset storage. Two people can arrange audio clips together.

### Phase 3 -- MIDI + Instruments

Piano roll, built-in synths, drum machine / step sequencer. The creative toolkit.

### Phase 4 -- LLM Integration

Tool-use API, OpenClaw adapter, LLM as a collaborator that can read state and make changes through the same CRDT system.

### Phase 5 -- Polish + Ecosystem

Sample library browser, advanced effects, automation lanes, export/bounce to audio file, Splice/Freesound integration.

---

## What Makes This Different

Existing browser DAWs (BandLab, Soundtrap) treat collaboration as a bolt-on feature. The result is clunky.

1. **Multiplayer-first architecture** -- not "save and share," but live cursors, live edits, presence from day one
2. **LLM as first-class collaborator** -- no one else is doing this in a DAW context
3. **Speed over features** -- optimized for going from nothing to a loop fast, not for mixing a 48-track session
4. **Modern web UX** -- instant load, no install, share a link to join
