# Smart Guitar Amp: LLM-Driven Analog & Digital Effects

## Overview
The Smart Guitar Amp is a hybrid hardware-software system that bridges the gap between pure analog tone, digital signal processing (DSP), and modern artificial intelligence. It takes a raw, high-impedance guitar signal and processes it through a custom-designed analog front-end, followed by a digital effects pipeline.

Instead of manually turning physical knobs, users interact with a web interface powered by a Large Language Model (LLM). By entering natural language prompts (e.g., "Make me sound like David Gilmour on Comfortably Numb") or searching for specific songs, the AI translates subjective tonal requests into objective numerical parameters. These parameters automatically adjust both the physical analog circuit and the digital DSP algorithms in real-time to match the desired sound.

---

## System Architecture

The project is divided into three main computational domains:
1. **Analog Front-End:** High-fidelity signal conditioning and optical gain staging.
2. **Embedded Firmware & DSP:** Real-time data acquisition, digital audio transformations, hardware control, and communication.
3. **Software Backend & UI:** User interaction, LLM parameter translation, and preset management.

---

## 1. Analog Front-End (Audio Processing)
The analog circuit is designed to operate on a single 5V supply while preserving the integrity and dynamic range of the AC guitar signal. The audio path prepares the signal for digitization while providing analog drive characteristics controlled optically by the microcontroller.

The circuit consists of three primary, AC-coupled stages:

### Stage 1: Input Buffer & Power Conditioning
* **Op-Amp:** TL072 (JFET-input)
* **Function:** Provides a high-impedance (1MΩ) input to prevent loading the passive guitar pickups, preserving high-frequency transient responses. 
* **Virtual Ground Generation:** The unused second channel of the TL072 acts as an active unity-gain buffer to generate a rock-solid 2.5V DC reference from a filtered voltage divider, preventing power rail sag and inter-stage crosstalk.
* **Coupling:** The raw signal is AC-coupled via a 10µF capacitor and biased to the 2.5V reference to maximize dynamic range.

### Stage 2: Variable Gain Amplifier (VGA)
* **Op-Amp:** LM358 / LM2904
* **Function:** Amplifies the buffered guitar signal to introduce analog warmth and drive.
* **Smart Control:** The feedback loop utilizes a Light Dependent Resistor (LDR). By coupling this LDR with an LED controlled by the microcontroller, the firmware optically adjusts the analog gain. This completely isolates the audio path from digital control signals, preventing noise injection.

### Stage 3: Low-Pass Filter (Anti-Aliasing)
* **Op-Amp:** LTC6078 (Precision Rail-to-Rail)
* **Function:** A Sallen-Key low-pass filter topology.
* **Signal Integrity:** The signal is AC-coupled (4.7µF) from the VGA and actively pulled back to the 2.5V reference via a 1MΩ resistor. The filter strictly removes high-frequency noise and out-of-band harmonics to prevent aliasing before the signal reaches the microcontroller's Analog-to-Digital Converter (ADC).

---

## 2. Embedded Firmware & DSP
The firmware acts as the execution engine for the smart amplifier. It is strictly optimized to maintain an overarching **"Glass-to-Glass" latency of under 10 milliseconds**, ensuring the amplifier feels instantaneous and responsive to the player. 

### Data Acquisition & Output (ADC/DAC)
* **Interrupt-Driven ADC:** Triggered by a hardware timer to guarantee a rigid 10 kHz sample rate. This is explicitly paired with the analog front-end's 4.8 kHz hardware low-pass filter to respect the 5 kHz Nyquist limit, ensuring zero digital aliasing.
* **Audio Output Stage:** Following DSP, the finalized digital audio array is pushed out via a high-speed Digital-to-Analog Converter (DAC) or filtered high-frequency PWM to drive the physical speaker/headphone amplifier.
* **Buffering:** Incoming and outgoing samples are streamed via double-buffered arrays (or DMA) to allow the CPU to crunch DSP mathematics without dropping audio frames.

### Signal Processing Pipeline (DSP)
Once digitized, the audio array passes through an interrupt-driven pipeline to achieve distinct digital effects:
* **Non-Linear Transformations (Overdrive/Fuzz):** * **Hard/Soft Clipping:** Implements strict threshold logic to truncate waveforms, generating odd-order harmonics. Soft clipping utilizes wave-shaping algorithms (hyperbolic tangent approximations or polynomial mapping) to simulate tube compression.
* **Time-Domain Processing (Delay/Chorus):** * **Circular Ring Buffers:** Stores audio samples in a pre-allocated memory array.   
  * **Fractional Delay & LFOs:** Modulates the read-pointer of the ring buffer using Low Frequency Oscillators. Linear interpolation is applied between samples to prevent pitch artifacts.
* **Frequency-Domain Processing (EQ):** * **Biquad Filters:** Implements cascaded Infinite Impulse Response (IIR) filters. The LLM dictates the coefficients (Q-factor, center frequency, and gain) to create parametric EQ bands.

### Effect Actuation & Serial Communication
* **Optical Gain Staging:** The firmware translates the target analog gain into a high-frequency PWM signal (>20kHz, RC-filtered into DC) to drive the LED in the VGA stage, preventing digital switching noise from bleeding into the audio path.
* **Non-Blocking UART:** Maintains a high baud-rate connection. Incoming JSON payloads from the host machine are parsed asynchronously, ensuring parameter updates (like changing an EQ coefficient or VGA gain) never stall the audio interrupts.

---

## 3. Software & AI Architecture
The software stack provides the intelligence of the amplifier, handling user intent, LLM prompting, hardware calibration, and serial communication.

### Tech Stack
* **Frontend:** React + Vite (in `src/host/web/`), built into `app/static/` and served by FastAPI
* **Backend:** Python / FastAPI — owns the serial link + amp state, exposes a JSON/SSE API
* **LLM:** Anthropic Claude (official Python SDK), tool-use for parameter setting
* **Link:** pyserial bridge to the Arduino (atomic `P` set-all frame + `T` telemetry)

A single FastAPI process (`src/host/app/`) owns the serial port and the authoritative
amp state, runs the LLM tone engine, and serves the dashboard.

```bash
cd src/host
make install        # uv (or venv + pip)
make env            # → edit .env, set ANTHROPIC_API_KEY
make run            # http://127.0.0.1:8000
```

See [`src/host/README.md`](src/host/README.md) for the full Makefile targets,
configuration, API, and CLI.

### Core Features
The web UI does two things, both driving one shared parameter state:

* **Manual control panel:** Sliders / knobs / an effect selector that feel like a real
  effects unit. Each change is pushed straight to the amp via the `P` frame. The selector
  includes a **Tuner** mode: the firmware detects the played string's pitch and the UI
  shows it against the six standard-tuning strings (E2 A2 D3 G3 B3 E4) with a flat↔sharp
  cents needle.
* **Talk to the LLM:** A conversational chat — describe a tone ("warm bluesy overdrive")
  or name a song/artist ("Gilmour on Comfortably Numb"). Claude replies in natural
  language and, via a `set_amp_params` tool, sets the amp itself; the manual knobs move to
  match. Iterative requests ("a touch less reverb") work because the current sound is fed
  into each turn. All values are validated/clamped to the firmware ranges before they reach
  the MCU.
* **Live telemetry:** The board streams status over Server-Sent Events (~10 Hz) — connection
  state and, in Tuner mode, the detected pitch that drives the tuner display.

> **No-hardware mode:** with no board attached the backend falls back to a mock link, so the
> UI and LLM are fully demoable without the amp.

*Not yet built (clean seams left for them):* preset save/load + database, song-metadata DB,
and the LDR calibration profiler.