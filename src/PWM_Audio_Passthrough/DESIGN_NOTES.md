# PWM Audio Passthrough — Design & Debug Notes

A record of the debugging session that took the PWM audio output from "looks like
raw PWM on the scope" to a clean, full-range guitar signal. Covers the filter
diagnosis, the component-value fixes, and the firmware change to a 62.5 kHz carrier.

---

## 1. The system

- **Arduino Uno R3**, guitar signal biased to 2.5 V into **A0** (ADC 0..1023, 512 ≈ silence).
- **Timer1 Fast PWM** drives two independent outputs:
  - **Pin 10 (OC1B)** → audio, through a low-pass filter → audio jack.
  - **Pin 9 (OC1A)** → optocoupler LED (VGA gain stage), set over serial.
- Audio recovered by averaging the PWM (low-pass) then AC-coupling out (high-pass).

Output analog chain (KiCad): `pin 10 → R12 → C7 (low-pass) → LM358 (U2B) → C8 → R13 (high-pass) → AudioJack`.

---

## 2. The symptom

On the PicoScope:
- **Blue (A)** = analog input at A0: a clean sine (300/600/800 Hz test tones), biased at 2.5 V.
- **Red (B)** = "recovered" output: a dense band of pulses, **cycle time 64.00 µs → 15.625 kHz**.

The red trace never looked like the blue sine. The user asked why.

### Why red ≠ blue (the concept)
The raw PWM is a **two-level carrier** (≈0 V or ≈5 V) switching at 15.625 kHz. The
audio is encoded in the **duty cycle / pulse width**, not the instantaneous voltage:

```
blue high (3.5V)  ->  OCR1B large  ->  pulses WIDE  (more time at 5V)
blue low  (2.0V)  ->  OCR1B small  ->  pulses NARROW (more time at 0V)
```

You recover the sine by taking the **running average** of the PWM — which is exactly
what the RC low-pass does. So red ≠ blue *before* the filter is expected and correct.

---

## 3. Root cause #1 — the low-pass filter wasn't filtering

A low-pass needs **both** the series resistor **and** the shunt cap to ground. R12
alone does nothing (the op-amp input is high-impedance, so almost no drop across R12).
C7 is the part that averages the pulses.

The cutoff:

$$f_c = \frac{1}{2\pi R C}$$

The board had **R12 = 1k** and **C7 marked `103` = 10 nF** (NOT the assumed 220 nF):

$$f_c = \frac{1}{2\pi \cdot 1000 \cdot 10\text{n}} \approx 15.9\ \text{kHz}$$

That sits **right on top of the 15.625 kHz carrier** → only −3 dB attenuation → the
carrier passes straight through. Time-constant view: `τ = R12·C7 = 10 µs`, but the
PWM period is `64 µs`, so the cap fully tracks each pulse instead of averaging.

### Capacitor code reminder (value in picofarads)
| Code | Value | Notes |
|------|-------|-------|
| `103` | 10 nF | what was in C7 (wrong — too small) |
| `104` | 100 nF | fc ≈ 1.6 kHz |
| `224` | 220 nF | fc ≈ 723 Hz |

> The user *thought* 220 nF was in C7, but `224` (220 nF) was actually in **C8**
> (the output coupling cap). So C7 = 10 nF (low-pass), C8 = 220 nF (coupling) —
> swapped roles.

### Fix
Put a real **220 nF (`224`)** in C7. With R12 = 1k → fc ≈ 723 Hz, carrier ≈ −27 dB.
The red trace then collapsed into a recognizable sine (with some residual ripple).

---

## 4. Root cause #2 — single RC can't cover guitar range AND reject the carrier

After the 220 nF fix, the recovered sine still had **high-frequency ripple** (residual
15.6 kHz carrier). The fundamental problem:

- **Guitar needs audio out to ~5 kHz** (fundamentals reach ~1.3 kHz; harmonics/tone to ~5–6 kHz).
- **Carrier is at 15.6 kHz** — only **~3× above** the audio top.
- A single-pole RC is just 20 dB/decade. To kill a carrier only 3× away you must drop
  fc so low it also eats the guitar harmonics. **You can't win with a filter alone.**

Single-pole trade-off table (R12 = 1k):

| C7 | Code | fc | Carrier rejection | Audio bandwidth |
|----|------|----|----|----|
| 220 nF | `224` | 723 Hz | −27 dB (~150 mV ripple) | ~720 Hz |
| 470 nF | `474` | 339 Hz | −33 dB | ~340 Hz (too dull) |
| 1 µF | `105` | 159 Hz | −40 dB | bass only ❌ |

---

## 5. The Sallen-Key attempt — and why it made things WORSE

We tried reusing the LM358 (U2B) as a **unity-gain Sallen-Key 2nd-order low-pass**
(Ra=Rb=2.2k, Ca=47 nF, Cb=22 nF). Result: **far worse** — big slew spikes,
channel over-range, and the dominant output frequency measured **~14.3 kHz** (carrier
feeding straight through).

Two reasons:

