// Guitar tuner readout. Reads tel.freq_hz (firmware-detected fundamental) and
// shows it against the 6 standard strings with a flat<->sharp cents needle.

const STRINGS = [
  { name: "E", octave: 2, hz: 82.41 },
  { name: "A", octave: 2, hz: 110.0 },
  { name: "D", octave: 3, hz: 146.83 },
  { name: "G", octave: 3, hz: 196.0 },
  { name: "B", octave: 3, hz: 246.94 },
  { name: "E", octave: 4, hz: 329.63 },
];

const IN_TUNE_CENTS = 5;   // ±window treated as "in tune"
const NEEDLE_RANGE = 50;   // cents mapped to the edges of the needle track

function nearestString(freq) {
  let best = STRINGS[0];
  let bestCents = Infinity;
  for (const s of STRINGS) {
    const cents = 1200 * Math.log2(freq / s.hz);
    if (Math.abs(cents) < Math.abs(bestCents)) {
      bestCents = cents;
      best = s;
    }
  }
  return { string: best, cents: bestCents };
}

export default function TunerDisplay({ tel }) {
  const preview = !tel.deviceConnected;
  const freq = tel.freq_hz || 0;
  const active = freq > 0;

  const { string, cents } = active ? nearestString(freq) : { string: null, cents: 0 };
  const inTune = active && Math.abs(cents) <= IN_TUNE_CENTS;
  const flat = active && cents < -IN_TUNE_CENTS;
  const sharp = active && cents > IN_TUNE_CENTS;

  // Needle position: 0% (−range cents) .. 100% (+range cents), centered at 50%.
  const clamped = Math.max(-NEEDLE_RANGE, Math.min(NEEDLE_RANGE, cents));
  const needlePct = 50 + (clamped / NEEDLE_RANGE) * 50;

  return (
    <div className="tuner">
      <div className="meter-head">
        <span className="meter-label">Tuner — standard</span>
        {preview && <span className="preview-tag">PREVIEW</span>}
      </div>

      <div className={`tuner-readout${active ? "" : " idle"}`}>
        <div className="tuner-note">
          {active ? (
            <>
              {string.name}
              <sub>{string.octave}</sub>
            </>
          ) : (
            "–"
          )}
        </div>
        <div className="tuner-freq">
          {active ? `${freq.toFixed(1)} Hz` : "play a string"}
        </div>
      </div>

      <div className="tuner-gauge">
        <div className="tuner-track">
          <span className="tuner-tick flat">♭</span>
          <span className="tuner-center" />
          <span className="tuner-tick sharp">♯</span>
          {active && (
            <span
              className={`tuner-needle${inTune ? " in-tune" : ""}`}
              style={{ left: needlePct + "%" }}
            />
          )}
        </div>
        <div className="tuner-status">
          {!active && <span className="muted">listening…</span>}
          {flat && <span className="off">flat {Math.round(cents)}¢</span>}
          {sharp && <span className="off">sharp +{Math.round(cents)}¢</span>}
          {inTune && <span className="ok">in tune</span>}
        </div>
      </div>

      <div className="tuner-strings">
        {STRINGS.map((s, i) => (
          <span
            key={i}
            className={`tuner-string${active && s === string ? " sel" : ""}`}
          >
            {s.name}
            <sub>{s.octave}</sub>
          </span>
        ))}
      </div>
    </div>
  );
}
