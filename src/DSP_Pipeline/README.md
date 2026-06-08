# SF4 Real-Time Guitar DSP Pipeline — Firmware

Arduino Uno R3 (ATmega328P) firmware implementing a real-time, **selectable
multi-effect** guitar DSP — **Clean / Overdrive / Delay / Chorus / Reverb** — plus
a **Tuner** mode that detects the played string's pitch, all with a serial command
interface for live parameter control.

Sketch: [`DSP_Pipeline.ino`](DSP_Pipeline.ino)

> **Note:** an earlier version of this firmware (and this README) ran a *cumulative*
> `Clip → Biquad EQ → Delay` pipeline driven by an `S,...` frame at 19230 Hz. That is
> obsolete. The current firmware selects **one** effect at a time and runs the ADC at
> **~9615 Hz**. The host software (`../host/`) targets this current protocol.

---

## Signal path

```
guitar (biased 2.5 V) ─▶ A0 ─▶ ADC (free-running, 10-bit, ~9.615 kHz, prescaler 128)
                                  │
                                  ▼  ISR(ADC_vect)   ← one DSP tick per sample
                    one of: Clean | Overdrive | Delay | Chorus | Reverb
                                  │
                                  ▼
                    OCR1B (8-bit, 62.5 kHz Fast PWM, pin 10)
                                  │
                                  ▼
                    RC reconstruction filter ─▶ analog audio out
```

- **Input**: guitar AC-coupled and biased to 2.5 V on A0; ADC reads 0..1023 (512 = silence).
- **Output**: pin 10 (OC1B), 8-bit Fast PWM, 62.5 kHz carrier, smoothed by an external RC filter.
- **Optocoupler**: pin 9 (OC1A), same Timer1, sets the analog VGA gain via the LED/LDR.
- **Sample rate**: ADC prescaler 128 → ~9615 Hz (Nyquist 4.8 kHz, matching the anti-alias LPF).
  Delay/reverb taps are `t = samples / 9615 Hz`; the 512-sample buffer holds ~53 ms.

---

## Effects

All processing is **fixed-point** (no float in the ISR). Samples are carried as
signed values centred on 0 (range −512..+511). **One effect is active at a time**
(selected with `e`); switching effects clears the audio ring buffer.

| ID | Effect | What it does | Parameters |
|----|--------|--------------|------------|
| 0 | **Clean** | Transparent passthrough | — |
| 1 | **Overdrive** | Pre-amplify then hard-clip | `thresh` 1..511 (drive: 16=breakup, 180=rock, 480=metal) |
| 2 | **Delay** | Single echo with feedback (~53 ms max) | `delayLen` 1..512, `feedback` 0..255, `mix` 0..255 |
| 3 | **Chorus** | Triangle-LFO modulated short delay, 50/50 dry/wet | `depth` 1..48, `rate` 1..20 |
| 4 | **Reverb** | Ten-tap feedback network | `feedback` 0..255 (keep < 205), `mix` 0..255 |
| 5 | **Tuner** | Clean passthrough + fundamental-pitch detection (reported via telemetry) | — |

**Delay/reverb timing**: `t = samples / 9615 Hz`. The 512-sample `int8` line holds ~53 ms.

### Tuner

Selecting **Tuner** (effect 5) passes the signal through clean while detecting the
played string's fundamental frequency and reporting it in the `freq` telemetry
field (deci-Hz; `0` = no pitch). The host UI shows the detected pitch against the
six standard-tuning strings (E2 A2 D3 G3 B3 E4) with a flat↔sharp cents needle.

- **Method**: **AMDF** (Average Magnitude Difference Function) over the audio ring
  buffer, searching lags ~24..128 samples (≈75–400 Hz). The deepest dip is the
  period; **parabolic interpolation** around it recovers sub-sample resolution —
  essential for the high strings, where one whole-sample lag step is tens of cents
  at 9615 Hz. A peak-amplitude gate suppresses readings on silence.
