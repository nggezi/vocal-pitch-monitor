/* ═══════════════════════════════════════════
   VOCAL STUDIO — Engine
   ═══════════════════════════════════════════ */

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

/* ─── DOM ─── */
const startButton = $("#startButton");
const stopButton = $("#stopButton");
const statusText = $("#status");
const noteName = $("#noteName");
const frequencyValue = $("#frequencyValue");
const centsText = $("#centsText");
const targetFrequency = $("#targetFrequency");
const stability = $("#stability");
const volume = $("#volume");
const needle = $("#needle");
const pitchRoll = $("#pitchRoll");
const clearRollButton = $("#clearRollButton");
const rollCtx = pitchRoll.getContext("2d");

/* ─── Constants ─── */
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const RANGES = {
  bass:     { min: 36, max: 67 },
  tenor:    { min: 43, max: 76 },
  alto:     { min: 48, max: 81 },
  soprano:  { min: 55, max: 88 },
  wide:     { min: 33, max: 93 },
};
const SMOOTH = 0.15;
const CENTS_SMOOTH = 0.2;
const VOLUME_THR = 0.006;
const HOLD_MS = 350;
const JUMP_CENTS = 400;
const ROLL_WINDOW = 14000;

/* ─── State ─── */
let audioCtx, analyser, mic, stream, buffer;
let refAudioCtx;
let animId, rollAnimId;
let smoothedFreq = null, smoothedCents = null, lastPitchTime = 0;
let minMidi = RANGES.tenor.min, maxMidi = RANGES.tenor.max;
const pitchHistory = [];
const timeline = [];
let lastLayout = { kbW: 76, h: 430 };

/* ═══════════════════════════════════════════
   PITCH DETECTION (YIN)
   ═══════════════════════════════════════════ */

function yin(samples, sr) {
  const half = samples.length >> 1;
  const buf = new Float32Array(half);

  for (let t = 0; t < half; t++) {
    let s = 0;
    for (let i = 0; i < half; i++) {
      const d = samples[i] - samples[i + t];
      s += d * d;
    }
    buf[t] = s;
  }

  buf[0] = 1;
  let sum = 0;
  for (let t = 1; t < half; t++) {
    sum += buf[t];
    buf[t] = buf[t] * t / sum;
  }

  let tau = -1;
  for (let t = 2; t < half; t++) {
    if (buf[t] < 0.15) {
      while (t + 1 < half && buf[t + 1] < buf[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau === -1) return null;

  const s0 = buf[tau - 1], s1 = buf[tau], s2 = buf[tau + 1] ?? s1;
  const d = s0 - 2 * s1 + s2;
  const shift = d === 0 ? 0 : (s0 - s2) / (2 * d);
  return sr / (tau + (isNaN(shift) ? 0 : shift));
}

/* ═══════════════════════════════════════════
   CORE LOOP
   ═══════════════════════════════════════════ */

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("浏览器不支持麦克风", true);
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    mic = audioCtx.createMediaStreamSource(stream);
    mic.connect(analyser);
    buffer = new Float32Array(analyser.fftSize);

    startButton.disabled = true;
    stopButton.disabled = false;
    setStatus("正在监听，请唱一个稳定的单音。", false);
    detect();
  } catch (e) {
    setStatus(`无法打开麦克风：${e.message}`, true);
  }
}

function stop() {
  cancelAnimationFrame(animId);
  animId = undefined;
  pitchHistory.length = 0;
  smoothedFreq = null;
  smoothedCents = null;
  mic?.disconnect();
  stream?.getTracks().forEach(t => t.stop());
  audioCtx?.close();
  mic = stream = audioCtx = analyser = undefined;
  startButton.disabled = false;
  stopButton.disabled = true;
  resetUI();
  setStatus("已停止。", false);
}

function detect() {
  analyser.getFloatTimeDomainData(buffer);
  const rms = getRms(buffer);
  volume.textContent = Math.round(rms * 1000);
  const now = performance.now();
  const raw = yin(buffer, audioCtx.sampleRate);
  const hasVoice = raw !== null && raw >= 65 && raw <= 1200 && rms >= VOLUME_THR;

  if (hasVoice) {
    lastPitchTime = now;
    if (smoothedFreq !== null) {
      const jc = Math.abs(1200 * Math.log2(raw / smoothedFreq));
      if (jc > JUMP_CENTS) { animId = requestAnimationFrame(detect); return; }
    }
    smoothedFreq = smoothedFreq === null ? raw : smoothedFreq + SMOOTH * (raw - smoothedFreq);

    const note = freqToNote(smoothedFreq);
    const target = noteToFreq(note.midi);
    const cents = 1200 * Math.log2(smoothedFreq / target);
    smoothedCents = smoothedCents === null ? cents : smoothedCents + CENTS_SMOOTH * (cents - smoothedCents);

    pitchHistory.push(cents);
    if (pitchHistory.length > 18) pitchHistory.shift();
    recordPoint(smoothedFreq, rms);

    noteName.textContent = note.name;
    frequencyValue.textContent = smoothedFreq.toFixed(1);
    targetFrequency.textContent = `${target.toFixed(1)} Hz`;
    centsText.textContent = fmtCents(Math.round(smoothedCents));
    stability.textContent = fmtStability(pitchHistory);
    needle.style.left = `${50 + clamp(smoothedCents, -50, 50)}%`;
    setStatus("正在监听。", false);

  } else if (smoothedFreq !== null && now - lastPitchTime < HOLD_MS) {
    recordPoint(smoothedFreq, rms);

  } else {
    showNoPitch(rms < VOLUME_THR ? "音量太小，请靠近麦克风。" : "暂未检测到音高。");
    smoothedFreq = null;
    smoothedCents = null;
  }

  animId = requestAnimationFrame(detect);
}

/* ═══════════════════════════════════════════
   CANVAS — PIANO ROLL
   ═══════════════════════════════════════════ */

function getColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  return {
    bg: v("--core") || "#12151f",
    grid: v("--border") || "rgba(255,255,255,0.055)",
    accent: v("--accent") || "#5eead4",
    text: v("--text-2") || "#6b7394",
  };
}

