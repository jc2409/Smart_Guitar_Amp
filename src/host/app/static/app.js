// SF4 Smart Guitar Amp — two-panel UI.
// One shared `state` mirrors the backend AmpParams; both the manual knobs and
// the chat drive it. When the LLM changes the sound, the knobs turn to match.

const PARAM_DEFS = [
  { key: "drive",     label: "Drive",     min: 1, max: 511 },
  { key: "delay_len", label: "Delay",     min: 1, max: 512 },
  { key: "feedback",  label: "Feedback",  min: 0, max: 255 },
  { key: "mix",       label: "Mix",       min: 0, max: 255 },
  { key: "depth",     label: "Depth",     min: 1, max: 48 },
  { key: "rate",      label: "Rate",      min: 1, max: 20 },
];

const RELEVANCE = {
  clean:     [],
  overdrive: ["drive"],
  delay:     ["delay_len", "feedback", "mix"],
  chorus:    ["depth", "rate"],
  reverb:    ["feedback", "mix"],
};

// Defaults mirror the firmware / AmpParams defaults.
const DEFAULTS = {
  effect: "clean", drive: 180, delay_len: 400, feedback: 190,
  mix: 220, depth: 24, rate: 8, auto_vga: true, gain: null,
};

let state = { ...DEFAULTS };
const history = [];          // prior chat turns: {role, content}
let sendTimer = null;

const SWEEP = 270;           // degrees of knob travel

// ── Rotate a knob to reflect its input's current value ──────────────────────
function setKnob(key) {
  const input = document.getElementById(key);
  const knob = document.getElementById(`knob-${key}`);
  if (!input || !knob) return;
  const min = Number(input.min), max = Number(input.max);
  const frac = (Number(input.value) - min) / (max - min || 1);
  knob.style.setProperty("--angle", (-SWEEP / 2 + frac * SWEEP).toFixed(1) + "deg");
}

// ── Make a knob draggable (vertical) — drives the underlying range input ─────
function makeDraggable(knob, input) {
  let startY = 0, startVal = 0, dragging = false;
  const span = Number(input.max) - Number(input.min);
  const onMove = (e) => {
    if (!dragging) return;
    const y = (e.touches ? e.touches[0].clientY : e.clientY);
    const delta = (startY - y) * (span / 160);     // full sweep over ~160px
    let v = Math.round(startVal + delta);
    v = Math.max(Number(input.min), Math.min(Number(input.max), v));
    input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    e.preventDefault();
  };
  const onUp = () => {
    dragging = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  knob.addEventListener("pointerdown", (e) => {
    if (input.disabled) return;
    dragging = true;
    startY = e.clientY;
    startVal = Number(input.value);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    e.preventDefault();
  });
}

// ── Build manual knob cells ─────────────────────────────────────────────────
const knobsEl = document.getElementById("knobs");
for (const def of PARAM_DEFS) {
  const cell = document.createElement("div");
  cell.className = "knob-cell";
  cell.id = `cell-${def.key}`;
  cell.innerHTML = `
    <div class="knob" id="knob-${def.key}"><div class="knob-dial"></div></div>
    <label>${def.label}</label>
    <output id="${def.key}-val"></output>
    <input class="sr-only" type="range" id="${def.key}" min="${def.min}" max="${def.max}" />`;
  knobsEl.appendChild(cell);
  const slider = cell.querySelector("input");
  slider.addEventListener("input", () => {
    state[def.key] = Number(slider.value);
    document.getElementById(`${def.key}-val`).textContent = slider.value;
    setKnob(def.key);
    scheduleSend();
  });
  makeDraggable(cell.querySelector(".knob"), slider);
}

// Reset-to-default button
document.getElementById("reset-btn").addEventListener("click", () => {
  state = { ...DEFAULTS };
  syncUI();
  sendParams();
});

// Effect footswitches
document.querySelectorAll(".fx").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.effect = btn.dataset.effect;
    syncUI();
    sendParams();
  });
});