1. **LM358 is too slow.** ~1 MHz GBW, slew rate ~0.3 V/µs. At 15.6 kHz it has almost
   no loop gain and **slew-limits on the sharp PWM edges** → big spikes.
2. **Sallen-Key has inherent HF feedthrough.** The feedback cap **Ca connects the
   input-side node directly to the output**. At the carrier Ca ≈ 217 Ω (near short),
   so the raw PWM couples *around* the op-amp to the output. Above fc the rejection
   hits a floor instead of improving — and a slow op-amp makes it much worse.

**Lesson: do NOT use a Sallen-Key around the LM358 for this.** Either use a faster
op-amp (TL072 / MCP6002 rail-to-rail), or avoid the topology entirely.

---

## 6. The real fix — move the carrier away from the audio

The only way to have **full guitar bandwidth AND carrier rejection** is to stop
fighting the filter and **raise the PWM carrier** so a gentle filter at ~5 kHz works.

On a 16 MHz Uno, `carrier × resolution = 16 MHz`, so higher carrier = fewer bits:

| Carrier (Timer1 mode) | Resolution | Usable filter fc | Carrier rejection @ 5 kHz | Full guitar? |
|----|----|----|----|----|
| 15.6 kHz (10-bit, original) | 1024 | ~1.5 kHz max | — | ❌ loses harmonics |
| 31.25 kHz (9-bit) | 512 | 5 kHz | ~−32 dB (2nd order) | ✅ |
| **62.5 kHz (8-bit)** | 256 | **5 kHz** | **~−44 dB (2-stage RC)** | ✅✅ |

**Chosen: 8-bit / 62.5 kHz.** 256 levels (≈48 dB SNR) is fine for a guitar effect,
and the carrier is now ~12× above the audio top.

---

## 7. Recommended analog output chain (final)

Use the LM358 as a **plain buffer between two passive RC stages** (passive RC keeps
falling monotonically — no Sallen-Key feedthrough floor):

```
        ── LOW-PASS (sets top, kills carrier) ──    ── HIGH-PASS (sets bottom) ──
PWM ─R1─┬─→(+)LM358 buf─out─R2─┬─→ C8 ──┬──→ jack
        C1                     C2 nodeB  R13
        │                      │         │
       GND                    GND       GND
```

**Low-pass (per stage):**
- R1 = R2 = **2.2 kΩ**, C1 = C2 = **15 nF** (`153`) → fc ≈ 4.8 kHz each
- At 62.5 kHz: ~−22 dB per stage → **~−44 dB total**, monotonic, no spikes
- Passband flat to ~5 kHz → **full guitar tone preserved**
- **Buffer must sit BETWEEN the two stages** so they don't load each other (the
  op-amp's low output impedance isolates the poles).

**High-pass (strips the 2.5 V bias, sets the low end):**
- **C8 = 10 µF** (electrolytic) + R13 = 100 k → fc = 1/(2π·R13·C8) ≈ **0.16 Hz**
- Far below guitar low E (82 Hz) → **no bass loss**, with margin for low-Z loads.
- **Polarity matters:** `+` toward the op-amp side (~2.5 V), `−` toward the jack (0 V).

Resulting passband ≈ **0.16 Hz → 5 kHz** = full guitar range, carrier rejected.

