import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Mic, Send, Square } from "lucide-react";
import { SUGGESTIONS } from "../ampParams";

let uid = 0;

const WAKE_PATTERN = /\b(hay|hey)\s+(amp|app)\b/;
const SILENCE_MS = 3200;
const MIN_COMMAND_MS = 1400;
const MAX_COMMAND_MS = 18000;
const WAKE_CHUNK_MS = 1700;

function normalizeSpeech(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasWakePhrase(value) {
  return WAKE_PATTERN.test(normalizeSpeech(value));
}

function stripWakePhrase(value) {
  return normalizeSpeech(value)
    .replace(/\b(hay|hey)\s+(amp|app)\b/, "")
    .trim();
}

export default function Chat({ onSend }) {
  const [messages, setMessages] = useState([
    {
      id: uid++,
      role: "assistant",
      content:
        "What effect do you want?",
    },
  ]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [voicePhase, setVoicePhase] = useState("off");
  const [volume, setVolume] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState("");

  const historyRef = useRef([]);
  const scrollRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const timeDataRef = useRef(null);
  const animFrameRef = useRef(null);
  const recognitionRef = useRef(null);
  const wakeRecorderRef = useRef(null);
  const wakeTimerRef = useRef(null);
  const wakeChunksRef = useRef([]);
  const wakeSpeechSeenRef = useRef(false);
  const wakeCheckingRef = useRef(false);
  const micEnabledRef = useRef(false);
  const voicePhaseRef = useRef("off");
  const volumeRef = useRef(0);
  const noiseFloorRef = useRef(0.018);
  const silenceSinceRef = useRef(null);
  const commandStartedAtRef = useRef(0);
  const discardRecordingRef = useRef(false);
  const requireWakeRef = useRef(true);
  const liveFinalRef = useRef("");

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    micEnabledRef.current = micEnabled;
  }, [micEnabled]);

  useEffect(() => {
    voicePhaseRef.current = voicePhase;
  }, [voicePhase]);

  useEffect(() => () => stopVoiceMode(), []);

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

  const transcribe = async (blob, options = {}) => {
    const fd = new FormData();
    fd.append("audio", blob, "recording.webm");
    if (options.prompt) fd.append("prompt", options.prompt);
    if (options.language) fd.append("language", options.language);
    const res = await fetch("/api/transcribe", { method: "POST", body: fd });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || "Voice transcription failed.");
    }
    const { text: transcript } = await res.json();
    return transcript?.trim() || "";
  };

  const stopLivePreview = () => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onend = null;
      try { recognition.stop(); } catch {}
    }
  };

  const startLivePreview = () => {
    stopLivePreview();
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return;

    liveFinalRef.current = "";
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i][0]?.transcript || "";
        if (event.results[i].isFinal) liveFinalRef.current += ` ${piece}`;
        else interim += ` ${piece}`;
      }
      setLiveTranscript(`${liveFinalRef.current} ${interim}`.replace(/\s+/g, " ").trim());
    };
    recognition.onerror = () => {};
    recognition.onend = () => {
      if (voicePhaseRef.current === "command") {
        window.setTimeout(startLivePreview, 200);
      }
    };
    recognitionRef.current = recognition;
    try { recognition.start(); } catch {}
  };

  const stopWakeDetection = () => {
    clearTimeout(wakeTimerRef.current);
    wakeTimerRef.current = null;
    const recorder = wakeRecorderRef.current;
    wakeRecorderRef.current = null;
    if (recorder?.state === "recording") {
      try { recorder.stop(); } catch {}
    }
    wakeChunksRef.current = [];
  };

  const runWakeCheck = async (blob) => {
    if (!micEnabledRef.current || voicePhaseRef.current !== "wake" || blob.size < 1000) return;
    wakeCheckingRef.current = true;
    try {
      const transcript = await transcribe(blob, {
        language: "en",
        prompt: "The wake phrase is: hey amp.",
      });
      if (hasWakePhrase(transcript) && micEnabledRef.current) {
        setLiveTranscript("");
        startCommandRecording(false);
        return;
      }
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: uid++, role: "error", content: e.message || "Wake transcription failed." },
      ]);
    } finally {
      wakeCheckingRef.current = false;
      if (micEnabledRef.current && voicePhaseRef.current === "wake") {
        window.setTimeout(startWakeDetection, 120);
      }
    }
  };

  const startWakeDetection = () => {
    if (!streamRef.current || !micEnabledRef.current || voicePhaseRef.current !== "wake") return;
    if (wakeCheckingRef.current) return;
    stopWakeDetection();
    wakeChunksRef.current = [];
    wakeSpeechSeenRef.current = false;
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    const recorder = mimeType
      ? new MediaRecorder(streamRef.current, { mimeType })
      : new MediaRecorder(streamRef.current);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) wakeChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      wakeRecorderRef.current = null;
      if (!micEnabledRef.current || voicePhaseRef.current !== "wake") return;
      const blob = new Blob(wakeChunksRef.current, { type: recorder.mimeType || "audio/webm" });
      const heardSpeech = wakeSpeechSeenRef.current;
      wakeChunksRef.current = [];
      wakeSpeechSeenRef.current = false;
      if (heardSpeech) runWakeCheck(blob);
      else window.setTimeout(startWakeDetection, 80);
    };
    wakeRecorderRef.current = recorder;
    recorder.start(250);
    wakeTimerRef.current = window.setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, WAKE_CHUNK_MS);
  };

  const stopCommandRecording = (discard = false) => {
    const recorder = mediaRecorderRef.current;
    discardRecordingRef.current = discard;
    if (recorder?.state === "recording") recorder.stop();
  };

  const startCommandRecording = (requireWake = true) => {
    if (!streamRef.current || voicePhaseRef.current === "command") return;
    stopWakeDetection();
    requireWakeRef.current = requireWake;
    setLiveTranscript("");
    chunksRef.current = [];
    silenceSinceRef.current = null;
    commandStartedAtRef.current = performance.now();
    discardRecordingRef.current = false;

    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    const recorder = mimeType
      ? new MediaRecorder(streamRef.current, { mimeType })
      : new MediaRecorder(streamRef.current);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      mediaRecorderRef.current = null;
      if (discardRecordingRef.current) return;
      stopLivePreview();
      setVoicePhase("processing");
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      try {
        if (blob.size > 1200) {
          const transcript = await transcribe(blob);
          const command = requireWakeRef.current ? stripWakePhrase(transcript) : transcript;
          if (!requireWakeRef.current || hasWakePhrase(transcript)) {
            if (command) await submit(command);
          }
        }
      } catch (e) {
        setMessages((m) => [
          ...m,
          { id: uid++, role: "error", content: e.message || "Voice transcription failed." },
        ]);
      } finally {
        chunksRef.current = [];
        setLiveTranscript("");
        if (micEnabledRef.current) {
          setVoicePhase("wake");
          voicePhaseRef.current = "wake";
          window.setTimeout(startWakeDetection, 300);
        } else {
          setVoicePhase("off");
        }
      }
    };

    mediaRecorderRef.current = recorder;
    recorder.start(250);
    setVoicePhase("command");
    voicePhaseRef.current = "command";
    startLivePreview();
  };

  const monitorInput = () => {
    const analyser = analyserRef.current;
    const data = timeDataRef.current;
    if (analyser && data) {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const sample of data) {
        const centered = (sample - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / data.length);
      const display = Math.min(1, rms * 9);
      const smoothed = volumeRef.current * 0.55 + display * 0.45;
      volumeRef.current = smoothed;
      setVolume(smoothed);

      if (voicePhaseRef.current === "wake") {
        noiseFloorRef.current = noiseFloorRef.current * 0.98 + Math.min(rms, 0.08) * 0.02;
        const wakeThreshold = Math.max(0.018, noiseFloorRef.current * 1.9);
        if (rms > wakeThreshold) wakeSpeechSeenRef.current = true;
      }

      if (voicePhaseRef.current === "command") {
        const now = performance.now();
        const threshold = Math.max(0.028, noiseFloorRef.current * 2.7);
        if (rms > threshold) {
          silenceSinceRef.current = null;
        } else if (silenceSinceRef.current === null) {
          silenceSinceRef.current = now;
        }

        const commandMs = now - commandStartedAtRef.current;
        if (commandMs > MAX_COMMAND_MS) stopCommandRecording();
        if (
          commandMs > MIN_COMMAND_MS &&
          silenceSinceRef.current !== null &&
          now - silenceSinceRef.current > SILENCE_MS
        ) {
          stopCommandRecording();
        }
      }
    }
    animFrameRef.current = requestAnimationFrame(monitorInput);
  };

  const startVoiceMode = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      analyserRef.current = analyser;
      timeDataRef.current = new Uint8Array(analyser.fftSize);

      setMicEnabled(true);
      micEnabledRef.current = true;
      setVoicePhase("wake");
      voicePhaseRef.current = "wake";
      animFrameRef.current = requestAnimationFrame(monitorInput);
      startWakeDetection();
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: uid++, role: "error", content: e.message || "Microphone access denied." },
      ]);
      stopVoiceMode();
    }
  };

  function stopVoiceMode() {
    micEnabledRef.current = false;
    setMicEnabled(false);
    setVoicePhase("off");
    voicePhaseRef.current = "off";
    setVolume(0);
    setLiveTranscript("");
    cancelAnimationFrame(animFrameRef.current);
    stopLivePreview();
    stopWakeDetection();
    stopCommandRecording(true);
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    timeDataRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  const voiceText = {
    wake: 'Listening for "Hey amp"',
    command: liveTranscript || "Listening",
    processing: liveTranscript || "Processing",
    off: "Voice off",
  }[voicePhase];

  const voiceBusy = voicePhase === "command" || voicePhase === "processing";

  return (
    <section className="panel chat">
      <h2>Talk to the amp</h2>

      {micEnabled && (
        <button
          type="button"
          className={`voice-monitor ${voicePhase}`}
          onClick={() => voicePhase === "wake" && startCommandRecording(false)}
        >
          <div className="voice-orb-wrap">
            <div className="voice-ring" />
            <div className="voice-ring" />
            <motion.div
              className="voice-orb"
              animate={{ scale: 1 + volume * 0.35 }}
              transition={{ type: "spring", stiffness: 520, damping: 28 }}
            />
          </div>
          <span className="voice-hint">{voiceText}</span>
        </button>
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
            disabled={sending || voiceBusy}
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
          placeholder={micEnabled ? 'Say "Hey amp" and ask, or tap voice bar…' : "Describe a sound…"}
          autoComplete="off"
          disabled={voiceBusy}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={sending || !text.trim() || voiceBusy}>
          <Send size={16} />
        </button>
        <button
          type="button"
          className={`mic-btn ${micEnabled ? "active" : ""}`}
          onClick={micEnabled ? stopVoiceMode : startVoiceMode}
          disabled={sending && !micEnabled}
          title={micEnabled ? "Disable voice" : "Enable voice"}
        >
          {micEnabled ? <Square size={15} fill="currentColor" /> : <Mic size={16} />}
        </button>
      </form>
    </section>
  );
}