// Manual gain + auto-VGA
const autoVga = document.getElementById("auto_vga");
const gainSlider = document.getElementById("gain");
makeDraggable(document.getElementById("knob-gain"), gainSlider);
autoVga.addEventListener("change", () => {
  state.auto_vga = autoVga.checked;
  state.gain = autoVga.checked ? null : Number(gainSlider.value);
  syncUI();
  sendParams();
});
gainSlider.addEventListener("input", () => {
  state.gain = Number(gainSlider.value);
  document.getElementById("gain-val").textContent = gainSlider.value;
  setKnob("gain");
  scheduleSend();
});

// ── Render state into the controls ──────────────────────────────────────────
function syncUI() {
  document.querySelectorAll(".fx").forEach((b) =>
    b.classList.toggle("active", b.dataset.effect === state.effect));

  const relevant = new Set(RELEVANCE[state.effect] || []);
  for (const def of PARAM_DEFS) {
    const slider = document.getElementById(def.key);
    slider.value = state[def.key];
    document.getElementById(`${def.key}-val`).textContent = state[def.key];
    setKnob(def.key);
    document.getElementById(`cell-${def.key}`).classList.toggle("dim", !relevant.has(def.key));
  }

  autoVga.checked = state.auto_vga;
  gainSlider.disabled = state.auto_vga;
  document.getElementById("cell-gain").classList.toggle("dim", state.auto_vga);
  if (state.gain != null) {
    gainSlider.value = state.gain;
    document.getElementById("gain-val").textContent = state.gain;
  }
  setKnob("gain");
}

// ── Talk to the backend ─────────────────────────────────────────────────────
function payload() {
  return {
    effect: state.effect, drive: state.drive, delay_len: state.delay_len,
    feedback: state.feedback, mix: state.mix, depth: state.depth,
    rate: state.rate, auto_vga: state.auto_vga, gain: state.gain,
  };
}

function scheduleSend() {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(sendParams, 120);   // debounce knob drags
}

async function sendParams() {
  clearTimeout(sendTimer);
  try {
    const r = await fetch("/api/params", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload()),
    });
    if (r.ok) { state = await r.json(); }
  } catch (e) { /* offline; ignore */ }
}

async function loadState() {
  try {
    const r = await fetch("/api/state");
    if (r.ok) { state = await r.json(); syncUI(); }
  } catch (e) { /* ignore */ }
}

// ── Chat panel ──────────────────────────────────────────────────────────────
const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const chatText = document.getElementById("chat-text");
const chatSend = document.getElementById("chat-send");

function addMsg(text, cls) {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = chatText.value.trim();
  if (!message) return;
  chatText.value = "";
  addMsg(message, "user");
  chatSend.disabled = true;
  const thinking = addMsg("…", "assistant");

  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      thinking.remove();
      addMsg(err.detail || `Error ${r.status}`, "error");
      return;
    }
    const data = await r.json();
    thinking.textContent = data.reply;
    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: data.reply });
    if (data.changed) {
      state = data.params;
      syncUI();
      addMsg(`✓ updated · ${state.effect}`, "note");
    }
  } catch (e) {
    thinking.remove();
    addMsg("Network error.", "error");
  } finally {
    chatSend.disabled = false;
    chatText.focus();
  }
});

// ── Live telemetry (SSE) ────────────────────────────────────────────────────
const vuFill = document.getElementById("vu-fill");
const clipLed = document.getElementById("clip-led");
const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");
const vgaReadout = document.getElementById("vga-readout");

function startTelemetry() {
  const es = new EventSource("/api/telemetry");
  es.onmessage = (ev) => {
    const t = JSON.parse(ev.data);
    vuFill.style.width = Math.min(100, (t.peak / 512) * 100) + "%";
    clipLed.classList.toggle("on", !!t.clip);
    vgaReadout.textContent = t.vga;
    if (t.port === "mock") {
      connDot.className = "dot mock";
      connText.textContent = "mock board (no hardware)";
    } else if (t.connected) {
      connDot.className = "dot on";
      connText.textContent = `connected · ${t.port}`;
    } else {
      connDot.className = "dot";
      connText.textContent = "disconnected";
    }
  };
  es.onerror = () => { connDot.className = "dot"; connText.textContent = "reconnecting…"; };
}

// ── Boot ────────────────────────────────────────────────────────────────────
syncUI();        // render defaults immediately (knobs in position)
loadState();     // then reconcile with the backend
startTelemetry();
