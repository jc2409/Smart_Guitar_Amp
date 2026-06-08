"""
Canonical data model shared across LLM <-> backend <-> serial <-> UI.

`AmpParams` mirrors the firmware parameter bank and its `constrain()` ranges in
DSP_Pipeline.ino (handleCmd). Validation/clamping lives here so neither the LLM
nor the manual UI can ever push an out-of-range value to the MCU.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
from typing import Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class Effect(IntEnum):
    CLEAN = 0
    OVERDRIVE = 1
    DELAY = 2
    CHORUS = 3
    REVERB = 4
    TUNER = 5


# Accept either the name ("reverb") or the int (4) from the LLM / UI.
_EFFECT_BY_NAME = {e.name.lower(): e for e in Effect}

FS_HZ = 9615.0  # firmware effective sample rate (ADC prescaler 128)


def _clamp(v: float, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(round(v))))


_RANGES = {
    "drive": (1, 511), "delay_len": (1, 512), "feedback": (0, 255),
    "mix": (0, 255), "depth": (1, 48), "rate": (1, 20), "gain": (0, 255),
}


class AmpParams(BaseModel):
    """The full amp state. Out-of-range values are clamped to the firmware range,
    never rejected — neither the LLM nor the UI can push a bad value to the MCU."""

    effect: Effect = Field(
        default=Effect.CLEAN,
        description="Active effect: clean, overdrive, delay, chorus, or reverb.",
    )
    drive: int = Field(
        default=180,
        description="Overdrive gain (drive), 1-511. ~16=breakup, 180=rock, "
                    "480=metal. Only audible when effect=overdrive.",
    )
    delay_len: int = Field(
        default=400,
        description="Delay length in samples, 1-512 (t = delay_len / 9615 Hz; "
                    "max ~53 ms). Only used when effect=delay.",
    )
    feedback: int = Field(
        default=190,
        description="Delay/reverb regeneration (Q8), 0-255. Higher = longer tail. "
                    "Keep < 205 for reverb to stay stable.",
    )
    mix: int = Field(
        default=220,
        description="Wet level (Q8) for delay/reverb, 0-255. Higher = more effect.",
    )
    depth: int = Field(
        default=24,
        description="Chorus LFO modulation depth in samples, 1-48. Only used when "
                    "effect=chorus.",
    )
    rate: int = Field(
        default=8,
        description="Chorus LFO rate, 1-20. Only used when effect=chorus.",
    )
    auto_vga: bool = Field(
        default=True,
        description="Automatic gain control on/off. Leave on unless setting a "
                    "manual gain.",
    )
    gain: Optional[int] = Field(
        default=None,
        description="Manual VGA gain (OCR1A), 0-255. When set, auto_vga is forced "
                    "off. Leave null to let auto_vga manage it.",
    )

    @field_validator("effect", mode="before")
    @classmethod
    def _coerce_effect(cls, v):
        if isinstance(v, str):
            key = v.strip().lower()
            if key in _EFFECT_BY_NAME:
                return _EFFECT_BY_NAME[key]
            if key.isdigit():
                return _clamp(int(key), 0, 5)
        if isinstance(v, (int, float)):
            return _clamp(v, 0, 5)
        return v

    @model_validator(mode="before")
    @classmethod
    def _clamp_numeric(cls, data):
        if not isinstance(data, dict):
            return data
        out = dict(data)
        for key, (lo, hi) in _RANGES.items():
            if out.get(key) is not None:
                out[key] = _clamp(out[key], lo, hi)
        # manual gain implies auto-VGA off
        if out.get("gain") is not None and "auto_vga" not in out:
            out["auto_vga"] = False
        return out

    def to_frame(self) -> str:
        """Serialise to the firmware's atomic 'P' set-all frame (no newline)."""
        gain_field = self.gain if self.gain is not None else -1
        fields = [
            int(self.effect),
            self.drive,
            self.delay_len,
            self.feedback,
            self.mix,
            self.depth,
            self.rate,
            1 if self.auto_vga else 0,
            gain_field,
        ]
        return "P," + ",".join(str(v) for v in fields)

    def merge(self, patch: dict) -> "AmpParams":
        """Return a re-validated copy with `patch` applied (partial LLM updates).

        Rebuilds through the constructor so clamping and the manual-gain rule run.
        """
        merged = {**self.model_dump(), **patch}
        if "gain" in patch and patch.get("gain") is not None and "auto_vga" not in patch:
            merged["auto_vga"] = False   # explicit new gain → manual mode
        return AmpParams(**merged)


@dataclass
class Telemetry:
    """One parsed 'T,effect,peak,vga,clip,rxErr[,freqDeciHz]' frame from the MCU.

    `freq_dhz` is the detected fundamental in deci-Hz (Hz x 10), populated only in
    tuner mode (0 otherwise). The field is optional so older firmware that emits
    the 6-field frame still parses.
    """

    effect: int = 0
    peak: int = 0
    vga: int = 0
    clip: int = 0
    rx_err: int = 0
    freq_dhz: int = 0

    @property
    def freq_hz(self) -> float:
        return self.freq_dhz / 10.0

    @classmethod
    def parse(cls, line: str) -> Optional["Telemetry"]:
        if not line.startswith("T,"):
            return None
        parts = line.split(",")
        if len(parts) not in (6, 7):
            return None
        try:
            _, effect, peak, vga, clip, rx = parts[:6]
            freq = parts[6] if len(parts) == 7 else "0"
            return cls(int(effect), int(peak), int(vga), int(clip), int(rx),
                       int(freq))
        except ValueError:
            return None

    def to_dict(self) -> dict:
        return {
            "effect": self.effect,
            "peak": self.peak,
            "vga": self.vga,
            "clip": self.clip,
            "rx_err": self.rx_err,
            "freq_hz": self.freq_hz,
        }


# ─── API request/response schemas ───────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str            # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = Field(default_factory=list)


class ChatResponse(BaseModel):
    reply: str
    params: AmpParams
    changed: bool
