#!/usr/bin/env python3
"""
SF4 serial CLI — test tool for the current DSP_Pipeline.ino firmware.

Sends the atomic 'P' set-all frame and prints parsed 'T' telemetry as a live VU
meter. The web app (app/) is the real interface; this is for bench testing the
link without a browser.

Wire protocol (matches DSP_Pipeline.ino):
  PC -> MCU : P,<effect>,<drive>,<delayLen>,<feedback>,<mix>,<depth>,<rate>,<autoVGA>,<gain>\\n
  MCU -> PC : T,<effect>,<peak>,<vga>,<clip>,<rxErr>\\n   (~10 Hz)

Usage:
  python sf4_serial.py --demo overdrive
  python sf4_serial.py --effect reverb --feedback 190 --mix 220
  python sf4_serial.py --port /dev/tty.usbmodemXXXX --demo slapback
"""

import argparse
import sys
import time

from app.models import AmpParams
from app.serial_link import SF4Link, autodetect_port

DEMOS = {
    "clean":     {"effect": "clean"},
    "overdrive": {"effect": "overdrive", "drive": 200},
    "slapback":  {"effect": "delay", "delay_len": 400, "feedback": 150, "mix": 180},
    "chorus":    {"effect": "chorus", "depth": 30, "rate": 6},
    "reverb":    {"effect": "reverb", "feedback": 190, "mix": 220},
}


def main():
    ap = argparse.ArgumentParser(description="SF4 serial CLI / test tool")
    ap.add_argument("--port", help="serial port (auto-detect if omitted)")
    ap.add_argument("--demo", choices=sorted(DEMOS), help="send a built-in preset")
    ap.add_argument("--effect", choices=["clean", "overdrive", "delay", "chorus", "reverb"])
    ap.add_argument("--drive", type=int)
    ap.add_argument("--delay-len", type=int, dest="delay_len")
    ap.add_argument("--feedback", type=int)
    ap.add_argument("--mix", type=int)
    ap.add_argument("--depth", type=int)
    ap.add_argument("--rate", type=int)
    ap.add_argument("--gain", type=int)
    ap.add_argument("--seconds", type=float, default=10.0,
                    help="how long to read telemetry (0 = forever)")
    args = ap.parse_args()

    fields = dict(DEMOS.get(args.demo, {}))
    for k in ("effect", "drive", "delay_len", "feedback", "mix", "depth", "rate", "gain"):
        v = getattr(args, k)
        if v is not None:
            fields[k] = v
    params = AmpParams(**fields)

    port = args.port or autodetect_port()
    if not port:
        sys.exit("No serial port found; pass --port explicitly.")

    link = SF4Link(port=port)
    link.connect()
    print(f"[host] port   : {link.port}")
    print(f"[host] -> {params.to_frame()}")
    link.apply(params)

    t0 = time.time()
    try:
        while args.seconds == 0 or time.time() - t0 < args.seconds:
            tel = link.get_telemetry()
            bar = "#" * (tel.peak * 30 // 512)
            clip = "CLIP" if tel.clip else "    "
            print(f"  T fx={tel.effect} vga={tel.vga:3d} peak={tel.peak:3d} "
                  f"|{bar:<30}| {clip}  rxErr={tel.rx_err}", end="\r")
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        print()
        link.close()


if __name__ == "__main__":
    main()
