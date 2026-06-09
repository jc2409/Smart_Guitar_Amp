# SF4 Smart Guitar Amp

![Guitar Amp Demo Video]("https://www.youtube.com/watch?v=zBXpkTaCWV4")

SF4 is a hybrid guitar-effect amplifier built around a real analog input/output
path, an Arduino Uno DSP firmware, and a browser-based host app. The system lets
a player control the amp manually or ask for a sound in natural language; the host
turns that request into validated firmware parameters and sends them to the board.

The current implementation has three working layers:

1. Analog hardware for guitar-level signal conditioning, optical gain control, ADC
   input conditioning, and PWM audio reconstruction.
2. Arduino firmware for real-time DSP, automatic gain control, serial commands, and
   telemetry.
3. A FastAPI + React web app with sliders, live telemetry, tuner display, OpenAI chat,
   and Whisper-based voice input.

See [docs/SF4_Interim_Report.pdf](docs/SF4_Interim_Report.pdf) for the project report
context. The current host setup details live in [src/host/README.md](src/host/README.md).

## System Overview

```text
Guitar
  -> analog input buffer and 2.5 V bias
  -> optically controlled analog gain stage
  -> anti-aliasing low-pass filter
  -> Arduino A0 ADC
  -> Uno DSP firmware
  -> 62.5 kHz PWM audio on pin 10
  -> two-stage RC reconstruction filter and output coupling
  -> amp / line input / high-impedance headphones

Browser UI
  -> FastAPI host
  -> serial P frames to Arduino
  <- T telemetry frames from Arduino
  -> OpenAI chat and Whisper STT when enabled
```

The host falls back to a mock serial link when no board is connected, so the web app
and LLM/voice flow can still be demonstrated without hardware.

## Final Analog Circuit

The analog path is designed for a single 5 V system while preserving the AC guitar
signal around a 2.5 V virtual ground.

**Input and biasing**

- The guitar enters a high-impedance buffered input so passive pickups are not loaded.
- The signal is AC-coupled, then biased at about 2.5 V so the Arduino ADC can read the
  waveform inside its 0-5 V range.
- A buffered 2.5 V reference is used as the analog midpoint for the signal chain.

**Optical variable gain stage**

- The firmware drives an optocoupler LED from PWM pin 9 / OC1A.
- The optocoupler LDR changes the analog gain without putting a noisy digital control
  signal directly into the audio path.
- In automatic mode, firmware rides this gain gently based on measured output peak:
  loud signals are attenuated, quiet played signals are boosted, and silence drifts
  back to the resting gain.

**ADC conditioning**

- The post-gain audio is low-pass filtered before A0 to reduce content above the ADC
  Nyquist frequency.
- The firmware samples A0 at about 9.6 kHz, so the practical audio bandwidth is guitar
  focused rather than hi-fi full range.

**PWM audio output**

- The Arduino outputs processed audio as 8-bit Fast PWM on pin 10 / OC1B at 62.5 kHz.
- The final reconstruction filter is two passive RC low-pass stages with a buffer between
  them: 2.2 kOhm + 15 nF per stage, giving a corner near 4.8 kHz per pole.
- The buffer-between-poles topology is intentional. It avoids the high-frequency carrier
  feedthrough and slew problems seen with a slow-op-amp Sallen-Key attempt.
- The output is AC-coupled through a 10 uF capacitor with a 100 kOhm pulldown, removing
  the 2.5 V bias while keeping the guitar low end intact.
- The output is intended for a high-impedance line/aux input or similar load, not for
  directly driving a low-impedance speaker.

The PWM output-stage debugging and component choices are documented in
[src/PWM_Audio_Passthrough/DESIGN_NOTES.md](src/PWM_Audio_Passthrough/DESIGN_NOTES.md).

## Firmware

The current firmware is [src/DSP_Pipeline/DSP_Pipeline.ino](src/DSP_Pipeline/DSP_Pipeline.ino).
It targets an Arduino Uno R3 / ATmega328P.

**Timing and I/O**

