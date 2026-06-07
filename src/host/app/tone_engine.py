"""
Conversational LLM tone engine (Anthropic Claude).

This is a chat, not a one-shot generator. The user can ask questions, request a
tone, name a song/artist, or iterate ("a bit less reverb"). The assistant replies
in natural language and changes the sound only when appropriate, by calling the
`set_amp_params` tool. The current amp state (and recent telemetry) is fed in each
turn so the model adjusts the live sound rather than starting from scratch.
"""

from __future__ import annotations

import json
import os
from typing import Callable

from .models import AmpParams, ChatMessage, Telemetry

DEFAULT_MODEL = os.environ.get("SF4_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 2048   # headroom: adaptive thinking tokens count toward this
MAX_TOOL_ROUNDS = 4

SYSTEM_PROMPT = """\
You are the tone engine for the SF4 smart guitar amp — a real-time Arduino DSP \
pedal. You translate what a guitarist asks for into the amp's parameters and chat \
with them about their sound.

The amp runs exactly ONE effect at a time. Effects and their parameters:

- clean       : transparent passthrough. No effect parameters.
- overdrive   : hard-clipping distortion. `drive` is the gain (1-511): ~16 = edge
                of breakup, ~180 = rock crunch, ~480 = saturated metal.
- delay       : single echo with feedback. `delay_len` (1-512 samples) sets the
                echo time (t = delay_len / 9615 Hz, up to ~53 ms — slapback range).
                `feedback` (0-255) sets how many repeats; `mix` (0-255) how loud.
- chorus      : modulated short delay, 50/50 dry/wet. `depth` (1-48) sets the
                sweep amount; `rate` (1-20) the LFO speed.
- reverb      : dense feedback network. `feedback` (0-255) sets the tail length —
                KEEP IT UNDER 205 or it self-oscillates. `mix` (0-255) the wet level.

`auto_vga` (default true) keeps the input gain managed automatically; only set a
manual `gain` (0-255) if the user explicitly asks about input level.

Guidelines:
- When the user describes a sound or names a song/artist, pick the single best
  effect and musically sensible values, then call `set_amp_params`. Use your own
  knowledge of artists' and songs' signature tones.
- Only change the fields that matter; the rest keep their current values.
- For iterative requests ("a touch more space", "less drive"), adjust relative to
  the CURRENT settings you are given.
- If the user just asks a question or chats, answer WITHOUT calling the tool.
- Keep replies short and friendly — a sentence or two. Briefly say what you set."""


def _tool_schema() -> dict:
    """JSON schema for set_amp_params — all fields optional (partial update)."""
    return {
        "name": "set_amp_params",
        "description": (
            "Set the amp's sound. Provide only the fields you want to change; "
            "omitted fields keep their current value. Call this whenever the user "
            "wants the sound changed."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "effect": {
                    "type": "string",
                    "enum": ["clean", "overdrive", "delay", "chorus", "reverb"],
                    "description": "Which effect to activate.",
                },
                "drive": {"type": "integer", "minimum": 1, "maximum": 511,
                          "description": "Overdrive gain."},
                "delay_len": {"type": "integer", "minimum": 1, "maximum": 512,
                              "description": "Delay time in samples."},
                "feedback": {"type": "integer", "minimum": 0, "maximum": 255,
                             "description": "Delay/reverb tail (<205 for reverb)."},
                "mix": {"type": "integer", "minimum": 0, "maximum": 255,
                        "description": "Wet level for delay/reverb."},
                "depth": {"type": "integer", "minimum": 1, "maximum": 48,
                          "description": "Chorus sweep depth."},
                "rate": {"type": "integer", "minimum": 1, "maximum": 20,
                         "description": "Chorus LFO rate."},
                "auto_vga": {"type": "boolean",
                             "description": "Automatic input gain on/off."},
                "gain": {"type": "integer", "minimum": 0, "maximum": 255,
                         "description": "Manual input gain (forces auto_vga off)."},
            },
            "additionalProperties": False,
        },
    }


def _context_line(params: AmpParams, tel: Telemetry | None) -> str:
    cur = params.model_dump()
    cur["effect"] = params.effect.name.lower()
    line = f"[current settings: {json.dumps(cur)}]"
    if tel is not None:
        line += f" [telemetry: peak={tel.peak} clip={tel.clip} vga={tel.vga}]"
    return line


class ToneEngine:
    def __init__(self, model: str = DEFAULT_MODEL):
        import anthropic  # lazy: import only when chat is actually used

        # The SDK client constructs fine without a key and only fails at call
        # time — check here so the app can cleanly disable chat instead of
        # surfacing a cryptic auth error on the first message.
        if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            raise RuntimeError("ANTHROPIC_API_KEY is not set")

        self._client = anthropic.Anthropic()  # key from ANTHROPIC_API_KEY
        self._model = model
        self._tool = _tool_schema()
        # Adaptive thinking is a 4.6+ feature; Haiku 4.5 rejects it. Disabling
        # thinking on Haiku is also what makes it fastest — ideal here.
        self._thinking = (
            {"type": "disabled"} if "haiku" in model.lower()
            else {"type": "adaptive"}
        )

    def chat(
        self,
        message: str,
        history: list[ChatMessage],
        current: AmpParams,
        apply_fn: Callable[[AmpParams], AmpParams],
        telemetry: Telemetry | None = None,
    ) -> tuple[str, AmpParams, bool]:
        """Run one chat turn. Returns (reply_text, params, changed)."""
        messages: list[dict] = [
            {"role": m.role, "content": m.content} for m in history
        ]
        user_text = f"{_context_line(current, telemetry)}\n\n{message}"
        messages.append({"role": "user", "content": user_text})

        params = current
        changed = False
        reply_parts: list[str] = []

        for _ in range(MAX_TOOL_ROUNDS):
            resp = self._client.messages.create(
                model=self._model,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                thinking=self._thinking,
                tools=[self._tool],
                messages=messages,
            )

            for block in resp.content:
                if block.type == "text":
                    reply_parts.append(block.text)

            if resp.stop_reason != "tool_use":
                break

            # Execute every set_amp_params call, collect tool_results.
            messages.append({"role": "assistant", "content": resp.content})
            tool_results = []
            for block in resp.content:
                if block.type != "tool_use" or block.name != "set_amp_params":
                    continue
                patch = dict(block.input or {})
                try:
                    params = apply_fn(params.merge(patch))
                    changed = True
                    cur = params.model_dump()
                    cur["effect"] = params.effect.name.lower()
                    result = {"ok": True, "applied": cur}
                except Exception as exc:
                    result = {"ok": False, "error": str(exc)}
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result),
                })
            messages.append({"role": "user", "content": tool_results})

        reply = "\n".join(p.strip() for p in reply_parts if p.strip())
        if not reply:
            reply = "Done." if changed else "(no response)"
        return reply, params, changed
