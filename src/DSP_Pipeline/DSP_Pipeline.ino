/*
 * Arduino Uno R3 — Real-time guitar DSP
 *
 * Effects (select with 'e' command):
 *   0 = Clean      — transparent passthrough
 *   1 = Overdrive  — hard clipping
 *   2 = Delay      — single echo with feedback (~53 ms max)
 *   3 = Chorus     — triangle-LFO modulated short delay, 50/50 dry/wet
 *   4 = Reverb     — five-tap feedback network
 *
 * VGA (pin 9 / OC1A): gradual soft-limiter when too loud; gentle boost when
 *   too quiet but above the noise floor; drifts back to resting gain otherwise.
 *   Higher OCR1A = lower gain (optocoupler: brighter LED -> lower R_LDR).
 *
 * Shared audio ring buffer: 512 x int8_t = 512 B SRAM.
 *   Samples stored right-shifted by 2 (2 LSBs lost; matches 8-bit PWM output).
 *
 * ADC  : A0, free-running, prescaler 128 -> FS ~= 9.6 kHz
 *         Nyquist = 4.8 kHz, matches the analog anti-aliasing LPF cutoff exactly.
 *         Lower FS doubles the max delay/reverb time vs prescaler 64.
 * PWM  : pin 10 / OC1B, 8-bit Fast PWM, 62.5 kHz carrier -> RC filter -> out
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ─── Buffer ───────────────────────────────────────────────────────────────
#define BUF_SIZE   512
#define BUF_MASK  (BUF_SIZE - 1)
#define S_MIN    (-512)
#define S_MAX      511

// ─── Effect IDs ───────────────────────────────────────────────────────────
#define FX_CLEAN     0
#define FX_OVERDRIVE 1
#define FX_DELAY     2
#define FX_CHORUS    3
#define FX_REVERB    4
#define FX_TUNER     5   // clean passthrough + fundamental-pitch detection

// ─── Parameter bank (written by loop(), read by ISR) ──────────────────────
struct Params {
  uint8_t  effect;    // FX_*
  int16_t  thresh;    // overdrive: clip threshold (1..511)
  uint16_t delayLen;  // delay: tap distance in samples (1..512)
  uint8_t  feedback;  // delay/reverb: regeneration Q8 (0..255)
  uint8_t  mix;       // delay/reverb: wet level Q8 (0..255)
  uint8_t  depth;     // chorus: LFO modulation depth in samples (1..48)
  uint8_t  rate;      // chorus: LFO phase increment per sample (1..20)
};

volatile Params P = {
  FX_CLEAN,
  180,   // thresh    (drive level: 16=breakup, 180=rock, 480=metal)
  400,   // delayLen  (~41.6 ms at 9615 Hz — perceptible slapback)
  190,   // feedback
  220,   // mix
  24,    // depth
  8,     // rate  (~0.85 Hz LFO at 9615 Hz, same feel as rate=4 at 19230 Hz)
};

// ─── Shared audio ring buffer ─────────────────────────────────────────────
static int8_t   audioBuf[BUF_SIZE];
static uint16_t wIdx = 0;

// ─── Chorus LFO ───────────────────────────────────────────────────────────
static uint16_t lfoPhase = 0;

// ─── Telemetry / VGA ──────────────────────────────────────────────────────
volatile int16_t g_peak  = 0;
volatile uint8_t g_clip  = 0;
uint16_t         g_rxErr = 0;
bool             g_autoVGA = true;

// ─── Tuner ────────────────────────────────────────────────────────────────
// Detected fundamental in deci-Hz (Hz x 10); 0 = no pitch / not in tuner mode.
volatile uint16_t g_freqDeciHz = 0;

// ═══════════════════════════════════════════════════════════════════════════
//  processEffect — called from ADC ISR, one sample per call (~52 µs budget)
// ═══════════════════════════════════════════════════════════════════════════
static inline uint16_t processEffect(uint16_t in) {
  int16_t x = (int16_t)in - 512;   // 10-bit unsigned -> signed, centred at 0
  int16_t y = x;

  switch (P.effect) {

    // ── 1. Overdrive ────────────────────────────────────────────────────
    // Pre-amplify then hard-clip at full scale. thresh/16 is the gain factor:
    // thresh=16 -> 1x (just at breakup), thresh=180 -> 11x (rock/metal),
    // thresh=480 -> 30x (extreme saturation, near square wave).
    case FX_OVERDRIVE: {
      int32_t driven = (int32_t)x * P.thresh >> 4;
      if      (driven > S_MAX) { y = S_MAX; g_clip = 1; }
      else if (driven < S_MIN) { y = S_MIN; g_clip = 1; }
      else                       y = (int16_t)driven;
      break;
    }

    // ── 2. Delay ────────────────────────────────────────────────────────
    // Circular-buffer echo. Buffer stores input + feedback*echo;
    // output mixes dry + mix*echo.
    case FX_DELAY: {
      uint16_t dlen = P.delayLen;
      int16_t echo  = (int16_t)audioBuf[(wIdx - dlen) & BUF_MASK] << 2;

      int32_t outv  = (int32_t)x + (((int32_t)echo * P.mix)      >> 8);
      int32_t store = (int32_t)x + (((int32_t)echo * P.feedback)  >> 8);
      if (store > S_MAX) store = S_MAX;
      if (store < S_MIN) store = S_MIN;

      audioBuf[wIdx] = (int8_t)(store >> 2);
      wIdx = (wIdx + 1) & BUF_MASK;

      if (outv > S_MAX) outv = S_MAX;
      if (outv < S_MIN) outv = S_MIN;
      y = (int16_t)outv;
      break;
    }

    // ── 3. Chorus ───────────────────────────────────────────────────────
    // Triangle LFO sweeps the read tap between 48 and (48+depth) samples
    // behind the write head. Dry and wet mixed 50/50; no feedback path.
    case FX_CHORUS: {
      uint8_t tri = (lfoPhase < 32768u)
                    ? (uint8_t)(lfoPhase >> 7)
                    : (uint8_t)((65535u - lfoPhase) >> 7);
      lfoPhase += P.rate;

      uint16_t tapDist = 48u + (((uint16_t)tri * P.depth) >> 8);
      int16_t wet = (int16_t)audioBuf[(wIdx - tapDist) & BUF_MASK] << 2;

      audioBuf[wIdx] = (int8_t)(x >> 2);
      wIdx = (wIdx + 1) & BUF_MASK;

      y = (x >> 1) + (wet >> 1);
      break;
    }

    // ── 4. Reverb ───────────────────────────────────────────────────────
    // Ten equal-weight taps spanning 7.6–50.7 ms at 9615 Hz.
    // Equal weights (each 1/8, computed as sum>>3) create a dense reflection
    // pattern rather than 5 discrete echoes — this is what makes it sound
    // like reverb instead of EQ coloring.
    // Stability: loop gain = 10 * (1/8) * feedback/256 < 1 → feedback < 205.
    // Default feedback=190 gives ~300 ms half-life (medium room).
    case FX_REVERB: {
      int16_t t1  = (int16_t)audioBuf[(wIdx -  73u) & BUF_MASK] << 2;
      int16_t t2  = (int16_t)audioBuf[(wIdx -  97u) & BUF_MASK] << 2;
      int16_t t3  = (int16_t)audioBuf[(wIdx - 127u) & BUF_MASK] << 2;
      int16_t t4  = (int16_t)audioBuf[(wIdx - 163u) & BUF_MASK] << 2;
      int16_t t5  = (int16_t)audioBuf[(wIdx - 211u) & BUF_MASK] << 2;
      int16_t t6  = (int16_t)audioBuf[(wIdx - 271u) & BUF_MASK] << 2;
      int16_t t7  = (int16_t)audioBuf[(wIdx - 337u) & BUF_MASK] << 2;
      int16_t t8  = (int16_t)audioBuf[(wIdx - 397u) & BUF_MASK] << 2;
      int16_t t9  = (int16_t)audioBuf[(wIdx - 457u) & BUF_MASK] << 2;
      int16_t t10 = (int16_t)audioBuf[(wIdx - 487u) & BUF_MASK] << 2;
      int16_t rev = (int16_t)(
        ((int32_t)t1+t2+t3+t4+t5+t6+t7+t8+t9+t10) >> 3);

      int32_t store = (int32_t)x + (((int32_t)rev * P.feedback) >> 8);
      if (store > S_MAX) store = S_MAX;
      if (store < S_MIN) store = S_MIN;
      audioBuf[wIdx] = (int8_t)(store >> 2);
      wIdx = (wIdx + 1) & BUF_MASK;

      int32_t outv = (int32_t)x + (((int32_t)rev * P.mix) >> 8);
      if (outv > S_MAX) outv = S_MAX;
      if (outv < S_MIN) outv = S_MIN;
      y = (int16_t)outv;
      break;
    }

    // ── 5. Tuner ──────────────────────────────────────────────────────────
    // Audible output is clean passthrough (y = x); meanwhile the raw signal is
    // logged into the ring buffer so loop() can run AMDF pitch detection on it.
    case FX_TUNER: {
      audioBuf[wIdx] = (int8_t)(x >> 2);
      wIdx = (wIdx + 1) & BUF_MASK;
      // y stays = x (clean)
      break;
    }
  }

  // Track post-effect peak so AGC responds to what the listener actually hears
  int16_t ay = (y < 0) ? -y : y;
  if (ay > g_peak) g_peak = ay;

  int16_t out = y + 512;
  if (out > 1023) out = 1023;
  if (out < 0)    out = 0;
  return (uint16_t)out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  setup
// ═══════════════════════════════════════════════════════════════════════════
void setup() {
  pinMode(A0, INPUT);
  pinMode(10, OUTPUT);   // audio PWM out (OC1B)
  pinMode( 9, OUTPUT);   // VGA PWM out   (OC1A)

  Serial.begin(115200);
  Serial.println(F("SF4 DSP v2  [0=clean 1=overdrive 2=delay 3=chorus 4=reverb 5=tuner]"));
  Serial.println(F("  e<0-5>    select effect           x         bypass"));
  Serial.println(F("  c<16-511> overdrive drive          v<0|1>    auto-VGA"));
  Serial.println(F("  d<1-512>  delay samples           g<0-255>  manual gain"));
  Serial.println(F("  f<0-255>  feedback / decay"));
  Serial.println(F("  m<0-255>  wet mix"));
  Serial.println(F("  r<1-48>   chorus depth (samples)"));
  Serial.println(F("  s<1-20>   chorus LFO rate"));
  Serial.println(F("  P,e,drv,dl,fb,mix,dp,rt,av,gain  atomic set-all (gain<0=keep)"));
  Serial.println(F("Telemetry: T,effect,peak,vga,clip,rxErr,freqDeciHz (freq in tuner mode)"));

  // ADC: free-running on A0, interrupt on completion, prescaler 128 -> ~9.6 kHz
  ADMUX  = (1 << REFS0);
  ADCSRB = 0;
  DIDR0  = (1 << ADC0D);
  ADCSRA = (1 << ADEN) | (1 << ADATE) | (1 << ADIE)
         | (1 << ADPS2) | (1 << ADPS1) | (1 << ADPS0)
         | (1 << ADSC);

  // Timer1: Mode 5 (8-bit Fast PWM), no prescaler -> 62.5 kHz carrier
  TCCR1A = (1 << COM1A1) | (1 << COM1B1) | (1 << WGM10);
  TCCR1B = (1 << WGM12)  | (1 << CS10);
  OCR1B  = 128;
  OCR1A  =  15;
  TIMSK1 =   0;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Command handler
// ═══════════════════════════════════════════════════════════════════════════
static void handleCmd(char cmd, const char *arg) {
  long v = atol(arg);
  switch (cmd) {

    case 'e': {
      uint8_t fx = (uint8_t)constrain(v, FX_CLEAN, FX_TUNER);
      noInterrupts();
      memset(audioBuf, 0, sizeof(audioBuf));
      wIdx = 0; lfoPhase = 0;
      P.effect = fx;
      interrupts();
      Serial.print(F(">> effect   = ")); Serial.println(fx);
      break;
    }
    case 'c':
      noInterrupts(); P.thresh   = (int16_t)constrain(v, 1, 511);       interrupts();
      Serial.print(F(">> thresh   = ")); Serial.println(P.thresh);   break;
    case 'd':
      noInterrupts(); P.delayLen = (uint16_t)constrain(v, 1, BUF_SIZE); interrupts();
      Serial.print(F(">> delayLen = ")); Serial.println(P.delayLen); break;
    case 'f':
      noInterrupts(); P.feedback = (uint8_t)constrain(v, 0, 255);       interrupts();
      Serial.print(F(">> feedback = ")); Serial.println(P.feedback); break;
    case 'm':
      noInterrupts(); P.mix      = (uint8_t)constrain(v, 0, 255);       interrupts();
      Serial.print(F(">> mix      = ")); Serial.println(P.mix);      break;
    case 'r':
      noInterrupts(); P.depth    = (uint8_t)constrain(v, 1, 48);        interrupts();
      Serial.print(F(">> depth    = ")); Serial.println(P.depth);    break;
    case 's':
      noInterrupts(); P.rate     = (uint8_t)constrain(v, 1, 20);        interrupts();
      Serial.print(F(">> rate     = ")); Serial.println(P.rate);     break;
    case 'v':
      g_autoVGA = (v != 0);
      Serial.print(F(">> autoVGA  = ")); Serial.println(g_autoVGA ? F("ON") : F("OFF")); break;
    case 'g':
      OCR1A = (uint8_t)constrain(v, 0, 255);
      g_autoVGA = false;
      Serial.print(F(">> VGA gain = ")); Serial.println(OCR1A);     break;
    case 'x':
      noInterrupts();
      memset(audioBuf, 0, sizeof(audioBuf));
      wIdx = 0; lfoPhase = 0;
      P.effect = FX_CLEAN;
      interrupts();
      Serial.println(F(">> bypass (clean)"));                         break;

    // ── Atomic set-all frame (host link) ─────────────────────────────────
    // P,<effect>,<drive>,<delayLen>,<feedback>,<mix>,<depth>,<rate>,<autoVGA>,<gain>
    // Applies the whole parameter bank in one cli/sei section so the ISR never
    // reads a half-updated mix of old + new values. gain < 0 leaves the VGA
    // (and auto-VGA mode) untouched; gain >= 0 sets manual gain + auto-VGA off.
    case 'P': {
      int e, drv, dl, fb, mx, dp, rt, av, gn;
      if (sscanf(arg, ",%d,%d,%d,%d,%d,%d,%d,%d,%d",
                 &e, &drv, &dl, &fb, &mx, &dp, &rt, &av, &gn) != 9) {
        g_rxErr++;
        break;
      }
      uint8_t  fx       = (uint8_t)constrain(e,   FX_CLEAN, FX_TUNER);
      int16_t  thresh   = (int16_t)constrain(drv, 1, 511);
      uint16_t delayLen = (uint16_t)constrain(dl, 1, BUF_SIZE);
      uint8_t  feedback = (uint8_t)constrain(fb,  0, 255);
      uint8_t  mix      = (uint8_t)constrain(mx,  0, 255);
      uint8_t  depth    = (uint8_t)constrain(dp,  1, 48);
      uint8_t  rate     = (uint8_t)constrain(rt,  1, 20);

      noInterrupts();
      memset(audioBuf, 0, sizeof(audioBuf));   // effect may change → clear history
      wIdx = 0; lfoPhase = 0;
      P.effect   = fx;
      P.thresh   = thresh;
      P.delayLen = delayLen;
      P.feedback = feedback;
      P.mix      = mix;
      P.depth    = depth;
      P.rate     = rate;
      interrupts();

      if (gn >= 0) {                            // explicit manual gain
        OCR1A = (uint8_t)constrain(gn, 0, 255);
        g_autoVGA = false;
      } else {                                  // -1 sentinel: honour autoVGA flag
        g_autoVGA = (av != 0);
      }
      Serial.print(F(">> set effect=")); Serial.print(fx);
      Serial.print(F(" drive="));        Serial.print(thresh);
      Serial.print(F(" autoVGA="));      Serial.println(g_autoVGA ? F("ON") : F("OFF"));
      break;
    }

    default:
      g_rxErr++;
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tuner — AMDF pitch detection (runs in loop(), never the ISR)
// ═══════════════════════════════════════════════════════════════════════════
//  D(tau) = sum_{n=0..WIN-1} | buf[i-n] - buf[i-n-tau] |  is minimised over the
//  guitar lag range. The deepest dip is the fundamental period; parabolic
//  interpolation around it recovers sub-sample resolution (essential for the
//  high strings, where one whole-sample step is tens of cents at FS 9615 Hz).
#define TUNER_TAU_MIN  24     // ~400 Hz upper search bound
#define TUNER_TAU_MAX  128    // ~75 Hz lower search bound
#define TUNER_WIN      256    // comparison window length in samples
#define TUNER_SPAN    (TUNER_WIN + TUNER_TAU_MAX)  // samples the AMDF reaches back
#define TUNER_NOISE    12     // post-effect peak below this = treat as silence
#define FS_HZ          9615.0f

// The detector works on a frozen copy of the most recent TUNER_SPAN samples.
// Copying out of the live ring first is essential: the ISR keeps writing at
// ~9.6 kHz, so an in-place AMDF (tens of ms) would read samples that get
// overwritten mid-computation and smear the result.
static int8_t tunerSnap[TUNER_SPAN];   // tunerSnap[0] = newest, [k] = k samples older

// AMDF for one lag over the frozen snapshot (plain linear indexing).
static uint32_t amdf(uint16_t tau) {
  uint32_t d = 0;
  for (uint16_t n = 0; n < TUNER_WIN; n++) {
    int16_t diff = (int16_t)tunerSnap[n] - (int16_t)tunerSnap[n + tau];
    d += (diff < 0) ? (uint16_t)(-diff) : (uint16_t)diff;
  }
  return d;
}

static void detectPitch() {
  noInterrupts();
  int16_t peak = g_peak;
  interrupts();
  if (peak < TUNER_NOISE) { g_freqDeciHz = 0; return; }   // nothing plucked

  // Freeze the window: copy newest-first from the ring. ~384 byte reads finish
  // in well under one sample period of drift, so the snapshot is coherent.
  uint16_t i = wIdx;
  for (uint16_t k = 0; k < TUNER_SPAN; k++)
    tunerSnap[k] = audioBuf[(uint16_t)(i - 1 - k) & BUF_MASK];

  uint32_t bestD = 0xFFFFFFFFUL, sumD = 0;
  uint16_t bestTau = 0, count = 0;

  for (uint16_t tau = TUNER_TAU_MIN; tau <= TUNER_TAU_MAX; tau++, count++) {
    uint32_t d = amdf(tau);
    sumD += d;
    if (d < bestD) { bestD = d; bestTau = tau; }
  }

  // Reject if the dip isn't clearly below the mean (unvoiced / noisy), or if it
  // landed on a search boundary (can't interpolate / likely out of range).
  uint32_t mean = sumD / count;
  if (bestD * 2 > mean || bestTau <= TUNER_TAU_MIN || bestTau >= TUNER_TAU_MAX) {
    g_freqDeciHz = 0;
    return;
  }

  // Parabolic interpolation around the minimum for a sub-sample period.
  float d0 = (float)amdf(bestTau - 1);
  float d1 = (float)bestD;
  float d2 = (float)amdf(bestTau + 1);
  float denom = d0 - 2.0f * d1 + d2;
  float delta = (denom > 0.0f) ? 0.5f * (d0 - d2) / denom : 0.0f;
  float tauR  = (float)bestTau + delta;

  float f = FS_HZ / tauR;
  g_freqDeciHz = (uint16_t)(f * 10.0f + 0.5f);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main loop — serial parser + VGA
// ═══════════════════════════════════════════════════════════════════════════
void loop() {
  static char    line[48];   // wide enough for the atomic 'P' set-all frame
  static uint8_t llen = 0;

  // Serial command parser
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (llen > 0) {
        line[llen] = '\0';
        char *p = line;
        while (*p == ' ') p++;
        if (*p) handleCmd(*p, p + 1);
        llen = 0;
      }
    } else if (llen < (uint8_t)(sizeof(line) - 1)) {
      line[llen++] = ch;
    }
  }

  uint32_t now = millis();
  static uint32_t lastVGA   = 0;
  static uint32_t lastTelem = 0;
  static uint32_t lastTuner = 0;
  static int16_t  telemPeak = 0;

  // ── Tuner pitch detection (every 150 ms, tuner mode only) ───────────────
  if (P.effect == FX_TUNER) {
    if (now - lastTuner >= 150) { lastTuner = now; detectPitch(); }
  } else {
    g_freqDeciHz = 0;
  }

  // ── VGA loop (every 15 ms) ──────────────────────────────────────────────
  // One OCR1A step per tick: smooth gain rides with no pumping.
  // Noise floor guard prevents boosting silence into audible hiss.
  if (now - lastVGA >= 15) {
    lastVGA = now;

    noInterrupts();
    int16_t peak = g_peak;
    g_peak = 0;
    interrupts();

    if (peak > telemPeak) telemPeak = peak;

    if (g_autoVGA) {
      const int16_t VGA_HIGH  = 380;   // reduce gain above this peak
      const int16_t VGA_LOW   =  40;   // boost gain below this peak
      const int16_t VGA_NOISE =   8;   // silence floor — never boost below
      const uint8_t VGA_DEF   =  15;   // resting OCR1A (sweet-spot gain)
      const uint8_t VGA_MAX   =  80;   // max attenuation ceiling

      if (peak > VGA_HIGH) {
        if (OCR1A < VGA_MAX) OCR1A++;          // too loud  → step gain down
      } else if (peak > VGA_NOISE && peak < VGA_LOW) {
        if (OCR1A > 0)       OCR1A--;          // too quiet → step gain up
      } else {
        if      (OCR1A > VGA_DEF) OCR1A--;     // in range / silent → drift to resting
        else if (OCR1A < VGA_DEF) OCR1A++;
      }
    }
  }

  // ── Telemetry (every 100 ms) ────────────────────────────────────────────
  if (now - lastTelem >= 100) {
    lastTelem = now;
    uint8_t  clip;
    uint16_t freq;
    noInterrupts(); clip = g_clip; g_clip = 0; freq = g_freqDeciHz; interrupts();

    Serial.print(F("T,")); Serial.print(P.effect);
    Serial.print(',');      Serial.print(telemPeak);
    Serial.print(',');      Serial.print(OCR1A);
    Serial.print(',');      Serial.print(clip);
    Serial.print(',');      Serial.print(g_rxErr);
    Serial.print(',');      Serial.println(freq);

    telemPeak = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ADC ISR — fires at ~9.6 kHz
// ═══════════════════════════════════════════════════════════════════════════
ISR(ADC_vect) {
  OCR1B = (uint8_t)(processEffect(ADC) >> 2);
}