- ADC input: A0, free-running, prescaler 128, about 9.6 kHz sample rate.
- Audio output: Timer1 8-bit Fast PWM on pin 10 / OC1B, 62.5 kHz carrier.
- VGA output: Timer1 PWM on pin 9 / OC1A, 0-255 duty value.
- Serial: 115200 baud.
- Audio processing runs in the `ADC_vect` interrupt, one sample at a time.

**Effects**

The firmware runs exactly one effect mode at a time:

| ID | Effect | Implemented behavior |
| --- | --- | --- |
| `0` | Clean | Transparent passthrough. |
| `1` | Overdrive | Pre-gain followed by hard clipping; `drive` range 1-511. |
| `2` | Delay | Single circular-buffer echo, up to 512 samples, about 53 ms at 9.6 kHz. |
| `3` | Chorus | Triangle-LFO modulated short delay with 50/50 dry/wet mix. |
| `4` | Reverb | Ten-tap feedback network; feedback should stay below about 205 for stability. |
| `5` | Tuner | Clean passthrough while the main loop runs AMDF pitch detection. |

The shared audio buffer is 512 `int8_t` samples. Delay, chorus, reverb, and tuner all
reuse that memory so the firmware fits within the Uno SRAM budget.

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

`freqDeciHz` is only nonzero in tuner mode and is reported as Hz x 10. The host turns
this into the tuner display against standard guitar tuning.

More firmware-specific notes are in [src/DSP_Pipeline/README.md](src/DSP_Pipeline/README.md).

## Web App

The web app lives in [src/host](src/host). It is a single FastAPI backend serving a
React/Vite frontend.

**Backend responsibilities**

- Own the real `SF4Link` serial connection, or use `MockLink` when hardware is absent.
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
- `OPENAI_BASE_URL` supports enterprise proxy routing, including the Arm proxy URL.
- `OPENAI_CA_BUNDLE` lets Python trust the enterprise TLS certificate without disabling
  verification.
- `OPENAI_CHAT_MODEL` currently defaults to `gpt-5.5`; change it in `.env` if the proxy
  reports no regional capacity for that model.
- Anthropic remains available as a fallback with `SF4_LLM_PROVIDER=anthropic` and
  `ANTHROPIC_API_KEY`.

The LLM is not allowed to send arbitrary firmware strings. It can only call the structured
`set_amp_params` tool, and those values are validated by the host before the serial frame
is emitted.

## Running The Web App

From the repository root:

```bash
cd src/host
make env
# edit .env: set OPENAI_API_KEY, OPENAI_BASE_URL if required, and SF4_PORT if needed
make install
make run
```

Then open `http://127.0.0.1:8000`.

Useful setup commands:

```bash
make port          # list serial devices and mark likely Arduino ports
make set-port      # write detected board to .env as SF4_PORT=...
make serial-perms  # temporary Linux permission fix for the selected SF4_PORT
make doctor        # print local Python/Node/npm/OpenAI/SF4_PORT status
make web-dev       # frontend hot reload on :5173 while make run serves the API
make flash         # compile/upload firmware with arduino-cli
```

Dependencies and configuration are documented in [src/host/README.md](src/host/README.md).
The Python dependency lists are [src/host/requirements.txt](src/host/requirements.txt) and
[src/host/pyproject.toml](src/host/pyproject.toml); frontend dependencies are in
`src/host/web/package.json` and `src/host/web/package-lock.json`.

## Repository Layout

```text
docs/                         project handouts, order sheet, interim report
src/DSP_Pipeline/             current Arduino DSP firmware and firmware README
src/PWM_Audio_Passthrough/    PWM output-stage prototype and final design notes
src/host/                     FastAPI backend, React frontend, Makefile, host docs
schematics/                   analog design and LTSpice material
```

## Current Limitations

- Audio quality is constrained by the Arduino Uno ADC rate, 8-bit PWM output, SRAM, and
  simple reconstruction filter. This is a working guitar-effect prototype, not a studio
  audio interface.
- Only one firmware effect runs at a time.
- The output stage expects a high-impedance input/load.
- Voice transcription and chat depend on the selected OpenAI model being available through
  the configured proxy and VPN policy.