- **Where it runs**: in `loop()` (every ~150 ms), **not** the ISR, and only while
  effect 5 is active — so it costs nothing in the other modes. It works on a frozen
  copy of the most recent samples, since the ISR keeps overwriting the live ring
  during the (tens-of-ms) computation.

---

## Serial command interface

`115200 baud`, one command per line. The parser buffers a full line then parses
it (robust to `\n` / `\r\n` / no line ending).

| Command | Example | Effect |
|---------|---------|--------|
| `e<0..5>` | `e1` | Select effect (0=clean 1=overdrive 2=delay 3=chorus 4=reverb 5=tuner) |
| `c<1..511>` | `c180` | Overdrive drive (thresh) |
| `d<1..512>` | `d400` | Delay length in samples |
| `f<0..255>` | `f190` | Delay/reverb feedback / decay |
| `m<0..255>` | `m220` | Delay/reverb wet mix |
| `r<1..48>` | `r24` | Chorus depth |
| `s<1..20>` | `s8` | Chorus LFO rate |
| `v<0\|1>` | `v1` | Auto-VGA on/off |
| `g<0..255>` | `g15` | Manual VGA gain (OCR1A); turns auto-VGA off |
| `x` | `x` | Bypass (clean passthrough) |
| `P,...` | `P,1,180,400,190,220,24,8,1,-1` | Atomic set-all frame (host link) |

The single-letter commands are for manual testing; the host uses the `P` frame.

> **Note**: a delay/echo is only audible on *transient* material (real guitar,
> plucks, music). On a steady sine it just produces inaudible comb filtering.

## Two-way host protocol (MCU ↔ PC)

Structured parameters in, status telemetry out. The host applies a whole preset
atomically with one `P` frame and reads `T` telemetry back:

```
PC -> MCU : P,<effect>,<drive>,<delayLen>,<feedback>,<mix>,<depth>,<rate>,<autoVGA>,<gain>\n
MCU -> PC : T,<effect>,<peak>,<vga>,<clip>,<rxErr>,<freq>\n      (emitted ~10 Hz)
```

- **`P` frame** — sets the entire parameter bank in one `cli/sei` section (no
  transient old+new mix), clearing the audio buffer on effect change. `gain` field
  `< 0` leaves the VGA untouched and honours the `autoVGA` flag; `>= 0` sets a manual
  gain and turns auto-VGA off. Malformed frames are rejected and counted in `rxErr`.
- **`T` telemetry** — `effect` (active effect ID), `peak` (max |output| since last
  report — a VU meter), `vga` (current `OCR1A`), `clip` (clipped since last report),
  `rxErr` (malformed-frame count), `freq` (detected fundamental in **deci-Hz** —
  Hz×10 — in tuner mode, else `0`).
  > The `freq` field is appended; the host parser accepts both the 6-field
  > (pre-tuner) and 7-field frames, so older firmware still parses.

### Host software

The full interface is the **web app** in [`../host/`](../host/) (FastAPI + LLM tone
engine + browser dashboard). For bench testing without a browser:

```bash
cd ../host && uv sync          # or: pip install -e .
python sf4_serial.py --demo overdrive
python sf4_serial.py --effect reverb --feedback 190 --mix 220
```

It builds a validated `AmpParams`, serialises the `P` frame, sends it, then prints
parsed `T` telemetry as a live meter.

---

## Architecture / timing

- **Timer1** — Mode 5, 8-bit Fast PWM, no prescaler → **62.5 kHz** carrier on
  OC1A (pin 9) and OC1B (pin 10). Pure hardware; **no overflow ISR**.
- **ADC** — free-running, `/64` prescaler → ~**19.23 kHz** sample rate, with the
  conversion-complete interrupt enabled.
- **`ISR(ADC_vect)`** — the single DSP tick: reads `ADC`, runs `processEffect`,
  writes `OCR1B`. Fires once per sample (~19.23 kHz). Reading `ADC` clears `ADIF`
  and the ADC auto-restarts, so no flag handling is needed.
