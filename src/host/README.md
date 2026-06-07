# SF4 Host — Backend + LLM Tone Engine + Web UI

A single FastAPI app that owns the USB serial link to the Arduino DSP amp, runs a
conversational Claude tone engine, and serves a two-panel web dashboard.

## Layout

```
app/
  main.py        FastAPI app: owns SF4Link + amp state; /api/* + serves the UI
  models.py      AmpParams (firmware-range Pydantic model), Telemetry, schemas
  serial_link.py SF4Link (real board) + MockLink (no-hardware) + autodetect
  tone_engine.py conversational Claude engine with the set_amp_params tool
  static/        index.html, app.js, style.css  (the two-panel UI)
sf4_serial.py    CLI test tool (sends one P frame, prints telemetry)
Makefile         automation: env / install / run / dev / cli / flash / clean
requirements.txt pip dependency list (mirror of pyproject.toml)
.env.example     config template — copy to .env
```

## Quick start (Makefile)

```bash
cd src/host
make install            # uv sync, or venv + pip install -r requirements.txt
make env                # create .env from the template
#   → edit .env and set ANTHROPIC_API_KEY to enable the chat panel
make run                # start the web app  →  http://127.0.0.1:8000
```

| Target | Does |
|--------|------|
| `make env` | `cp .env.example .env` (no-op if it already exists) |
| `make install` | `uv sync` if `uv` is installed, else `python -m venv .venv && pip install -r requirements.txt` |
| `make run` | start the app on `$(HOST):$(PORT)` (from `.env`) |
| `make dev` | same, with `--reload` |
| `make cli ARGS="--demo overdrive"` | bench-test the serial link |
| `make flash` | `arduino-cli` compile + upload the firmware (uses `FQBN` + `SF4_PORT`) |
| `make clean` | remove the venv and caches |

The Makefile auto-detects `uv` (falling back to a plain venv) and loads `.env`.

## Run manually (without make)

```bash
cd src/host
uv sync                               # or: pip install -r requirements.txt
cp .env.example .env                  # then set ANTHROPIC_API_KEY in it
uvicorn app.main:app --reload         # .env is auto-loaded at startup
```

Open <http://127.0.0.1:8000>.

- **Hardware**: plug in the Uno; the port auto-detects (override with `SF4_PORT` in `.env`).
- **No hardware**: the backend falls back to a mock board — the UI and (with a key) the chat
  still work end to end, with synthetic telemetry.
- **No API key**: the manual control panel works; the chat panel returns a clear 503.

### Configuration (`.env`)

`.env` is loaded automatically on startup (via `python-dotenv`). Copy `.env.example`
to `.env` (or run `make env`). `.env` is gitignored — never commit your key.

| Var | Default | Meaning |
|-----|---------|---------|
| `ANTHROPIC_API_KEY` | — | required for the chat panel |
| `SF4_MODEL` | `claude-sonnet-4-6` | swap to `claude-haiku-4-5` (faster) or `claude-opus-4-8` (most capable) |
| `SF4_PORT` | auto-detect | force a serial port (e.g. `/dev/tty.usbmodem1101`) |
| `HOST` / `PORT` | `127.0.0.1` / `8000` | web server bind address (used by `make run`) |

## API

| Endpoint | Purpose |
|----------|---------|
| `POST /api/params` | manual control panel: apply a full `AmpParams` (no LLM) |
| `POST /api/chat` | one chat turn `{message, history}` → `{reply, params, changed}` |
| `GET /api/state` | current `AmpParams` (sync both panels) |
| `GET /api/telemetry` | SSE stream of live telemetry (~10 Hz) |

## CLI (bench test, no browser)

```bash
make cli ARGS="--demo overdrive"          # or, directly:
python sf4_serial.py --effect reverb --feedback 190 --mix 220
```

## Flashing the firmware

```bash
make flash          # needs arduino-cli; set SF4_PORT in .env first
                    # override the board with: make flash FQBN=arduino:avr:uno
```
