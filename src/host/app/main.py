"""
FastAPI app: owns the serial link + authoritative amp state, serves the two-panel
web UI, and exposes the manual / chat / telemetry endpoints.

Run from src/host/:
    ANTHROPIC_API_KEY=...  uvicorn app.main:app --reload
    (set SF4_PORT to force a serial port; otherwise it auto-detects, and falls
     back to a mock board if none is found)
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()  # load src/host/.env (ANTHROPIC_API_KEY, SF4_MODEL, SF4_PORT)
except ImportError:
    pass

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .models import AmpParams, ChatRequest
from .serial_link import create_link
from .tone_engine import ToneEngine

STATIC_DIR = Path(__file__).parent / "static"


def _dump(p: AmpParams) -> dict:
    """Serialise params with `effect` as its name (clean/overdrive/...) for the UI."""
    d = p.model_dump()
    d["effect"] = p.effect.name.lower()
    return d


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.link = create_link(os.environ.get("SF4_PORT"))
    app.state.params = AmpParams()
    app.state.lock = threading.Lock()
    try:
        app.state.engine = ToneEngine()
    except Exception as exc:                      # no key / SDK / etc.
        print(f"[tone_engine] chat disabled: {exc}")
        app.state.engine = None
    # Push the default state to the board so hardware matches the UI on boot.
    try:
        app.state.link.apply(app.state.params)
    except Exception:
        pass
    yield
    app.state.link.close()


app = FastAPI(title="SF4 Smart Guitar Amp", lifespan=lifespan)


def apply_params(p: AmpParams) -> AmpParams:
    """The single path both panels funnel through: write to MCU + update state."""
    with app.state.lock:
        app.state.link.apply(p)
        app.state.params = p
        return p


@app.get("/api/state")
def get_state():
    return _dump(app.state.params)


@app.post("/api/params")
def set_params(params: AmpParams):
    """Manual control panel: apply a full parameter set (no LLM)."""
    return _dump(apply_params(params))


@app.post("/api/chat")
def chat(req: ChatRequest):
    """Chat panel: one conversational turn; may change the sound via the tool."""
    engine: ToneEngine | None = app.state.engine
    if engine is None:
        raise HTTPException(503, "Chat is unavailable: set ANTHROPIC_API_KEY and "
                                 "install the anthropic SDK, then restart.")
    tel = app.state.link.get_telemetry()
    try:
        reply, params, changed = engine.chat(
            message=req.message,
            history=req.history,
            current=app.state.params,
            apply_fn=apply_params,
            telemetry=tel,
        )
    except Exception as exc:
        raise HTTPException(502, f"LLM error: {exc}")
    return {"reply": reply, "params": _dump(params), "changed": changed}


@app.get("/api/telemetry")
async def telemetry():
    """Server-Sent Events: live telemetry at ~10 Hz."""

    async def gen():
        while True:
            tel = app.state.link.get_telemetry()
            payload = tel.to_dict()
            payload["connected"] = app.state.link.connected
            payload["port"] = app.state.link.port
            yield f"data: {json.dumps(payload)}\n\n"
            await asyncio.sleep(0.1)

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


# Static assets (app.js, style.css). Mounted last so /api/* takes precedence.
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
