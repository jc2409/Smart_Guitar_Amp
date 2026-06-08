import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { getState, setParams as apiSetParams, chat as apiChat } from "./api";
import { DEFAULTS, changedKeys } from "./ampParams";
import { useTelemetry } from "./hooks/useTelemetry";
import Faceplate from "./components/Faceplate";
import ConnectionBanner from "./components/ConnectionBanner";
import ControlPanel from "./components/ControlPanel";
import Chat from "./components/Chat";

const ACCENTS = ["amber", "blue", "green"];

export default function App() {
  const [params, setParams] = useState(DEFAULTS);
  const [highlight, setHighlight] = useState(new Set());
  const [accent, setAccent] = useState(
    () => localStorage.getItem("sf4-accent") || "amber"
  );
  const { tel } = useTelemetry();

  const commitTimer = useRef(null);
  const hlTimer = useRef(null);

  // Persist + apply accent theme.
  useEffect(() => {
    localStorage.setItem("sf4-accent", accent);
  }, [accent]);

  // Reconcile with the backend on load.
  useEffect(() => {
    getState().then(setParams).catch(() => {});
  }, []);

  // Push params to the backend (debounced), then reconcile with its clamped reply.
  const commit = useCallback((next, now = false) => {
    clearTimeout(commitTimer.current);
    const send = () =>
      apiSetParams(next).then(setParams).catch(() => {});
    if (now) send();
    else commitTimer.current = setTimeout(send, 120);
  }, []);

  // Optimistic local update + scheduled commit.
  const patch = useCallback(
    (partial, now = false) => {
      setParams((prev) => {
        const next = { ...prev, ...partial };
        commit(next, now);
        return next;
      });
    },
    [commit]
  );

  const reset = useCallback(() => {
    setParams(DEFAULTS);
    commit(DEFAULTS, true);
  }, [commit]);

  const pulse = useCallback((keys) => {
    if (!keys.size) return;
    setHighlight(keys);
    clearTimeout(hlTimer.current);
    hlTimer.current = setTimeout(() => setHighlight(new Set()), 1500);
  }, []);

  // Chat: send a turn; if it changed the sound, adopt + pulse the changed knobs.
  const sendChat = useCallback(
    async (message, history) => {
      const data = await apiChat(message, history);
      if (data.changed) {
        setParams((prev) => {
          pulse(changedKeys(prev, data.params));
          return data.params;
        });
      }
      return data;
    },
    [pulse]
  );

  return (
    <div className="app" data-accent={accent}>
      <div className="ambient" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />

      <motion.div
        className="chassis"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.2, 0.7, 0.2, 1] }}
      >
        <Faceplate
          tel={tel}
          accent={accent}
          accents={ACCENTS}
          onAccent={setAccent}
        />
        <ConnectionBanner tel={tel} />

        <main className="layout">
          <ControlPanel
            params={params}
            patch={patch}
            reset={reset}
            highlight={highlight}
            tel={tel}
          />
          <Chat onSend={sendChat} effect={params.effect} />
        </main>
      </motion.div>
    </div>
  );
}