function resizeRoll() {
  const r = window.devicePixelRatio || 1;
  const rect = pitchRoll.getBoundingClientRect();
  pitchRoll.width = Math.max(1, rect.width * r | 0);
  pitchRoll.height = Math.max(1, rect.height * r | 0);
  rollCtx.setTransform(r, 0, 0, r, 0, 0);
  drawRoll();
}

function tickRoll() { drawRoll(); rollAnimId = requestAnimationFrame(tickRoll); }

function drawRoll() {
  const W = pitchRoll.clientWidth, H = pitchRoll.clientHeight;
  const now = performance.now();
  const kbW = W < 500 ? 48 : 72;
  const pL = kbW, pW = W - pL;
  const rowH = H / (maxMidi - minMidi + 1);
  lastLayout = { kbW, h: H };
  trimTimeline(now);
  rollCtx.clearRect(0, 0, W, H);

  const c = getColors();

  // Background
  rollCtx.fillStyle = c.bg;
  rollCtx.fillRect(0, 0, W, H);

  // Rows
  for (let m = maxMidi; m >= minMidi; m--) {
    const y = midiY(m, H);
    const ni = ((m % 12) + 12) % 12;
    const isBlack = [1,3,6,8,10].includes(ni);
    const isC = ni === 0;

    rollCtx.fillStyle = isBlack ? "rgba(128,128,128,0.05)" : "rgba(128,128,128,0.1)";
    rollCtx.fillRect(kbW, y, W - kbW, rowH);

    rollCtx.strokeStyle = isC ? c.accent + "40" : c.grid;
    rollCtx.lineWidth = isC ? 1.2 : 0.8;
    rollCtx.beginPath();
    rollCtx.moveTo(kbW, y);
    rollCtx.lineTo(W, y);
    rollCtx.stroke();

    // Key
    rollCtx.fillStyle = isBlack ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.06)";
    rollCtx.fillRect(0, y + 1, kbW - 6, Math.max(1, rowH - 2));

    if (isBlack) {
      rollCtx.fillStyle = "rgba(0,0,0,0.5)";
      rollCtx.fillRect(0, y + 2, kbW * 0.6, Math.max(1, rowH - 4));
    }

    if (ni === 0 || ni === 4 || ni === 7) {
      rollCtx.fillStyle = c.text;
      rollCtx.font = `600 ${W < 500 ? 9 : 10}px system-ui`;
      rollCtx.textAlign = "right";
      rollCtx.textBaseline = "middle";
      rollCtx.fillText(noteNameStr(m), kbW - 12, y + rowH / 2);
    }
  }

  // Separator
  rollCtx.fillStyle = c.grid;
  rollCtx.fillRect(kbW - 6, 0, 1, H);

  // Time grid
  rollCtx.strokeStyle = c.grid;
  rollCtx.lineWidth = 0.7;
  for (let s = 0; s <= ROLL_WINDOW / 1000; s += 2) {
    const x = pL + pW - (s * 1000 / ROLL_WINDOW) * pW;
    rollCtx.beginPath(); rollCtx.moveTo(x, 0); rollCtx.lineTo(x, H); rollCtx.stroke();
  }

  rollCtx.fillStyle = c.text;
  rollCtx.font = `600 ${W < 500 ? 9 : 10}px system-ui`;
  rollCtx.textAlign = "right"; rollCtx.textBaseline = "top";
  rollCtx.fillText("now", pL + pW - 30, 8);
  rollCtx.textAlign = "left";
  rollCtx.fillText(`-${ROLL_WINDOW / 1000}s`, pL + 8, 8);

  // Pitch path
  const pts = timeline.filter(p => p.midi >= minMidi && p.midi <= maxMidi);
  if (!pts.length) {
    rollCtx.fillStyle = c.text;
    rollCtx.font = `700 ${W < 500 ? 14 : 16}px system-ui`;
    rollCtx.textAlign = "center"; rollCtx.textBaseline = "middle";
    rollCtx.fillText("开始唱歌后", pL + pW / 2, H / 2 - 12);
    rollCtx.fillText("这里会出现音高轨迹", pL + pW / 2, H / 2 + 12);
    return;
  }

  rollCtx.lineCap = "round"; rollCtx.lineJoin = "round";

  // Glow stroke
  rollCtx.strokeStyle = c.accent + "30";
  rollCtx.lineWidth = 6;
  strokePath(pts, pL, pW, H, now);

  // Main stroke
  rollCtx.strokeStyle = c.accent + "e0";
  rollCtx.lineWidth = 2;
  strokePath(pts, pL, pW, H, now);

  // Current dot
  const last = pts[pts.length - 1];
  const lx = ptX(last.time, pL, pW, now);
  const ly = midiCY(last.midi, H);
  rollCtx.fillStyle = c.accent;
  rollCtx.beginPath(); rollCtx.arc(lx, ly, 3.5, 0, Math.PI * 2); rollCtx.fill();

  // Label
  const label = noteNameStr(Math.round(last.midi));
  rollCtx.font = `700 ${W < 500 ? 10 : 11}px system-ui`;
  const tw = rollCtx.measureText(label).width;
  const bx = clamp(lx + 10, pL + 4, pL + pW - tw - 20);
  const by = clamp(ly - 28, 6, H - 30);
  rollCtx.fillStyle = c.bg;
  rollCtx.globalAlpha = 0.85;
  rollCtx.fillRect(bx, by, tw + 16, 22);
  rollCtx.globalAlpha = 1;
  rollCtx.strokeStyle = c.accent;
  rollCtx.lineWidth = 1;
  rollCtx.strokeRect(bx, by, tw + 16, 22);
  rollCtx.fillStyle = c.accent;
  rollCtx.textAlign = "left"; rollCtx.textBaseline = "middle";
  rollCtx.fillText(label, bx + 8, by + 11);
}

