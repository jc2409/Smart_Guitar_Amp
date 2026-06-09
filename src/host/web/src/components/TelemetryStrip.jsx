const EFFECT_NAMES = ["clean", "overdrive", "delay", "chorus", "reverb", "tuner"];

function fmt(value, fallback = "0") {
  return value === null || value === undefined ? fallback : String(value);
}

export default function TelemetryStrip({ tel }) {
  const effect = EFFECT_NAMES[tel.effect] || fmt(tel.effect, "-");
  const freq = tel.freq_hz ? `${tel.freq_hz.toFixed(1)} Hz` : "-";

  return (
    <div className="telemetry-strip" aria-label="Live telemetry">
      <span><i>Effect</i><b>{effect}</b></span>
      <span><i>Peak</i><b>{fmt(tel.peak)}</b></span>
      <span><i>VGA</i><b>{fmt(tel.vga)}</b></span>
      <span className={tel.clip ? "warn" : ""}><i>Clip</i><b>{tel.clip ? "yes" : "no"}</b></span>
      <span><i>RX Err</i><b>{fmt(tel.rx_err)}</b></span>
      <span><i>Pitch</i><b>{freq}</b></span>
    </div>
  );
}
