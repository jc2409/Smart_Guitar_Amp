# Smart Guitar Amp

[![Smart Guitar Amp Demo](https://img.youtube.com/vi/zBXpkTaCWV4/0.jpg)](https://www.youtube.com/watch?v=zBXpkTaCWV4)

A hybrid guitar-effect amplifier combining a hand-built analog signal chain, real-time
Arduino DSP firmware, and a browser-based control app. A player can dial in sounds
manually or describe a tone in natural language; the host translates that request into
validated firmware parameters and sends them to the board over USB serial.

Three working layers:

1. Analog hardware for guitar-level signal conditioning, optical gain control, ADC
   input conditioning, and PWM audio reconstruction.
2. Arduino firmware for real-time DSP, automatic gain control, serial commands, and
   telemetry.
3. A FastAPI + React web app with sliders, live telemetry, tuner display, OpenAI chat,
   and Whisper-based voice input.

The host falls back to a mock serial link when no board is connected, so the web app
and LLM/voice flow can be demonstrated without hardware.

## System Overview

```text
Guitar
  -> analog input buffer and 2.5 V bias
  -> optically controlled analog gain stage (VGA)
  -> 2nd-order Sallen-Key anti-aliasing LPF (fc = 7.2 kHz)
  -> Arduino A0 ADC (10-bit, 9615 Hz, free-running)
  -> ATmega328P DSP firmware (fixed-point, ISR-driven)
  -> 8-bit Fast PWM on pin 10 at 62.5 kHz
  -> two-stage RC reconstruction filter with op-amp buffer
  -> line / aux / high-impedance headphone output

Browser UI
  -> FastAPI host
  -> serial P frames to Arduino
  <- T telemetry frames from Arduino (~10 Hz)
  -> OpenAI chat and Whisper STT when enabled
```

The amp runs DSP on the bare-metal MCU; the browser, FastAPI host, and LLM steer
it over serial — without ever touching the real-time audio loop.

## Analog Signal Chain

The analog path runs entirely on a single 5 V rail. All audio rides a 2.5 V virtual
ground so the ATmega328P ADC sees a full bipolar swing without needing a split supply.

**Input stage — high-Z buffer and 2.5 V bias**

- R1 (10 kΩ) series input resistor gives a high-impedance front end (~MΩ with the
  op-amp) that will not load passive pickups.
- C1 (10 μF) AC-coupling cap blocks the guitar's DC, passing only the audio swing.
- A 2.5 V virtual-ground reference buffered by an LM358/MCP6002 (rail-to-rail,
  single-supply) centres the waveform for the ADC.

**Optocoupler VGA — silent analog gain control**

- The firmware drives an optocoupler LED from Timer1 PWM on pin 9 / OC1A.
- Light couples to an LDR (100 Ω–100 kΩ range), changing the analog gain without
  injecting any digital switching edges into the audio path.
- DC-free and click-free: resistance glides smoothly with no zipper noise or DC offset
  injection. Higher OCR1A = brighter LED = lower LDR resistance = lower gain.
- In automatic mode the firmware rides the VGA gently based on measured output peak:
  peak > 380 steps gain down, 8–40 steps gain up, < 8 (noise floor) never boosts,
  and silence drifts back to the resting value. One step per 15 ms gives a smooth
  ride with no pumping.

**Anti-alias filter and ADC**

- A 2nd-order Sallen-Key LPF (R = 10 kΩ, C = 2.2 nF, fc = 7.2 kHz) guards the ADC
  input. 7.2 kHz is well above the guitar's highest audible harmonic, so nothing
  musical is lost while aliasing is suppressed.
- ADC A0 runs free-running, prescaler 128 → ~9615 Hz sample rate (Nyquist 4.8 kHz).
- Prescaler 128 was chosen over 64: slower sampling doubles the 512-sample ring
  buffer's span to ~53 ms, maximising delay and reverb range, while 4.8 kHz Nyquist
  still covers the full guitar band.

**PWM audio output and reconstruction**

- Timer1 Mode 5 (8-bit Fast PWM, no prescaler) drives pin 10 / OC1B at 62.5 kHz.
- A two-stage passive RC chain (2.2 kΩ + 15 nF per pole) with an op-amp buffer between
  the stages attenuates the 62.5 kHz carrier by ~−44 dB while the guitar passband
  passes flat.
- The buffer-between-poles topology avoids the carrier feedthrough and slew-rate
  problems seen with a slow op-amp Sallen-Key stage.
- A 10 μF output coupling cap removes the 2.5 V DC bias; the HPF corner is ≈ 0.16 Hz,
  preserving full bass response. The output targets high-impedance line/aux inputs.
- 62.5 kHz was chosen so the carrier sits far above audio: a gentle two-pole passive
  RC can reject it fully. Trade-off: 10-bit→8-bit resolution (256 levels, ~48 dB SNR),
  which is adequate for guitar effects.

The PWM output-stage debugging and component choices are documented in
[src/PWM_Audio_Passthrough/DESIGN_NOTES.md](src/PWM_Audio_Passthrough/DESIGN_NOTES.md).

## Firmware

The current firmware is [src/DSP_Pipeline/DSP_Pipeline.ino](src/DSP_Pipeline/DSP_Pipeline.ino).
It targets an Arduino Uno R3 / ATmega328P.

**Real-time architecture**

Audio processing runs entirely in `ISR(ADC_vect)` — one DSP tick per sample at 9615 Hz
(~52 μs budget per sample). The ISR reads A0, subtracts the 2.5 V bias, runs one effect,
clips to ±511, shifts to 8-bit, and writes OCR1B. No float is used; every operation is
integer shifts and adds. Timer1's PWM hardware double-buffers OCR1B, so the 9615 Hz
ISR writes are glitch-free against the 62.5 kHz carrier.

Parameters are written by `loop()` atomically in a `cli/sei` block so the ISR never
reads a half-written parameter set. The 512-byte `int8_t` ring buffer holds ~53 ms
of history shared by delay, chorus, reverb, and tuner.

**Effects**

The firmware runs exactly one effect mode at a time:

| ID | Effect | Implemented behavior |
| --- | --- | --- |
| `0` | Clean | Transparent passthrough. |
| `1` | Overdrive | `driven = (x * drive) >> 4`, hard-clipped to ±511. `drive` 16 = edge of breakup, 180 = rock crunch, 480 = near square-wave metal. |
| `2` | Delay | One read-tap `delayLen` samples behind the write head; `feedback` regenerates the tail. Up to 512 samples (~53 ms slapback). |
| `3` | Chorus | Triangle-LFO modulated delay tap (depth 1–48 samples, rate 1–20 phase increments), 50/50 dry/wet, no feedback path. |
| `4` | Reverb | Ten fixed taps (73–487 samples, 7.6–50.7 ms) summed equally then fed back. Keep `feedback` < 205 for stability. |
| `5` | Tuner | Clean passthrough while `loop()` runs AMDF pitch detection every ~150 ms. |

**AMDF tuner**

The tuner computes D(τ) = Σ |buf[n] − buf[n+τ]| over lags τ = 24…128 samples
(≈ 75–400 Hz). Parabolic interpolation around the deepest dip recovers sub-sample
resolution — essential for the high strings, where one whole-sample lag step spans
tens of cents at 9615 Hz. A peak-amplitude gate suppresses readings on silence.
Pitch is reported as deci-Hz (Hz × 10) in the telemetry frame; the UI maps it to
the nearest standard-tuning string (E A D G B E) with a flat↔sharp cents needle.

**Serial control protocol**

The host sends an atomic all-parameters frame:

```text
P,<effect>,<drive>,<delayLen>,<feedback>,<mix>,<depth>,<rate>,<autoVGA>,<gain>
```

Ranges enforced by the firmware and host models:

| Field | Range | Meaning |
| --- | --- | --- |
| `effect` | 0-5 | Clean, overdrive, delay, chorus, reverb, tuner. |
| `drive` | 1-511 | Overdrive gain/clipping intensity. |
| `delayLen` | 1-512 | Delay tap distance in samples. |
| `feedback` | 0-255 | Delay repeats or reverb decay. |
| `mix` | 0-255 | Wet level for delay/reverb. |
| `depth` | 1-48 | Chorus modulation depth in samples. |
| `rate` | 1-20 | Chorus LFO phase increment. |
| `autoVGA` | 0 or 1 | Enable automatic analog gain control. |
| `gain` | -1 or 0-255 | `-1` keeps/uses auto mode; 0-255 sets manual VGA PWM. |

The board reports telemetry every 100 ms:

```text
T,<effect>,<peak>,<vga>,<clip>,<rxErr>,<freqDeciHz>
```

`freqDeciHz` is only nonzero in tuner mode and is reported as Hz × 10. The host turns
this into the tuner display against standard guitar tuning.

More firmware-specific notes are in [src/DSP_Pipeline/README.md](src/DSP_Pipeline/README.md).

## Web App

The web app lives in [src/host](src/host). It is a single FastAPI backend serving a
React/Vite frontend.

**Backend responsibilities**

- Own the real `AmpLink` serial connection, or use `MockLink` when hardware is absent.
- Keep the authoritative `AmpParams` state.
- Validate and clamp all values before they reach the firmware.
- Serve `GET /api/state`, `POST /api/params`, `POST /api/chat`, `POST /api/transcribe`,
  and `GET /api/telemetry`.
- Load `.env` for serial port, OpenAI proxy, CA bundle, model names, and server host/port.

**Frontend responsibilities**

- Manual amp controls for effect selection and the relevant parameters.
- Live telemetry and connection state.
- Tuner UI driven by firmware pitch telemetry.
- Chat panel for natural-language tone requests.
- Voice input flow using the wake phrase `hey amp`, browser microphone capture, Whisper
  transcription, and then the same chat/tone path as typed messages.

**Tone engine**

- OpenAI is the default provider when `OPENAI_API_KEY` is set.
- `OPENAI_BASE_URL` supports enterprise proxy routing.
- `OPENAI_CA_BUNDLE` lets Python trust enterprise TLS certificates without disabling
  verification.
- `OPENAI_CHAT_MODEL` currently defaults to `gpt-5.5`; change it in `.env` if the proxy
  reports no regional capacity for that model.
- Anthropic is available as a fallback with `AMP_LLM_PROVIDER=anthropic` and
  `ANTHROPIC_API_KEY`.

The LLM is not allowed to send arbitrary firmware strings. It can only call the structured
`set_amp_params` tool, and those values are validated by the host before the serial frame
is emitted.

## Running The Web App

From the repository root:

```bash
cd src/host
make env
# edit .env: set OPENAI_API_KEY, OPENAI_BASE_URL if required, and AMP_PORT if needed
make install
make run
```

Then open `http://127.0.0.1:8000`.

Useful setup commands:

```bash
make port          # list serial devices and mark likely Arduino ports
make set-port      # write detected board to .env as AMP_PORT=...
make serial-perms  # temporary Linux permission fix for the selected AMP_PORT
make doctor        # print local Python/Node/npm/OpenAI/AMP_PORT status
make web-dev       # frontend hot reload on :5173 while make run serves the API
make flash         # compile/upload firmware with arduino-cli
```

Dependencies and configuration are documented in [src/host/README.md](src/host/README.md).
The Python dependency lists are [src/host/requirements.txt](src/host/requirements.txt) and
[src/host/pyproject.toml](src/host/pyproject.toml); frontend dependencies are in
`src/host/web/package.json` and `src/host/web/package-lock.json`.

## Repository Layout

```text
data/                         images and schematics
src/DSP_Pipeline/             current Arduino DSP firmware and firmware README
src/PWM_Audio_Passthrough/    PWM output-stage prototype and final design notes
src/host/                     FastAPI backend, React frontend, Makefile, host docs
```

## Current Limitations

- Audio quality is constrained by the Arduino Uno ADC rate, 8-bit PWM output, SRAM, and
  simple reconstruction filter. This is a working guitar-effect prototype, not a studio
  audio interface.
- Only one firmware effect runs at a time (no chaining, e.g. overdrive + delay).
- The output stage expects a high-impedance input/load.
- Delay/reverb are limited to ~53 ms by the on-chip SRAM; external SRAM would extend this.
- Voice transcription and chat depend on the selected OpenAI model being available through
  the configured proxy and VPN policy.