- `OCR1B` is **double-buffered** by the PWM hardware (latches at carrier BOTTOM),
  so updating it at 19.23 kHz while the carrier runs at 62.5 kHz is glitch-free.
- **Parameter bank** — one `volatile Params` struct, updated atomically from
  `loop()` via `snapshotParams()` / `setParams()` (field-wise copies inside
  `cli/sei`, because a `volatile` struct can't use the implicit copy ctor).

---

## Testing & operation notes

### Reading the telemetry (`T,clip,gain,peak,rxErr`)
- **`gain`** — current `OCR1A`; static until you change it.
- **`peak`** — loudest **input** sample in the last 100 ms, in ADC counts
  (0–512 ≈ 0–2.5 V). This is a live VU/level meter; it wobbles ±1 on a steady
  signal (normal). It measures the input *before* the effects, so it can't be
  used to plot the EQ response — use the scope on the output for that.
- **`clip`** — 1 when the signal hit the clip threshold in that window.
- **`rxErr`** — malformed-frame count; should stay 0 (link health).

### Startup transient is expected (and repeats every run)
Opening the serial port toggles **DTR, which hardware-resets the Uno** — so every
`sf4_serial.py` run reboots the board from scratch. At boot `OCR1A = 0`
(LED off → max VGA gain), then the `S` frame sets the gain; the optocoupler LDR
settles slowly (tens–hundreds of ms), so `peak` shows a brief spike that decays
(e.g. `197 → 6`). Harmless — it's the analog gain settling, not a glitch. Ignore
the first few telemetry lines, or add gain smoothing in firmware to remove it.

### What a sine-wave input can test
| Stage | Sine test | Method |
|-------|-----------|--------|
| Passthrough | ✅ | `x`; output = input, biased 2.5 V |
| **EQ** | ✅✅ | sweep frequency, measure **output** amplitude vs theory |
| Clipping | ✅ | drive above threshold → flat-topped wave + odd harmonics |
| Aliasing | ✅ | feed f > Nyquist (9.6 kHz) → watch it fold back |
| Delay comb | ✅ | sweep → notches every `FS/d` Hz |
| Delay *echo* | ❌ | needs transients (real guitar / music) |

### Signal levels (real guitar vs the VGA)
A raw passive guitar is weak and dynamic (~0.1–0.7 Vpp typical, peaks to ~1–1.5 Vpp
on hard strums, decaying fast) — it does **not** sit at line level. The optocoupler
**VGA (gain) is what boosts it** up to where `peak` crosses the clip threshold, so
`gain` (drive) + `clip_threshold` together behave like a pedal's Drive knob. On the
bench, ~1 Vpp from the generator is a *test* level to force clipping. Distortion is
naturally touch-sensitive: loud attack clips, decaying note cleans up.

---

## Changes made in this session

### Implemented
- New `DSP_Pipeline.ino`: full Clip → Biquad EQ → Delay pipeline with fixed-point
  math, parameter bank, RBJ biquad coefficient helper (`setBiquad`), and the
  serial command parser.

### Bugs fixed
1. **`volatile` struct copy** — `Params np = P;` / `P = np;` don't compile for a
   `volatile` struct. Replaced with field-wise `snapshotParams()` / `setParams()`
   inside `cli/sei` (also makes parameter updates atomic, preventing the ISR from
   reading a half-written coefficient).
2. **`Serial.parseInt()` fragility** — leftover `\r`/`\n` were parsed as `0`
   (e.g. `f160` → `feedback = 0`). Replaced with a **line-buffered parser** using
   `atol` / `sscanf`.
3. **Intermittent dropped characters** (`f180` sometimes read as `f18`) —
   diagnosed as **USART RX overrun**: the 62.5 kHz Timer1 ISR delayed the serial
   RX interrupt past a byte time. Worked around by lowering baud to **9600**, then
   fixed structurally (below).

### Architecture change — DSP moved to `ADC_vect`
- The DSP previously ran in `ISR(TIMER1_OVF_vect)` at 62.5 kHz, doing real work
  only ~1 in 3 firings (gated on `ADIF`) — ~⅔ of firings were wasted ISR
  overhead (~40% of CPU).
- Moved the pipeline into **`ISR(ADC_vect)`** (~19.23 kHz), disabled the Timer1
  overflow interrupt (`TIMSK1 = 0`), enabled the ADC interrupt (`ADIE`), and
  removed the now-dead `g_duty` global.
- **Result**: ~43,000 fewer ISR entries per second → frees CPU for serial and
  heavier effects, and permanently fixes the 115200-baud overrun.

### Two-way serial protocol (MCU ↔ PC)
- Added the atomic **`S` set-all frame** parser and the **`T` telemetry** emitter
  (~10 Hz: clip flag, gain, input peak, rxErrors). ISR tracks `g_peak`/`g_clipFlag`;
  `loop()` emits via `millis()`. Line buffer enlarged to 80 B for the `S` frame.
- Added the host translation layer **`src/host/sf4_serial.py`** (pyserial):
  JSON → validated/clamped `S` frame, and `T` frame → parsed live VU meter.
  Verified end-to-end on hardware at 115200 with `rxErr = 0`.

---

## Recommended analog output stage

The PWM output needs an external reconstruction filter + buffer before any
external device. Drives high-impedance line inputs (Echo line-in, Sennheiser
Momentum 4 powered aux) directly — **no power amp needed**.

```
pin 10 ─[2-pole RC LPF: 2.2k / 15nF ×2]─ MCP6002 unity buffer ─ Rs 100Ω ─ Cout 10µF ─┬─ tip L ┐
                                                                                      ├─ tip R ┘ (tie, mono)
                                                                                     R 100k → GND
                                                                                      sleeve → GND
```

- **Use MCP6002** (rail-to-rail, single 5 V), **not** TL072 (needs ≥7 V).
- Because the MCP6002 is only 1 MHz GBW, **filter passively** (RC) and use the
  op-amp only as a buffer — do **not** put it in a Sallen-Key (it would leak the
  62.5 kHz carrier, like the LM358).
- Two RC poles give ~−40 dB at the carrier, removing the switching hash.
- `Cout` strips the 2.5 V DC bias; into a high-Z input the bass is preserved.

---

## Known limitations / potential issues

| Issue | Impact | Possible improvement |
|-------|--------|----------------------|
| Hard-clip aliasing | Harsh "fizzy" distortion (folded harmonics) | Soft-clip lookup table; 2× oversampling |
| 8-bit PWM output | ~48 dB SNR; hiss on clean tones | Higher-res PWM; dithering |
| Single biquad | One EQ band only | Cascade 2–3 biquads |
| Delay ≤ 26.6 ms | Slapback only, no real echo/reverb | `int8` line (≈53 ms) or external SRAM |
| No parameter smoothing | Clicks on live LLM/host changes | Ramp parameters over a few ms |
| Free-running ADC jitter | Minor sample-timing noise | Timer-triggered ADC (needs a free timer) |
| 16 MHz AVR ceiling | Limited DSP headroom overall | Faster MCU for advanced effects |

---

## Status

Working lo-fi multi-effect demonstrator: usable overdrive, tone EQ, and slapback
delay, with live serial control **and a verified two-way MCU↔PC link** (`S`
params in, `T` telemetry out, `rxErr = 0` at 115200). The DSP logic is verified
via host-compiled tests; the host translation layer round-trips on hardware.

### Suggested next steps
- Wire `json_to_frame` / `parse_telemetry` from `sf4_serial.py` into the
  FastAPI backend so the browser/LLM JSON reaches the MCU.
- DSP quality (now that there's CPU headroom): soft-clip LUT, a 2nd cascaded
  biquad, parameter/gain smoothing, `int8` longer delay line.
- Build the MCP6002 analog output stage (above) for clean line-out.
