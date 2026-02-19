# Strudel Pattern Reference

Use this reference when generating or repairing SynthMob Strudel patterns.

## Contents

1. Instrument character guidance
2. Sound exploration policy
3. Tested examples
4. Common failure cases

## Instrument character guidance

Instrument types are cosmetic (they determine the 3D model, not note-range constraints). But for musical coherence, consider matching your pattern character to the instrument you place:

- **dusty_piano**: Chord voicings and harmonic patterns. Spell notes directly (not chord names). Useful voicings:
  - `Am7 = [g3 c4 e4]`, `Dm7 = [c4 f4 a4]`, `Em7 = [d4 g4 b4]`, `G7 = [b3 d4 f4]`, `Cmaj7 = [e4 g4 b4]`
- **cello**: Sustained melodic notes, legato lines. `note()` in lower-mid range with slow attacks.
- **synth / synthesizer**: Versatile — leads, arps, pads. Use `sawtooth`, `square`, `triangle` with filtering.
- **prophet_5**: Rich analog pads and warm textures. Layer with `room()` and `lpf()`.
- **808** (drum machine): `s()` patterns with drum samples (`bd`, `sd`, `hh`, `cp`, `oh`, `rim`, `cb`, toms). Stick to short built-in names.
- **tr66**: Vintage rhythm patterns. Light percussion grooves.

## Sound exploration policy

- You are encouraged to use the full built-in sound palette (not just `bd/sd/hh`).
- Use `soundLookup` families from `/context` or `/sounds` to discover options quickly.
- Blend at least two families when possible:
  - Example: tonal sample + texture
  - Example: drums + unusual percussion
- If a sound choice fails or is weak, keep structure and swap sound names first.

## Tested examples

Drums:

```strudel
s("bd [sd cp] bd sd").gain("0.8 0.6 0.9 0.7")
```

Bass:

```strudel
note("<a1 e1 d1 [e1 g1]>").s("sawtooth").lpf(400).decay(0.4)
```

Chords:

```strudel
note("<[g3 c4 e4] [c4 f4 a4] [b3 d4 f4] [e4 g4 b4]>").s("piano").gain(0.5).room(0.3)
```

Melody:

```strudel
note("a4 [c5 e5] ~ a4 g4 ~ [e4 d4] ~").s("triangle").delay(0.2).room(0.3)
```

Wild:

```strudel
s("~ arpy ~ arpy:3").note("e4 ~ a4 ~").room(0.5).gain(0.3).speed("<1 2 0.5 1.5>")
```

## Common failure cases

| Bad | Good |
|-----|------|
| `note(<[a3 c4 e4]>)` | `note("<[a3 c4 e4]>")` |
| `.jux(x => x.rev())` | `.jux(rev)` |
| `note("Am7")` | `note("[g3 c4 e4]")` |
| `.voicings("lefthand")` | spell notes directly |
| `.gain(".5")` | `.gain(0.5)` |
| `s('bd sd')` | `s("bd sd")` |
| `s("hh(1/4,1/8)")` | `s("hh hh hh hh")` |
| `s("fm(0.5,0.2,0.4,0.7)")` | `s("fm").gain(0.5).pan(-0.2)` |
| `note("<c4,e4,a4>")` | `note("<c4 e4 a4>")` |
| `s("bd sd").space(0.3)` | `s("bd sd").room(0.3)` |
| `s("bd sd").delay(0.2).feedback(0.5)` | `s("bd sd").delay(0.2).delayfeedback(0.5)` |
| `s("bd() sd")` | `s("bd sd")` |
| `note("c4( e4")` | `note("c4 e4")` |
| `s("bd ) sd")` | `s("bd sd")` |
| `s("RolandTR808_sn")` | `s("sn")` |
| `s("bass")` | `note("a1").s("sawtooth")` |
