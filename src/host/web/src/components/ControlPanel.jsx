import { RotateCcw } from "lucide-react";
import { PARAM_DEFS, RELEVANCE, DEFAULTS } from "../ampParams";
import Knob from "./Knob";
import EffectSelector from "./EffectSelector";
import DisplayScreen from "./DisplayScreen";
import TunerDisplay from "./TunerDisplay";

export default function ControlPanel({ params, patch, reset, highlight, tel }) {
  const relevant = new Set(RELEVANCE[params.effect] || []);
  const gainVal = params.gain ?? 15;
  const isTuner = params.effect === "tuner";

  return (
    <section className="panel controls">
      <DisplayScreen params={params} />

      <div className="panel-head">
        <h2>Control</h2>
        <button className="reset" onClick={reset} title="Reset all to defaults">
          <RotateCcw size={13} /> Default
        </button>
      </div>

      <EffectSelector
        value={params.effect}
        onChange={(fx) => patch({ effect: fx }, true)}
        highlight={highlight.has("effect")}
      />

      {isTuner ? (
        <TunerDisplay tel={tel} />
      ) : (
        <>
          <div className="knobs">
            {PARAM_DEFS.map((d) => (
              <Knob
                key={d.key}
                label={d.label}
                value={params[d.key]}
                min={d.min}
                max={d.max}
                dim={!relevant.has(d.key)}
                highlight={highlight.has(d.key)}
                onChange={(v) => patch({ [d.key]: v })}
                onReset={() => patch({ [d.key]: DEFAULTS[d.key] }, true)}
              />
            ))}
          </div>

          <div className="vga">
            <label className="toggle">
              <input
                type="checkbox"
                checked={params.auto_vga}
                onChange={(e) =>
                  patch(
                    e.target.checked
                      ? { auto_vga: true, gain: null }
                      : { auto_vga: false, gain: gainVal },
                    true
                  )
                }
              />
              <span className="switch" />
              Auto gain (VGA)
            </label>

            <div className={params.auto_vga ? "dimwrap" : ""}>
              <Knob
                label="Manual gain"
                value={gainVal}
                min={0}
                max={255}
                dim={params.auto_vga}
                highlight={highlight.has("gain")}
                onChange={(v) => !params.auto_vga && patch({ gain: v })}
                onReset={() => !params.auto_vga && patch({ gain: 15 }, true)}
              />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