function strokePath(pts, pL, pW, H, now) {
  rollCtx.beginPath();
  let prev;
  for (const p of pts) {
    const x = ptX(p.time, pL, pW, now);
    const y = midiCY(p.midi, H);
    if (!prev || p.time - prev.time > 350) rollCtx.moveTo(x, y);
    else rollCtx.lineTo(x, y);
    prev = p;
  }
  rollCtx.stroke();
}

function ptX(t, pL, pW, now) { return pL + ((t - (now - ROLL_WINDOW)) / ROLL_WINDOW) * pW; }
function midiY(m, H) { return ((maxMidi - m) / (maxMidi - minMidi + 1)) * H; }
function midiCY(m, H) { return ((maxMidi - m + 0.5) / (maxMidi - minMidi + 1)) * H; }
function noteNameStr(m) { return `${NOTE_NAMES[((m % 12) + 12) % 12]}${(m / 12 | 0) - 1}`; }

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function getRms(s) { let s2 = 0; for (const v of s) s2 += v * v; return Math.sqrt(s2 / s.length); }

function freqToNote(f) {
  const m = Math.round(69 + 12 * Math.log2(f / 440));
  return { midi: m, name: `${NOTE_NAMES[((m % 12) + 12) % 12]}${(m / 12 | 0) - 1}` };
}

