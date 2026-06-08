"""
Serial bridge to the Arduino DSP pipeline.

`SF4Link` owns the USB serial port: it writes the firmware's atomic 'P' set-all
frame and runs a background reader thread that parses 'T,...' telemetry. The
latest telemetry is kept under a lock; the SSE endpoint polls it at ~10 Hz.

`MockLink` is a drop-in with no hardware — it echoes applied params and emits
synthetic telemetry so the UI and LLM can be demoed without the board.

Wire protocol (matches DSP_Pipeline.ino):
  PC -> MCU : P,<effect>,<drive>,<delayLen>,<feedback>,<mix>,<depth>,<rate>,<autoVGA>,<gain>\n
  MCU -> PC : T,<effect>,<peak>,<vga>,<clip>,<rxErr>\n   (~10 Hz)
"""

from __future__ import annotations

import math
import threading
import time

from .models import AmpParams, Telemetry

BAUD = 115200
_PORT_HINTS = ("usbmodem", "usbserial", "arduino", "wchusb", "ttyacm", "ttyusb")


def autodetect_port() -> str | None:
    try:
        from serial.tools import list_ports
    except ImportError:
        return None
    for p in list_ports.comports():
        name = (p.device or "") + " " + (p.description or "")
        if any(h in name.lower() for h in _PORT_HINTS):
            return p.device
    # Only return Arduino-like ports — never grab a random debug/Bluetooth port.
    return None


class BaseLink:
    """Common interface for real and mock links."""

    connected: bool = False
    port: str | None = None

    def apply(self, params: AmpParams) -> None:
        raise NotImplementedError

    def get_telemetry(self) -> Telemetry:
        raise NotImplementedError

    def close(self) -> None:
        pass


class SF4Link(BaseLink):
    def __init__(self, port: str | None = None, baud: int = BAUD):
        self._port_arg = port
        self._baud = baud
        self._ser = None
        self._lock = threading.Lock()
        self._latest = Telemetry()
        self._reader: threading.Thread | None = None
        self._stop = threading.Event()

    def connect(self) -> None:
        import serial  # imported lazily so the module loads without pyserial

        port = self._port_arg or autodetect_port()
        if not port:
            raise RuntimeError("no serial port found")
        self._ser = serial.Serial(port, self._baud, timeout=0.3)
        self.port = port
        time.sleep(2.0)            # let the Uno auto-reset (DTR) settle
        self._ser.reset_input_buffer()
        self.connected = True
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        assert self._ser is not None
        while not self._stop.is_set():
            try:
                raw = self._ser.readline().decode(errors="replace").strip()
            except Exception:
                break
            if not raw:
                continue
            tel = Telemetry.parse(raw)
            if tel is not None:
                with self._lock:
                    self._latest = tel

    def apply(self, params: AmpParams) -> None:
        if not self._ser:
            raise RuntimeError("serial port not open")
        frame = (params.to_frame() + "\n").encode()
        with self._lock:
            self._ser.write(frame)

    def get_telemetry(self) -> Telemetry:
        with self._lock:
            return self._latest

    def close(self) -> None:
        self._stop.set()
        if self._ser:
            try:
                self._ser.close()
            except Exception:
                pass
        self.connected = False


class MockLink(BaseLink):
    """No-hardware stand-in: echoes params, fakes a wobbling VU meter."""

    def __init__(self) -> None:
        self.connected = True
        self.port = "mock"
        self._params = AmpParams()
        self._t0 = time.time()

    def apply(self, params: AmpParams) -> None:
        self._params = params

    # Standard-tuning string fundamentals (Hz) — used to fake tuner readings.
    _STRINGS = (82.41, 110.00, 146.83, 196.00, 246.94, 329.63)

    def get_telemetry(self) -> Telemetry:
        # Synthesize a plausible peak that wobbles, scaled by mix/drive so the
        # meter visibly reacts to changes.
        t = time.time() - self._t0
        base = 120 + 80 * math.sin(t * 2.0)
        if self._params.effect == 1:  # overdrive louder
            base = min(380, base + self._params.drive // 4)
        peak = max(0, int(base))
        vga = self._params.gain if self._params.gain is not None else 15
        clip = 1 if peak > 360 else 0

        # Tuner mode: slowly cycle through the strings, each drifting a few cents
        # around its target so the UI needle visibly sweeps flat<->sharp.
        freq_dhz = 0
        if self._params.effect == 5:
            target = self._STRINGS[int(t / 3.0) % len(self._STRINGS)]
            cents = 18.0 * math.sin(t * 1.3)          # ±18 cents wander
            freq = target * (2.0 ** (cents / 1200.0))
            freq_dhz = int(round(freq * 10))

        return Telemetry(effect=int(self._params.effect), peak=peak,
                         vga=int(vga), clip=clip, rx_err=0, freq_dhz=freq_dhz)


def create_link(port: str | None = None) -> BaseLink:
    """Try to open the real board; fall back to the mock on any failure."""
    link = SF4Link(port=port)
    try:
        link.connect()
        return link
    except Exception as exc:  # no port, pyserial missing, etc.
        print(f"[SF4Link] hardware unavailable ({exc}); using MockLink")
        return MockLink()
