import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Mic, Send, Square } from "lucide-react";
import { SUGGESTIONS } from "../ampParams";

let uid = 0;

export default function Chat({ onSend }) {
  const [messages, setMessages] = useState([
    {
      id: uid++,
      role: "assistant",
      content:
        "Tell me a tone, a song, or an artist — e.g. “warm bluesy overdrive” or “Gilmour on Comfortably Numb”.",
    },
  ]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [volume, setVolume] = useState(0);

  const historyRef = useRef([]);
  const scrollRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const animFrameRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const submit = async (raw) => {
    const message = raw.trim();
    if (!message || sending) return;
    setText("");
    setMessages((m) => [...m, { id: uid++, role: "user", content: message }]);
    setSending(true);
    try {
      const data = await onSend(message, historyRef.current);
      historyRef.current = [
        ...historyRef.current,
        { role: "user", content: message },
        { role: "assistant", content: data.reply },
      ];
      setMessages((m) => [
        ...m,
        { id: uid++, role: "assistant", content: data.reply },
        ...(data.changed
          ? [{ id: uid++, role: "note", content: `updated · ${data.params.effect}` }]
          : []),
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: uid++, role: "error", content: e.message || "Something went wrong." },
      ]);
    } finally {
      setSending(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const freqData = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(freqData);
        const rms =
          Math.sqrt(freqData.reduce((s, v) => s + v * v, 0) / freqData.length) / 128;
        setVolume(Math.min(1, rms * 2));
        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);

      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const fd = new FormData();
        fd.append("audio", blob, "recording.webm");
        try {
          const res = await fetch("/api/transcribe", { method: "POST", body: fd });
          if (!res.ok) throw new Error(await res.text());
          const { text: transcript } = await res.json();
          if (transcript?.trim()) submit(transcript.trim());
        } catch {
          setMessages((m) => [
            ...m,
            { id: uid++, role: "error", content: "Voice transcription failed." },
          ]);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setMessages((m) => [
        ...m,
        { id: uid++, role: "error", content: "Microphone access denied." },
      ]);
    }
  };

  const stopRecording = () => {
    setRecording(false);
    setVolume(0);
    cancelAnimationFrame(animFrameRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close().catch(() => {});
    mediaRecorderRef.current?.stop();
  };

  return (
    <section className="panel chat">
      <h2>Talk to the amp</h2>

      {recording && (
        <div className="voice-overlay">
          <div className="voice-orb-wrap">
            <div className="voice-ring" />
            <div className="voice-ring" />
            <div className="voice-ring" />
            <motion.div
              className="voice-orb"
              animate={{ scale: 1 + volume * 0.5 }}
              transition={{ type: "spring", stiffness: 400, damping: 18 }}
            />
          </div>
          <span className="voice-hint">Listening…</span>
          <button type="button" className="voice-stop" onClick={stopRecording}>
            <Square size={15} fill="currentColor" />
            Stop
          </button>
        </div>
      )}

      <div className="messages" ref={scrollRef}>
        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <motion.div
              key={m.id}
              className={`msg ${m.role}`}
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.22 }}
            >
              {m.content}
            </motion.div>
          ))}
        </AnimatePresence>
        {sending && (
          <div className="msg assistant typing">
            <span /><span /><span />
          </div>
        )}
      </div>

      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            className="chip"
            disabled={sending || recording}
            onClick={() => submit(s)}
          >
            {s}
          </button>
        ))}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <input
          type="text"
          value={text}
          placeholder="Describe a sound…"
          autoComplete="off"
          disabled={recording}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={sending || !text.trim() || recording}>
          <Send size={16} />
        </button>
        <button
          type="button"
          className="mic-btn"
          onClick={startRecording}
          disabled={sending || recording}
          title="Voice input"
        >
          <Mic size={16} />
        </button>
      </form>
    </section>
  );
}