function noteToFreq(m) { return 440 * 2 ** ((m - 69) / 12); }

function fmtCents(c) {
  if (Math.abs(c) <= 5) return "非常准";
  return c > 0 ? `偏高 ${c}` : `偏低 ${Math.abs(c)}`;
}

function fmtStability(v) {
  if (v.length < 6) return "采样中";
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const dev = Math.sqrt(v.reduce((a, b) => a + (b - avg) ** 2, 0) / v.length);
  return dev <= 6 ? "很稳定" : dev <= 14 ? "较稳定" : "波动明显";
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

function setStatus(msg, err) {
  statusText.textContent = msg;
  statusText.style.color = err ? "var(--red)" : "var(--text-2)";
}

function showNoPitch(msg) {
  noteName.textContent = "--";
  frequencyValue.textContent = "--";
  targetFrequency.textContent = "-- Hz";
  centsText.textContent = "--";
  stability.textContent = "--";
  needle.style.left = "50%";
  pitchHistory.length = 0;
  setStatus(msg, false);
}

function resetUI() {
  noteName.textContent = "--";
  frequencyValue.textContent = "--";
  centsText.textContent = "--";
  targetFrequency.textContent = "-- Hz";
  stability.textContent = "--";
  volume.textContent = "--";
  needle.style.left = "50%";
  smoothedFreq = null;
  smoothedCents = null;
}

function recordPoint(f, rms) {
  const m = 69 + 12 * Math.log2(f / 440);
  const now = performance.now();
  timeline.push({ midi: m, frequency: f, rms, time: now });
  trimTimeline(now);
}

function trimTimeline(now) {
  while (timeline.length && timeline[0].time < now - ROLL_WINDOW) timeline.shift();
}

function clearRoll() { timeline.length = 0; drawRoll(); }

/* ═══════════════════════════════════════════
   PIANO KEY PLAYBACK
   ═══════════════════════════════════════════ */

function playKey(e) {
  const rect = pitchRoll.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  if (x > lastLayout.kbW - 6) return;
  const rowH = lastLayout.h / (maxMidi - minMidi + 1);
  const idx = clamp(Math.floor(y / rowH), 0, maxMidi - minMidi);
  const midi = maxMidi - idx;

  refAudioCtx ??= new AudioContext();
  if (refAudioCtx.state === "suspended") refAudioCtx.resume();

  const osc = refAudioCtx.createOscillator();
  const gain = refAudioCtx.createGain();
  const t = refAudioCtx.currentTime;
  osc.type = "sine";
  osc.frequency.setValueAtTime(noteToFreq(midi), t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  osc.connect(gain); gain.connect(refAudioCtx.destination);
  osc.start(t); osc.stop(t + 0.6);

  setStatus(`参考音：${noteNameStr(midi)}`, false);
}

/* ═══════════════════════════════════════════
   RANGE SWITCH
   ═══════════════════════════════════════════ */

function setRange(e) {
  const r = RANGES[e.target.dataset.range];
  if (!r) return;
  minMidi = r.min; maxMidi = r.max;
  $$(".pill").forEach(b => b.classList.toggle("active", b === e.target));
  drawRoll();
}

/* ═══════════════════════════════════════════
   THEME
   ═══════════════════════════════════════════ */

function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("vocal-theme", t);
}

$("#themeToggle").addEventListener("click", () => {
  applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
});

const saved = localStorage.getItem("vocal-theme");
if (saved) applyTheme(saved);

/* ═══════════════════════════════════════════
   SCROLL REVEAL
   ═══════════════════════════════════════════ */

const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("visible"); observer.unobserve(e.target); } });
}, { threshold: 0.1, rootMargin: "0px 0px -30px 0px" });

$$(".hero, .tuner-panel, .roll-section, .tips-section").forEach(el => observer.observe(el));

/* ═══════════════════════════════════════════
   EVENTS
   ═══════════════════════════════════════════ */

startButton.addEventListener("click", start);
stopButton.addEventListener("click", stop);
clearRollButton.addEventListener("click", clearRoll);
pitchRoll.addEventListener("pointerdown", playKey);
window.addEventListener("resize", resizeRoll);
$$(".pill").forEach(b => b.addEventListener("click", setRange));

resizeRoll();
rollAnimId = requestAnimationFrame(tickRoll);
