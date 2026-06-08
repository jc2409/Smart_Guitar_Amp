import { useEffect, useState } from "react";

const EMPTY = {
  effect: 0,
  peak: 0,
  vga: 0,
  clip: 0,
  rx_err: 0,
  freq_hz: 0,
  connected: false,
  port: null,
  // derived
  deviceConnected: false,
  link: "connecting", // "connecting" | "device" | "preview" | "down"
};

// Subscribes to /api/telemetry (SSE). Returns the latest telemetry frame.
export function useTelemetry() {
  const [tel, setTel] = useState(EMPTY);

  useEffect(() => {
    const es = new EventSource("/api/telemetry");
    es.onmessage = (ev) => {
      let t;
      try {
        t = JSON.parse(ev.data);
      } catch {
        return;
      }
      const deviceConnected = !!t.connected && t.port && t.port !== "mock";
      const link = deviceConnected ? "device" : t.port === "mock" ? "preview" : "down";
      setTel({ ...t, deviceConnected, link });
    };
    es.onerror = () => {
      setTel((prev) => ({ ...prev, link: "connecting" }));
    };
    return () => es.close();
  }, []);

  return { tel };
}