### Capacitor dielectric note
For the filter caps, **film (polypropylene / polyester / polycarbonate)** beats Class II
ceramic (X7R/Y5V): tighter tolerance, no voltage-coefficient capacitance shift, and
lower distortion — so the filter corner stays put and the audio stays clean. (C8 stays
electrolytic for the bulk capacitance; it's outside the signal-shaping path.)

---

## 8. Firmware change (10-bit/15.6 kHz → 8-bit/62.5 kHz)

Edits applied to `PWM_Audio_Passthrough.ino`:

| Item | Before | After |
|------|--------|-------|
| Timer1 mode | Mode 7 (10-bit, `WGM11`+`WGM10`) | Mode 5 (8-bit, `WGM10` only) |
| Carrier | 16 MHz / 1024 = 15.625 kHz | 16 MHz / 256 = **62.5 kHz** |
| Audio scaling | `OCR1B = sample` (0–1023) | `OCR1B = sample >> 2` (0–255) |
| Mid-scale (silence) | `OCR1B = 512` | `OCR1B = 128` |
| Optocoupler range | `constrain(value, 0, 1023)` | `constrain(value, 0, 255)` |
| Serial help text | "0..1023" | "0..255" |

Key register block:

```c
// Timer1: Mode 5 = 8-bit Fast PWM (TOP = 0x00FF) on BOTH OC1A & OC1B
TCCR1A = (1 << COM1A1)   // non-inverting PWM on OC1A (pin 9, optocoupler)
       | (1 << COM1B1)   // non-inverting PWM on OC1B (pin 10, audio)
       | (1 << WGM10);   // WGM[11:10] = 01
TCCR1B = (1 << WGM12)    // WGM12 = 1 -> mode 5 (WGM[13:12] = 01)
       | (1 << CS10);    // no prescale -> 16 MHz / 256 = 62500 Hz

OCR1B  = 128;            // audio: mid-scale (2.5 V = silence)
OCR1A  = 0;             // optocoupler: LED off
```

ISR:

```c
ISR(TIMER1_OVF_vect) {        // fires at 62.5 kHz
  uint16_t sample = ADC;      // 0..1023 (512 = 2.5 V bias)
  // sample = processEffect(sample);   // DSP hook (passthrough for now)
  OCR1B = sample >> 2;        // scale 10-bit ADC -> 8-bit PWM (512 -> 128)
}
```

**Notes:**
- ADC unchanged (free-running 10-bit, ~19 kHz sample rate) — plenty for ~5 kHz audio.
  The PWM refreshes faster than the ADC updates, which is harmless.
- Optocoupler now takes **0–255**, not 0–1023 (update any host scripts).
- Don't use `analogWrite()` — the timer config has been replaced.

---

## 9. Quick reference — diagnostic checklist

If the recovered audio looks like raw PWM again:
1. **Is C7 actually the right value and soldered?** A series R with no shunt cap = no filter.
   Measure C7 with a multimeter on the capacitance range (or scope the op-amp + input).
2. **Decode the cap code:** `103` = 10 nF, `224` = 220 nF, `153` = 15 nF.
3. **Check fc vs carrier:** `fc = 1/(2π R C)` must be well below the carrier.
4. **Don't Sallen-Key the LM358** — passive RC + buffer instead.
5. **Carrier too close to audio?** Raise it in firmware (8-bit/62.5 kHz).
6. **Scope tip:** AC-couple channel B and pick a sensible range to see the ripple
   (the 2.5 V DC bias + spikes will over-range a tight DC window).

---

## 10. Driving the Sennheiser Momentum 4 (line-input mode)

**Connection assumption:** headphones powered **ON**, fed via the 2.5 mm aux cable.
In this mode you drive the headphones' **high-impedance aux/line input** (their own
internal amp drives the speakers). You do **NOT** drive the low-impedance drivers, so
**no headphone power amp is needed** — just deliver a clean, level-controlled,
DC-blocked, mono line signal.

### Design rule
Finish ALL filtering first, then present a **low-impedance, level-controlled output**.
Do not tap the signal from behind a series resistor. The LM358 is a **dual** op-amp, so
use its unused second half (U2A) as the final output buffer — no new chip required.

### Final output stage
```
   ── LP stage 1 ──    ── LP stage 2 ──    ── output buffer ──   ── level + DC block ──
PWM ─R1─┬─→(+)U2B─R2─┬─→(+)U2A──┬─Rout─┬─C8─┬── VR1 top
(pin10) │  (buffer)  │ (buffer) │  +   │    │   wiper ──→ TIP + RING (J6)
       C1        ┌──(−)        (−)─────┘    └── VR1 10k log
        │       C2          (− tied to out)        bottom ── GND
       GND       │           unity gain                          SLEEVE (J6) ── GND
                GND
```

### Component changes from the current single-stage board
| Ref | Now | Change to | Why |
|-----|-----|-----------|-----|
| R1 (was R12) | 1k | **2.2 kΩ** | LP stage 1, fc ≈ 4.8 kHz |
| C1 (was C7) | 10 nF (`103`) | **15 nF (`153`) film** | LP stage 1 |
| R2 | — | **add 2.2 kΩ** | LP stage 2 |
| C2 | — | **add 15 nF (`153`) film** | LP stage 2 |
| U2A | unused | wire as 2nd unity buffer | low-Z output |
| Rout | — | **add 220–470 Ω** | protect op-amp from cable/short |
| C8 | 220 nF | **10 µF electrolytic** | DC block (`+` toward op-amp) |
| VR1 | — | **add 10 kΩ log ("audio taper") pot** | volume / level match (safety!) |
| R13 | 100k | **remove** | the pot now provides C8's DC ground path |

### Critical wiring
1. **Tie TIP and RING together** at the jack. The effect is MONO; the headphones are
   STEREO. Tip-only = sound in one ear. T + R → pot wiper; **S → GND**.
2. **Volume pot:** signal → top, **wiper → jack (T+R)**, bottom → GND.
3. **Common ground** between Arduino GND and the jack sleeve; use shielded cable.

### Why keep the full two-stage filter even though the carrier is inaudible
Active ANC headphones **re-digitize the aux input** (ADC ~48 kHz). A 62.5 kHz carrier
residue would **alias** into the audible band as a whistle/noise. The two-stage filter
(~−44 dB at the carrier) prevents that. Don't drop the second RC stage.

### LM358 note
Output swings ~0 V to ~3.5 V (can't reach +5 V). Biased at 2.5 V, that's ~±1 V clean
swing — plenty for line level. Because the signal never crosses 0 V, the LM358's
crossover distortion is avoided (the one regime where it's acceptable for audio).

### If you ever need PASSIVE (low-impedance driver) drive instead
The LM358 can't do it. Add a current-capable headphone amp (NJM4556, PAM8908, TPA6132)
and a much larger coupling cap (~220–470 µF for 32 Ω, else the bass is gutted).
