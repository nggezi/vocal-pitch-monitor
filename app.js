/* ═══════════════════════════════════════════
   VOCAL STUDIO — Engine v4.1
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
const volumeBar = $("#volumeBar");
const needle = $("#needle");
const pitchRoll = $("#pitchRoll");
const clearRollButton = $("#clearRollButton");
const exportCsvButton = $("#exportCsvButton");
const exportJsonButton = $("#exportJsonButton");
const recordButton = $("#recordButton");
const playbackButton = $("#playbackButton");
const targetInput = $("#targetInput");
const targetDur = $("#targetDur");
const targetToggle = $("#targetToggle");
const targetScore = $("#targetScore");
const targetPreset = $("#targetPreset");
const targetRoot = $("#targetRoot");
const targetListen = $("#targetListen");
const micSelect = $("#micSelect");
const statAccuracy = $("#statAccuracy");
const statVibrato = $("#statVibrato");
const statVibratoSub = $("#statVibratoSub");
const guideOverlay = $("#guideOverlay");
const guideClose = $("#guideClose");
const summaryOverlay = $("#summaryOverlay");
const summaryBody = $("#summaryBody");
const summaryClose = $("#summaryClose");
const rollCtx = pitchRoll.getContext("2d");

/* ─── Constants ─── */
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const RANGES = {
  bass: { min: 36, max: 67 }, tenor: { min: 43, max: 76 },
  alto: { min: 48, max: 81 }, soprano: { min: 55, max: 88 },
  wide: { min: 33, max: 90 }, // max=90（约 1500 Hz），与检测上限 PITCH_MAX 对齐
};
const SMOOTH = 0.15;        // 稳态平滑：偏差小时平滑显示
const FAST_SMOOTH = 0.55;   // 转音快攻：检测到明显跳变时快速收敛
const VOLUME_THR = 0.0015;  // 有效声音的 RMS 音量阈值
const LOW_CUT_HZ = 60;      // 麦克风输入低切频率，滤除电源哼声与低频隆隆声
const DETECT_FPS = 30;      // 检测循环帧率上限
const HOLD_MS = 600;        // 短暂无音时保持上一音高的时长
const JUMP_CENTS = 150;     // 超过此偏差视为转音，触发快攻
const OCTAVE_CENTS = 900;   // 超过此偏差疑似八度/泛音跳变
const OCTAVE_CONFIRM_FRAMES = 3; // 八度/泛音跳变需连续确认的帧数，防止抽动
const MEDIAN_WINDOW = 3;    // 中值滤波窗口，降低单次检测抖动
const HISTORY_MAX = 20;     // 练习历史最多保存条数
const VIBRATO_WINDOW_MS = 3000; // 颤音分析时间窗口

/* ─── State ─── */
let audioCtx, analyser, mic, stream, buffer;
let refAudioCtx;
let animId, rollAnimId;
let mediaRecorder = null, recordChunks = [], isRecording = false;
let sessionStartTime = 0, recordingUrl = null, recordingPoints = null;
let replayAudio = null, isReplaying = false;
let targetNotes = [], targetMode = false, targetStartTime = 0, targetIndex = 0, targetScores = [];
let previewTimer = null, isPreviewing = false;
let micDevices = [], selectedMicId = localStorage.getItem("vs_mic_id") || "";
let rollWindow = 14000;     // 钢琴窗显示的时间窗口（可切换 5s/14s/30s）
let smoothedFreq = null, smoothedCents = null, lastPitchTime = 0;
let minMidi = RANGES.tenor.min, maxMidi = RANGES.tenor.max;
const pitchHistory = [];
const recentCents = [];
const timeline = [];
let freqBuffer = [];
let lastLayout = { kbW: 72, h: 430 };
let bgCache = null, bgCacheKey = "";
let isListening = false;
let pendingJumpFreq = null, pendingJumpCount = 0;
let colorCache = null;
let lastRollTime = 0;
let lastStatus = { msg: "", err: false };
let lastDetectTime = 0;
let a4 = parseFloat(localStorage.getItem("vs_a4")) || 440;
let statAccCount = 0;
let lastVibratoText = "";

/* ─── Vocal Range Stats ─── */
let statHighMidi = -Infinity, statLowMidi = Infinity;
let statSumFreq = 0, statCount = 0;

/* ═══════════════════════════════════════════
   GUIDE OVERLAY
   ═══════════════════════════════════════════ */
if (!localStorage.getItem("vs_guide_seen")) {
  guideOverlay.classList.remove("hidden");
  guideClose.addEventListener("click", () => {
    guideOverlay.classList.add("hidden");
    localStorage.setItem("vs_guide_seen", "1");
  });
} else {
  guideOverlay.classList.add("hidden");
}

/* ═══════════════════════════════════════════
   PWA
   ═══════════════════════════════════════════ */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}

/* ═══════════════════════════════════════════
   THEME
   ═══════════════════════════════════════════ */
const themeToggle = $("#themeToggle");
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("vs_theme", t);
  colorCache = null;
  bgCache = null;
}
themeToggle.addEventListener("click", () => {
  applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
});
const savedTheme = localStorage.getItem("vs_theme");
if (savedTheme) applyTheme(savedTheme);

/* ═══════════════════════════════════════════
   A4 REFERENCE TUNING
   ═══════════════════════════════════════════ */
const a4Select = $("#a4Select");
if (a4Select) {
  a4Select.value = String(a4);
  a4Select.addEventListener("change", () => {
    a4 = parseFloat(a4Select.value) || 440;
    localStorage.setItem("vs_a4", String(a4));
    clearPitchRoll(); // 旧轨迹基于旧 A4 绘制，清空避免混用
  });
}

/* ═══════════════════════════════════════════
   YIN PITCH DETECTION
   检测核心位于独立模块 pitch.js（全局 PitchCore），
   便于浏览器加载与 Node 回归测试。
   ═══════════════════════════════════════════ */
const PitchCore = globalThis.PitchCore;
const { yin, PITCH_MIN, PITCH_MAX } = PitchCore;

/* ═══════════════════════════════════════════
   CORE LOOP
   ═══════════════════════════════════════════ */
async function start() {
  if (isListening) return;
  
  // Show loading state
  startButton.classList.add("loading");
  setStatus("正在请求麦克风权限...", false);
  
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("当前浏览器不支持麦克风采集。请使用 Chrome / Edge / Safari 16+。", true);
    startButton.classList.remove("loading");
    return;
  }
  
  try {
    const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (selectedMicId) audioConstraints.deviceId = { exact: selectedMicId };
    stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints
    });
  } catch (e) {
    if (e.name === "NotAllowedError") {
      setStatus("麦克风权限被拒绝。请在浏览器设置中允许访问麦克风。", true);
    } else if (e.name === "NotFoundError") {
      setStatus("未检测到麦克风设备。请连接麦克风后重试。", true);
    } else {
      setStatus("无法打开麦克风：" + e.message, true);
    }
    startButton.classList.remove("loading");
    return;
  }
  
  try {
    audioCtx = new AudioContext({ latencyHint: "interactive" });
    
    // Fix: Resume AudioContext if suspended (Chrome requirement)
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
    
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    mic = audioCtx.createMediaStreamSource(stream);
    // 低切滤波：滤除 50/60Hz 电源哼声和低频隆隆声，减少 YIN 误判
    const lowCut = audioCtx.createBiquadFilter();
    lowCut.type = "highpass";
    lowCut.frequency.value = LOW_CUT_HZ;
    lowCut.Q.value = 0.707; // Butterworth 响应
    mic.connect(lowCut);
    lowCut.connect(analyser);
    buffer = new Float32Array(analyser.fftSize);
    sessionStartTime = performance.now();
    statAccCount = 0;
    
    isListening = true;
    startButton.disabled = true;
    startButton.classList.remove("loading");
    stopButton.disabled = false;
    recordButton.disabled = false;
    if (window.MediaRecorder) startRecording();
    loadMicDevices(); // 授权后刷新设备标签
    setStatus("正在监听，请唱一个稳定的单音。", false);
    detect();
  } catch (e) {
    setStatus("音频初始化失败：" + e.message, true);
    startButton.classList.remove("loading");
  }
}

function stop() {
  if (!isListening) return;
  
  exitReplay();
  stopPreview();
  stopRecording();
  cancelAnimationFrame(animId);
  animId = undefined;
  pitchHistory.length = 0;
  recentCents.length = 0;
  smoothedFreq = null;
  smoothedCents = null;
  freqBuffer = [];
  pendingJumpFreq = null;
  pendingJumpCount = 0;
  mic?.disconnect();
  stream?.getTracks().forEach(t => t.stop());
  audioCtx?.close();
  mic = stream = audioCtx = analyser = undefined;
  
  isListening = false;
  startButton.disabled = false;
  stopButton.disabled = true;
  recordButton.disabled = true;
  if (statCount > 0) {
    saveHistory();
    showSessionSummary();
  }
  resetUI();
  setStatus("已停止。", false);
}

function detect(ts) {
  if (!isListening) return;

  const now = ts || performance.now();
  // 检测循环限频到 ~30fps：人声变化远低于该频率，CPU 减半
  if (now - lastDetectTime < 1000 / DETECT_FPS) {
    animId = requestAnimationFrame(detect);
    return;
  }
  lastDetectTime = now;

  analyser.getFloatTimeDomainData(buffer);
  const rms = getRms(buffer);
  const volInt = Math.round(rms * 1000);
  if (volume.textContent !== String(volInt)) volume.textContent = String(volInt);

  // Volume bar
  const volPct = Math.min(100, Math.round((rms / 0.1) * 100));
  const volStyle = volPct + "%";
  if (volumeBar.style.width !== volStyle) volumeBar.style.width = volStyle;

  // 削波检测：输入过大会导致削顶失真，YIN 结果不可靠
  let clipCount = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (Math.abs(buffer[i]) > 0.98) clipCount++;
  }
  const clipBad = clipCount / buffer.length > 0.003;

  // YIN 的 CMND 自带幅度归一化，无需额外峰值归一化；
  // confidence 表示周期匹配程度，可滤掉没有稳定周期的噪声。
  const raw = yin(buffer, audioCtx.sampleRate);
  const hasVoice = raw !== null && raw.freq >= PITCH_MIN && raw.freq <= PITCH_MAX && rms >= VOLUME_THR;

  if (hasVoice) {
    lastPitchTime = now;
    freqBuffer.push(raw.freq);
    if (freqBuffer.length < MEDIAN_WINDOW) {
      animId = requestAnimationFrame(detect);
      return;
    }
    // Optimized median computation using insertion sort
    const sorted = insertionSort(freqBuffer);
    const median = sorted[Math.floor(sorted.length / 2)];
    freqBuffer.shift(); // remove oldest for next window

    // 转音处理：不丢弃跳变帧，而是加快收敛；疑似八度/泛音跳变需连续多帧确认。
    let k = SMOOTH;
    if (smoothedFreq !== null) {
      const jc = Math.abs(1200 * Math.log2(median / smoothedFreq));
      if (jc > OCTAVE_CENTS) {
        const same = pendingJumpFreq !== null &&
          Math.abs(1200 * Math.log2(median / pendingJumpFreq)) < 60;
        pendingJumpFreq = same ? pendingJumpFreq : median;
        pendingJumpCount = same ? pendingJumpCount + 1 : 1;
        if (pendingJumpCount < OCTAVE_CONFIRM_FRAMES) {
          // 确认期间保持当前音高（k=0），防止泛音/倍频误检造成抽动；
          // 不丢弃帧，轨迹保持连续。
          k = 0;
        } else {
          pendingJumpFreq = null;
          pendingJumpCount = 0;
          k = FAST_SMOOTH;
        }
      } else {
        pendingJumpFreq = null;
        pendingJumpCount = 0;
        k = jc > JUMP_CENTS ? FAST_SMOOTH : SMOOTH;
      }
    } else {
      k = 1;
    }

    // Update smoothedFreq with median
    smoothedFreq = smoothedFreq === null ? median : smoothedFreq + k * (median - smoothedFreq);
    const note = freqToNote(smoothedFreq);
    const target = noteToFreq(note.midi);
    const cents = 1200 * Math.log2(smoothedFreq / target);
    smoothedCents = cents;
    pitchHistory.push(cents);
    if (pitchHistory.length > 18) pitchHistory.shift();
    recentCents.push(cents);
    if (recentCents.length > 300) recentCents.shift();
    if (Math.abs(cents) <= 10) statAccCount++;
    recordPoint(smoothedFreq, rms, cents);
    if (targetMode && targetNotes.length) updateTargetEval(smoothedFreq, now);

    // Track vocal range stats
    const noteMidi = Math.round(69 + 12 * Math.log2(smoothedFreq / a4));
    if (noteMidi > statHighMidi) statHighMidi = noteMidi;
    if (noteMidi < statLowMidi) statLowMidi = noteMidi;
    statSumFreq += smoothedFreq;
    statCount++;
    updateStats();
    noteName.textContent = note.name;
    frequencyValue.textContent = smoothedFreq.toFixed(1);
    targetFrequency.textContent = target.toFixed(1) + " Hz";
    centsText.textContent = fmtCents(Math.round(smoothedCents));
    stability.textContent = fmtStability(pitchHistory, recentCents);
    needle.style.left = (50 + clamp(smoothedCents, -50, 50)) + "%";
    updateAccuracyAndVibrato(now);
  } else if (smoothedFreq !== null && now - lastPitchTime < HOLD_MS) {
    recordPoint(smoothedFreq, rms, smoothedCents);
    // Reset buffer when we lose voice but are holding the last pitch
    freqBuffer = [];
    pendingJumpFreq = null;
    pendingJumpCount = 0;
  } else {
    showNoPitch(rms < VOLUME_THR ? "音量太小，请靠近麦克风。" : "暂未检测到音高。");
    smoothedFreq = null;
    smoothedCents = null;
    freqBuffer = []; // reset buffer when we lose voice
    pendingJumpFreq = null;
    pendingJumpCount = 0;
  }
  if (clipBad) {
    setStatus("输入过大，请远离麦克风。", false);
  } else if (hasVoice) {
    setStatus("正在监听。", false);
  }
  animId = requestAnimationFrame(detect);
}

/* ═══════════════════════════════════════════
   CANVAS — PIANO ROLL (Optimized)
   ═══════════════════════════════════════════ */
function getColors() {
  if (colorCache) return colorCache;
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  colorCache = {
    bg: v("--core") || "#12151f",
    grid: v("--border") || "rgba(255,255,255,0.055)",
    accent: v("--accent") || "#5eead4",
    text: v("--text-2") || "#6b7394",
  };
  return colorCache;
}

function resizeRoll() {
  const r = window.devicePixelRatio || 1;
  const rect = pitchRoll.getBoundingClientRect();
  pitchRoll.width = Math.max(1, rect.width * r | 0);
  pitchRoll.height = Math.max(1, rect.height * r | 0);
  rollCtx.setTransform(r, 0, 0, r, 0, 0);
  bgCache = null;
  drawRoll();
}

function tickRoll(ts) {
  if (ts - lastRollTime >= 33) { lastRollTime = ts; drawRoll(); }
  rollAnimId = requestAnimationFrame(tickRoll);
}

function buildBgCache(W, H, kbW, rowH) {
  const c = getColors();
  const oc = document.createElement("canvas");
  const ocCtx = oc.getContext("2d");
  const r = window.devicePixelRatio || 1;
  oc.width = W * r; oc.height = H * r;
  ocCtx.setTransform(r, 0, 0, r, 0, 0);

  ocCtx.fillStyle = c.bg;
  ocCtx.fillRect(0, 0, W, H);

  for (let m = maxMidi; m >= minMidi; m--) {
    const y = midiY(m, H);
    const ni = ((m % 12) + 12) % 12;
    const isBlack = [1,3,6,8,10].includes(ni);
    const isC = ni === 0;
    ocCtx.fillStyle = isBlack ? "rgba(128,128,128,0.05)" : "rgba(128,128,128,0.1)";
    ocCtx.fillRect(kbW, y, W - kbW, rowH);
    ocCtx.strokeStyle = isC ? c.accent + "40" : c.grid;
    ocCtx.lineWidth = isC ? 1.2 : 0.8;
    ocCtx.beginPath(); ocCtx.moveTo(kbW, y); ocCtx.lineTo(W, y); ocCtx.stroke();
    ocCtx.fillStyle = isBlack ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.06)";
    ocCtx.fillRect(0, y + 1, kbW - 6, Math.max(1, rowH - 2));
    if (isBlack) { ocCtx.fillStyle = "rgba(0,0,0,0.5)"; ocCtx.fillRect(0, y + 2, kbW * 0.6, Math.max(1, rowH - 4)); }
    if (ni === 0 || ni === 4 || ni === 7) {
      ocCtx.fillStyle = c.text;
      ocCtx.font = `600 ${W < 500 ? 9 : 10}px system-ui`;
      ocCtx.textAlign = "right"; ocCtx.textBaseline = "middle";
      ocCtx.fillText(noteNameStr(m), kbW - 12, y + rowH / 2);
    }
  }
  ocCtx.fillStyle = c.grid;
  ocCtx.fillRect(kbW - 6, 0, 1, H);

  return oc;
}

function drawRoll(nowArg) {
  const W = pitchRoll.clientWidth, H = pitchRoll.clientHeight;
  const kbW = W < 500 ? 48 : 72;
  const pL = kbW, pW = W - pL;
  const rowH = H / (maxMidi - minMidi + 1);
  lastLayout = { kbW, h: H };
  let now, pts;
  let replayLabel = false;
  if (isReplaying && recordingPoints) {
    const curMs = replayAudio ? replayAudio.currentTime * 1000 : 0;
    now = curMs;
    pts = recordingPoints.filter(p => p.rel >= curMs - rollWindow && p.rel <= curMs && p.midi >= minMidi && p.midi <= maxMidi);
    replayLabel = true;
  } else {
    now = nowArg || performance.now();
    pts = timeline.filter(p => p.midi >= minMidi && p.midi <= maxMidi);
    trimTimeline(now);
  }

  const c = getColors();
  const key = `${W}x${H}_${minMidi}_${maxMidi}_${c.bg}`;
  if (!bgCache || bgCacheKey !== key) { bgCache = buildBgCache(W, H, kbW, rowH); bgCacheKey = key; }
  rollCtx.clearRect(0, 0, W, H);
  rollCtx.drawImage(bgCache, 0, 0, W, H);

  // 动态时间网格：与轨迹使用同一时间基准，避免静态网格随时间错位
  rollCtx.font = `600 ${W < 500 ? 9 : 10}px system-ui`;
  for (let s = 0; s <= rollWindow / 1000; s += 2) {
    const x = ptX(now - s * 1000, pL, pW, now);
    rollCtx.strokeStyle = c.grid;
    rollCtx.lineWidth = 0.7;
    rollCtx.beginPath(); rollCtx.moveTo(x, 0); rollCtx.lineTo(x, H); rollCtx.stroke();
  }
  // 当前时刻播放指针：始终钉在时间轴最右端（now 位置）
  const nowX = ptX(now, pL, pW, now) - 1; // 内缩 1px，避免线画在画布外
  rollCtx.strokeStyle = c.accent + "66";
  rollCtx.lineWidth = 1.5;
  rollCtx.beginPath(); rollCtx.moveTo(nowX, 0); rollCtx.lineTo(nowX, H); rollCtx.stroke();
  // 时间标签
  rollCtx.fillStyle = c.text;
  rollCtx.textAlign = "right"; rollCtx.textBaseline = "top";
  rollCtx.fillText(replayLabel ? "REPLAY" : "now", pL + pW - 4, 8);
  rollCtx.textAlign = "left";
  rollCtx.fillText("-" + (rollWindow / 1000) + "s", pL + 4, 8);

  // 跟唱目标线：橙色阶梯，当前音符高亮
  if (targetMode && targetNotes.length && !isReplaying) {
    const tNow = performance.now();
    rollCtx.strokeStyle = "#f59e0b";
    rollCtx.lineWidth = 2;
    rollCtx.font = `700 ${W < 500 ? 9 : 10}px system-ui`;
    for (let i = 0; i < targetNotes.length; i++) {
      const n = targetNotes[i];
      if (n.start + n.durMs < tNow - rollWindow) continue;
      const x1 = ptX(Math.max(n.start, tNow - rollWindow), pL, pW, tNow);
      const x2 = ptX(Math.min(n.start + n.durMs, tNow), pL, pW, tNow);
      if (x2 <= x1) continue;
      const y = midiCY(n.midi, H);
      const active = i === targetIndex;
      rollCtx.globalAlpha = active ? 0.95 : 0.45;
      rollCtx.beginPath();
      rollCtx.moveTo(x1, y);
      rollCtx.lineTo(x2, y);
      rollCtx.stroke();
      if (active || n.start > tNow - rollWindow) {
        rollCtx.fillStyle = "#f59e0b";
        rollCtx.textAlign = "left"; rollCtx.textBaseline = "bottom";
        rollCtx.fillText(noteNameStr(n.midi), x1 + 3, y - 3);
      }
    }
    rollCtx.globalAlpha = 1;
  }

  if (!pts.length) {
    rollCtx.fillStyle = c.text;
    rollCtx.font = `700 ${W < 500 ? 14 : 16}px system-ui`;
    rollCtx.textAlign = "center"; rollCtx.textBaseline = "middle";
    if (replayLabel) {
      rollCtx.fillText("回放中…", pL + pW / 2, H / 2 - 12);
      rollCtx.fillText("轨迹会随时间出现", pL + pW / 2, H / 2 + 12);
    } else {
      rollCtx.fillText("开始唱歌后", pL + pW / 2, H / 2 - 12);
      rollCtx.fillText("这里会出现音高轨迹", pL + pW / 2, H / 2 + 12);
    }
    return;
  }

  rollCtx.lineCap = "round"; rollCtx.lineJoin = "round";
  drawBezierPath(pts, pL, pW, H, now, c.accent + "30", 6);
  drawBezierPath(pts, pL, pW, H, now, c.accent + "e0", 2);

  const last = pts[pts.length - 1];
  const lx = ptX(last.time, pL, pW, now);
  const ly = midiCY(last.midi, H);
  rollCtx.fillStyle = c.accent;
  rollCtx.beginPath(); rollCtx.arc(lx, ly, 3.5, 0, Math.PI * 2); rollCtx.fill();

  const label = noteNameStr(Math.round(last.midi));
  rollCtx.font = `700 ${W < 500 ? 10 : 11}px system-ui`;
  const tw = rollCtx.measureText(label).width;
  const bx = clamp(lx + 10, pL + 4, pL + pW - tw - 20);
  const by = clamp(ly - 28, 6, H - 30);
  rollCtx.fillStyle = c.bg; rollCtx.globalAlpha = 0.85;
  rollCtx.fillRect(bx, by, tw + 16, 22);
  rollCtx.globalAlpha = 1;
  rollCtx.strokeStyle = c.accent; rollCtx.lineWidth = 1;
  rollCtx.strokeRect(bx, by, tw + 16, 22);
  rollCtx.fillStyle = c.accent;
  rollCtx.textAlign = "left"; rollCtx.textBaseline = "middle";
  rollCtx.fillText(label, bx + 8, by + 11);
}

function drawBezierPath(pts, pL, pW, H, now, color, lineWidth) {
  // 主轨迹按逐点 cents 偏差着色：绿（≤10¢）/ 橙（≤25¢）/ 红（超出）
  const colorByCents = (avg) => {
    if (avg === null || avg === undefined) return color;
    if (avg <= 10) return "#34d399";
    if (avg <= 25) return "#f59e0b";
    return "#f87171";
  };
  let segments = [];
  let seg = [];
  for (const p of pts) {
    if (seg.length && p.time - seg[seg.length - 1].time > 350) {
      segments.push(seg);
      seg = [];
    }
    seg.push(p);
  }
  if (seg.length) segments.push(seg);

  for (const s of segments) {
    rollCtx.strokeStyle = color;
    rollCtx.lineWidth = lineWidth;
    rollCtx.beginPath();
    if (s.length < 2) {
      const x = ptX(s[0].time, pL, pW, now);
      const y = midiCY(s[0].midi, H);
      rollCtx.moveTo(x, y);
      rollCtx.lineTo(x + 0.5, y);
      rollCtx.stroke();
      continue;
    }
    // 计算该段平均偏差用于着色（仅主轨迹细线层着色，光晕层保持统一色）
    if (lineWidth <= 2 && s[0].cents !== undefined) {
      let sum = 0, n = 0;
      for (const p of s) { if (p.cents !== null && p.cents !== undefined) { sum += Math.abs(p.cents); n++; } }
      if (n) rollCtx.strokeStyle = colorByCents(sum / n);
    }
    const x0 = ptX(s[0].time, pL, pW, now);
    const y0 = midiCY(s[0].midi, H);
    rollCtx.moveTo(x0, y0);
    for (let i = 1; i < s.length; i++) {
      const x1 = ptX(s[i - 1].time, pL, pW, now);
      const y1 = midiCY(s[i - 1].midi, H);
      const x2 = ptX(s[i].time, pL, pW, now);
      const y2 = midiCY(s[i].midi, H);
      const cx = (x1 + x2) / 2;
      rollCtx.quadraticCurveTo(x1, y1, cx, (y1 + y2) / 2);
    }
    const last = s[s.length - 1];
    rollCtx.lineTo(ptX(last.time, pL, pW, now), midiCY(last.midi, H));
    rollCtx.stroke();
  }
}

function ptX(t, pL, pW, now) { return pL + ((t - (now - rollWindow)) / rollWindow) * pW; }
function midiY(m, H) { return ((maxMidi - m) / (maxMidi - minMidi + 1)) * H; }
function midiCY(m, H) { return ((maxMidi - m + 0.5) / (maxMidi - minMidi + 1)) * H; }
function noteNameStr(m) { return NOTE_NAMES[((m % 12) + 12) % 12] + ((m / 12 | 0) - 1); }

/* ═══════════════════════════════════════════
   PIANO KEY PLAYBACK
   ═══════════════════════════════════════════ */
function playKey(e) {
  const rect = pitchRoll.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const kbW = lastLayout.kbW;
  const clickW = window.innerWidth < 500 ? kbW + 24 : kbW + 12;
  if (x > clickW) return;
  const midi = yToMidi(y, lastLayout.h);
  playRefNote(midi);
  setStatus("参考音：" + noteNameStr(midi) + " " + noteToFreq(midi).toFixed(1) + " Hz", false);
}

function yToMidi(y, H) {
  const rowH = H / (maxMidi - minMidi + 1);
  return maxMidi - clamp(Math.floor(y / rowH), 0, maxMidi - minMidi);
}

function playRefNote(midi) {
  try {
    if (!refAudioCtx) {
      refAudioCtx = new AudioContext({ latencyHint: "interactive" });
    }
    
    // Resume if suspended
    if (refAudioCtx.state === "suspended") {
      refAudioCtx.resume();
    }
    
    const osc = refAudioCtx.createOscillator();
    const gain = refAudioCtx.createGain();
    const t = refAudioCtx.currentTime;
    osc.type = "sine";
    osc.frequency.setValueAtTime(noteToFreq(midi), t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
    osc.connect(gain); gain.connect(refAudioCtx.destination);
    osc.start(t); osc.stop(t + 0.65);
    
    // Cleanup after playback
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  } catch (e) {
    console.warn("Reference note playback failed:", e);
  }
}

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */
function getRms(s) { let s2 = 0; for (const v of s) s2 += v * v; return Math.sqrt(s2 / s.length); }
function freqToNote(f) { const m = Math.round(69 + 12 * Math.log2(f / a4)); return { midi: m, name: NOTE_NAMES[((m % 12) + 12) % 12] + ((m / 12 | 0) - 1) }; }
function noteToFreq(m) { return a4 * 2 ** ((m - 69) / 12); }
function fmtCents(c) { return Math.abs(c) <= 5 ? "非常准" : (c > 0 ? "偏高 " + c : "偏低 " + Math.abs(c)); }
function fmtStability(v, centsArr) {
  if (v.length < 6) return "采样中";
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const dev = Math.sqrt(v.reduce((a, b) => a + (b - avg) ** 2, 0) / v.length);
  let label = dev <= 6 ? "很稳定" : dev <= 14 ? "较稳定" : "波动明显";
  if (centsArr && centsArr.length >= 30) {
    const pct = Math.round(centsArr.filter(c => Math.abs(c) <= 10).length / centsArr.length * 100);
    label += ` · ${pct}% 在 ±10¢`;
  }
  return label;
}
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
function setStatus(msg, err) {
  if (lastStatus.msg === msg && lastStatus.err === err) return;
  lastStatus = { msg, err };
  statusText.textContent = msg;
  statusText.style.color = err ? "var(--red)" : "var(--text-2)";
}
function showNoPitch(msg) {
  if (noteName.textContent !== "--") {
    noteName.textContent = "--";
    frequencyValue.textContent = "--";
    targetFrequency.textContent = "-- Hz";
    centsText.textContent = "--";
    stability.textContent = "--";
    needle.style.left = "50%";
  }
  pitchHistory.length = 0;
  recentCents.length = 0;
  setStatus(msg, false);
}
function resetUI() { noteName.textContent = "--"; frequencyValue.textContent = "--"; centsText.textContent = "--"; targetFrequency.textContent = "-- Hz"; stability.textContent = "--"; volume.textContent = "--"; volumeBar.style.width = "0%"; needle.style.left = "50%"; smoothedFreq = null; smoothedCents = null; statHighMidi = -Infinity; statLowMidi = Infinity; statSumFreq = 0; statCount = 0; statAccCount = 0; statAccuracy.textContent = "--"; statVibrato.textContent = "--"; statVibratoSub.textContent = "--"; lastVibratoText = ""; updateStats(); }
function recordPoint(f, rms, cents) { timeline.push({ midi: 69 + 12 * Math.log2(f / a4), frequency: f, rms, cents: cents ?? null, time: performance.now(), rel: performance.now() - sessionStartTime }); trimTimeline(); }

/**
 * Insertion sort for small arrays (more efficient than Array.sort for n < 10)
 */
function insertionSort(arr) {
  const result = [...arr];
  for (let i = 1; i < result.length; i++) {
    const key = result[i];
    let j = i - 1;
    while (j >= 0 && result[j] > key) {
      result[j + 1] = result[j];
      j--;
    }
    result[j + 1] = key;
  }
  return result;
}

function updateStats() {
  const highEl = $("#statHigh"), highHz = $("#statHighHz");
  const lowEl = $("#statLow"), lowHz = $("#statLowHz");
  const avgEl = $("#statAvg"), avgHz = $("#statAvgHz");
  const spanEl = $("#statSpan"), spanNote = $("#statSpanNote");

  if (statCount === 0) {
    highEl.textContent = "--"; highHz.textContent = "--";
    lowEl.textContent = "--"; lowHz.textContent = "--";
    avgEl.textContent = "--"; avgHz.textContent = "--";
    spanEl.textContent = "--"; spanNote.textContent = "--";
    return;
  }

  const highName = noteNameStr(statHighMidi);
  const lowName = noteNameStr(statLowMidi);
  const avgFreq = statSumFreq / statCount;
  const avgMidi = Math.round(69 + 12 * Math.log2(avgFreq / a4));
  const avgName = noteNameStr(avgMidi);
  const spanSemitones = statHighMidi - statLowMidi;
  const spanOctaves = (spanSemitones / 12).toFixed(1);

  highEl.textContent = highName;
  highHz.textContent = noteToFreq(statHighMidi).toFixed(1) + " Hz";
  lowEl.textContent = lowName;
  lowHz.textContent = noteToFreq(statLowMidi).toFixed(1) + " Hz";
  avgEl.textContent = avgName;
  avgHz.textContent = avgFreq.toFixed(1) + " Hz";
  spanEl.textContent = spanSemitones + " 半音";
  spanNote.textContent = "约 " + spanOctaves + " 个八度";
}
function clearPitchRoll() { timeline.length = 0; bgCache = null; drawRoll(); }
function trimTimeline() { const now = performance.now(); while (timeline.length && timeline[0].time < now - rollWindow) timeline.shift(); }

/* ═══════════════════════════════════════════
   FOLLOW-ALONG TARGET MELODY
   ═══════════════════════════════════════════ */
const NOTE_MAP = { C:0, "C#":1, Db:1, D:2, "D#":3, Eb:3, E:4, F:5, "F#":6, Gb:6, G:7, "G#":8, Ab:8, A:9, "A#":10, Bb:10, B:11 };
function parseNotes(str) {
  const parts = String(str || "").trim().split(/[\s,，]+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = p.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!m) continue;
    const ni = NOTE_MAP[(m[1].toUpperCase() + m[2].toLowerCase())];
    if (ni === undefined) continue;
    const midi = (parseInt(m[3], 10) + 1) * 12 + ni;
    if (midi >= 21 && midi <= 108) out.push(midi);
  }
  return out;
}
function applyPreset() {
  if (!targetPreset || !targetPreset.value) return;
  const rootName = targetRoot ? targetRoot.value : "C";
  const rootNi = NOTE_MAP[rootName];
  if (rootNi === undefined) return;
  const octave = 4; // 从第 4 个八度起始，可覆盖多数音域
  const root = (octave + 1) * 12 + rootNi;
  const PRESETS = {
    major: [0, 2, 4, 5, 7, 9, 11, 12],
    minor: [0, 2, 3, 5, 7, 8, 10, 12],
    pentatonic: [0, 2, 4, 7, 9, 12],
    arpeggio: [0, 4, 7, 12, 16, 19, 24],
    thirds: [0, 4, 7, 12, 9, 12, 16],
    octave: [0, 12, 0, -12, 0],
  };
  const steps = PRESETS[targetPreset.value];
  if (!steps) return;
  const notes = steps.map(s => root + s).map(noteNameStr);
  targetInput.value = notes.join(" ");
  setStatus(`已生成${targetPreset.options[targetPreset.selectedIndex].text}：${notes.join(" ")}`, false);
}
function previewTarget() {
  if (isPreviewing) { stopPreview(); return; }
  const notes = parseNotes(targetInput.value);
  if (!notes.length) { setStatus("请先输入有效音高序列。", true); return; }
  const gapMs = parseInt(targetDur.value, 10) || 2000;
  isPreviewing = true;
  targetListen.textContent = "停止试听";
  targetListen.classList.add("active");
  let i = 0;
  const playNext = () => {
    if (!isPreviewing) return;
    if (i >= notes.length) { stopPreview(); return; }
    playRefNote(notes[i]);
    i++;
    previewTimer = setTimeout(playNext, gapMs);
  };
  playNext();
}
function stopPreview() {
  isPreviewing = false;
  clearTimeout(previewTimer);
  previewTimer = null;
  if (targetListen) { targetListen.textContent = "试听"; targetListen.classList.remove("active"); }
}
function toggleTargetMode() {
  if (targetMode) { exitTargetMode(); return; }
  stopPreview();
  const notes = parseNotes(targetInput.value);
  if (!notes.length) {
    setStatus("请输入有效音高，如 C4 E4 G4 C5。", true);
    return;
  }
  const durMs = parseInt(targetDur.value, 10) || 2000;
  targetStartTime = performance.now();
  targetNotes = notes.map((midi, i) => ({ midi, durMs, start: targetStartTime + i * durMs, samples: null }));
  targetMode = true;
  targetIndex = 0;
  targetScores = [];
  targetToggle.textContent = "停止跟唱";
  targetToggle.classList.add("active");
  setStatus(`跟唱开始：${notes.map(noteNameStr).join(" ")}，按顺序演唱。`, false);
}
function exitTargetMode() {
  targetMode = false;
  targetNotes = [];
  targetScores = [];
  targetToggle.textContent = "开始跟唱";
  targetToggle.classList.remove("active");
  targetScore.textContent = "";
  bgCache = null;
}
function updateTargetEval(freq, now) {
  let idx = -1;
  for (let i = 0; i < targetNotes.length; i++) {
    if (now >= targetNotes[i].start && now < targetNotes[i].start + targetNotes[i].durMs) { idx = i; break; }
    if (now < targetNotes[i].start) break;
  }
  if (idx === -1) {
    if (now >= targetNotes[targetNotes.length - 1].start + targetNotes[targetNotes.length - 1].durMs) finishTargetMode();
    return;
  }
  if (idx !== targetIndex) {
    finalizeTargetNote(targetIndex);
    targetIndex = idx;
  }
  const targetF = noteToFreq(targetNotes[idx].midi);
  const cents = 1200 * Math.log2(freq / targetF);
  if (!targetNotes[idx].samples) targetNotes[idx].samples = [];
  targetNotes[idx].samples.push(cents);
  targetScore.textContent = `第 ${idx + 1}/${targetNotes.length} 音 · ${fmtCents(Math.round(cents))}`;
}
function finalizeTargetNote(i) {
  const n = targetNotes[i];
  if (!n || !n.samples || !n.samples.length) return;
  const avgAbs = n.samples.reduce((a, b) => a + Math.abs(b), 0) / n.samples.length;
  targetScores[i] = Math.round(clamp(100 - avgAbs * 2.5, 0, 100));
}
function finishTargetMode() {
  for (let i = 0; i < targetNotes.length; i++) finalizeTargetNote(i);
  const done = targetScores.filter(s => s !== undefined);
  if (done.length) {
    const total = Math.round(done.reduce((a, b) => a + b, 0) / done.length);
    targetScore.textContent = `跟唱完成 · 总分 ${total}/100（${done.length} 音）`;
  }
  targetMode = false;
  targetToggle.textContent = "开始跟唱";
  targetToggle.classList.remove("active");
  bgCache = null;
}
function targetTotalScore() {
  const done = targetScores.filter(s => s !== undefined);
  if (!done.length) return null;
  return Math.round(done.reduce((a, b) => a + b, 0) / done.length);
}
function showSessionSummary() {
  if (!summaryOverlay || !summaryBody || !statCount) return;
  const dur = Math.round((performance.now() - sessionStartTime) / 1000);
  const durText = dur >= 60 ? `${(dur / 60).toFixed(1)} 分钟` : `${dur} 秒`;
  const accPct = Math.round(statAccCount / statCount * 100);
  const vibText = statVibrato.textContent !== "--" ? `${statVibrato.textContent}（${statVibratoSub.textContent}）` : "未检测到";
  const score = targetTotalScore();
  const rows = [
    ["练习时长", durText],
    ["音域", `${noteNameStr(statLowMidi)} – ${noteNameStr(statHighMidi)}（${statHighMidi - statLowMidi} 半音）`],
    ["音准保持率", `${accPct}% 在 ±10¢ 内`],
    ["颤音", vibText],
  ];
  if (score !== null) rows.push(["跟唱得分", `${score} / 100`]);
  summaryBody.innerHTML = rows.map(([k, v]) =>
    `<div class="summary-row"><span class="summary-label">${k}</span><strong class="summary-value">${v}</strong></div>`
  ).join("");
  summaryOverlay.classList.remove("hidden");
}

/* ═══════════════════════════════════════════
   RECORDING & PLAYBACK
   ═══════════════════════════════════════════ */
function startRecording() {
  if (!stream || !window.MediaRecorder || isRecording) return;
  try {
    recordChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      recordingUrl = URL.createObjectURL(blob);
      recordingPoints = timeline.map(p => ({ ...p }));
      playbackButton.disabled = false;
    };
    mediaRecorder.start();
    isRecording = true;
    recordButton.textContent = "停止录音";
    recordButton.classList.add("active");
  } catch (e) {
    console.warn("Recording failed:", e);
  }
}
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  mediaRecorder = null;
  isRecording = false;
  recordButton.textContent = "录音";
  recordButton.classList.remove("active");
}
function togglePlayback() {
  if (isReplaying) { exitReplay(); return; }
  if (!recordingUrl) return;
  replayAudio = new Audio(recordingUrl);
  replayAudio.onended = exitReplay;
  isReplaying = true;
  playbackButton.textContent = "停止回放";
  playbackButton.classList.add("active");
  replayAudio.play();
}
function exitReplay() {
  isReplaying = false;
  if (replayAudio) { replayAudio.pause(); replayAudio = null; }
  playbackButton.textContent = "回放";
  playbackButton.classList.remove("active");
}

/* ═══════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════ */
function exportTimeline(format) {
  if (!timeline.length) { setStatus("暂无轨迹数据，先开始监听。", true); return; }
  const rows = timeline.map(p => ({
    timeMs: Math.round(p.rel),
    midi: +p.midi.toFixed(2),
    note: noteNameStr(Math.round(p.midi)),
    freqHz: +p.frequency.toFixed(2),
    rms: +p.rms.toExponential(3),
  }));
  let content, type, name;
  if (format === "csv") {
    content = "time_ms,midi,note,freq_hz,rms\n" + rows.map(r => `${r.timeMs},${r.midi},${r.note},${r.freqHz},${r.rms}`).join("\n");
    type = "text/csv"; name = "vocal-studio-pitch.csv";
  } else {
    content = JSON.stringify(rows, null, 2);
    type = "application/json"; name = "vocal-studio-pitch.json";
  }
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`已导出 ${name}（${rows.length} 个采样点）。`, false);
}

/* ═══════════════════════════════════════════
   MICROPHONE DEVICES
   ═══════════════════════════════════════════ */
async function loadMicDevices() {
  if (!micSelect || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    micDevices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
    micSelect.innerHTML = '<option value="">默认麦克风</option>' +
      micDevices.map((d, i) => `<option value="${d.deviceId}">${d.label || `麦克风 ${i + 1}`}</option>`).join("");
    if (selectedMicId && micDevices.some(d => d.deviceId === selectedMicId)) micSelect.value = selectedMicId;
  } catch (e) { /* 忽略枚举失败 */ }
}

/* ═══════════════════════════════════════════
   PRACTICE HISTORY
   ═══════════════════════════════════════════ */
function saveHistory() {
  if (!statCount) return;
  const rec = {
    date: Date.now(),
    durationMs: Math.round(performance.now() - sessionStartTime),
    high: statHighMidi,
    low: statLowMidi,
    span: statHighMidi - statLowMidi,
    accPct: Math.round(statAccCount / statCount * 100),
  };
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem("vs_history") || "[]"); } catch (e) {}
  if (!Array.isArray(hist)) hist = [];
  hist.unshift(rec);
  hist = hist.slice(0, HISTORY_MAX);
  localStorage.setItem("vs_history", JSON.stringify(hist));
  renderHistory();
}
function renderHistory() {
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem("vs_history") || "[]"); } catch (e) {}
  const empty = $("#historyEmpty"), list = $("#historyList");
  const trend = $("#historyTrend");
  if (!hist.length) {
    if (list) list.innerHTML = "";
    if (empty) empty.style.display = "block";
    if (trend) trend.innerHTML = "";
    return;
  }
  if (empty) empty.style.display = "none";
  if (trend) trend.innerHTML = renderTrendChart(hist);
  if (!list) return;
  list.innerHTML = hist.map(r => {
    const d = new Date(r.date);
    const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const dur = r.durationMs >= 60000 ? `${(r.durationMs / 60000).toFixed(1)} 分` : `${Math.round(r.durationMs / 1000)} 秒`;
    const span = Number.isFinite(r.high) ? `${noteNameStr(r.low)}–${noteNameStr(r.high)}` : "--";
    return `<div class="history-item"><span class="history-date">${dateStr}</span><span>${dur}</span><span>${span}</span><span>音准 ${r.accPct}%</span></div>`;
  }).join("");
}
function renderTrendChart(hist) {
  const data = [...hist].reverse().map(r => r.accPct).filter(v => Number.isFinite(v));
  if (data.length < 2) return '<p class="history-trend-hint">再完成几次练习，这里会显示音准趋势。</p>';
  const W = 600, H = 90, pad = 8;
  const maxV = 100, minV = 0;
  const xStep = (W - pad * 2) / (data.length - 1);
  const y = (v) => H - pad - (v - minV) / (maxV - minV) * (H - pad * 2);
  const pts = data.map((v, i) => `${(pad + i * xStep).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const lastX = pad + (data.length - 1) * xStep;
  const lastY = y(data[data.length - 1]);
  const grid = [0, 25, 50, 75, 100].map(v =>
    `<line x1="${pad}" y1="${y(v)}" x2="${W - pad}" y2="${y(v)}" stroke="rgba(128,128,128,0.15)" stroke-width="1"/>` +
    `<text x="${pad}" y="${y(v) - 2}" font-size="8" fill="rgba(128,128,128,0.6)">${v}%</text>`
  ).join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="音准保持率趋势">
    ${grid}
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3" fill="var(--accent)"/>
  </svg>`;
}
function clearHistory() {
  localStorage.removeItem("vs_history");
  renderHistory();
  setStatus("练习历史已清空。", false);
}

/* ═══════════════════════════════════════════
   ACCURACY & VIBRATO
   ═══════════════════════════════════════════ */
function updateAccuracyAndVibrato(now) {
  if (statAccuracy && statCount > 0) {
    const pct = Math.round(statAccCount / statCount * 100);
    const txt = pct + "%";
    if (statAccuracy.textContent !== txt) statAccuracy.textContent = txt;
  }
  const vib = analyzeVibrato(timeline, now);
  if (!vib) {
    if (lastVibratoText !== "") { statVibrato.textContent = "--"; statVibratoSub.textContent = "--"; lastVibratoText = ""; }
    return;
  }
  const txt = `${vib.rate.toFixed(1)} Hz`;
  if (txt !== lastVibratoText) {
    statVibrato.textContent = txt;
    statVibratoSub.textContent = `幅度 ±${vib.extent.toFixed(0)}¢`;
    lastVibratoText = txt;
  }
}
function analyzeVibrato(pts, now) {
  const start = now - VIBRATO_WINDOW_MS;
  const seg = pts.filter(p => p.time >= start);
  if (seg.length < 40) return null;
  const vals = seg.map(p => p.midi);
  const peaks = [], troughs = [];
  for (let i = 1; i < vals.length - 1; i++) {
    if (vals[i] > vals[i - 1] && vals[i] >= vals[i + 1]) peaks.push(vals[i]);
    if (vals[i] < vals[i - 1] && vals[i] <= vals[i + 1]) troughs.push(vals[i]);
  }
  const cycles = Math.min(peaks.length, troughs.length);
  if (cycles < 3) return null;
  const tSpanMs = Math.max(1, seg[seg.length - 1].time - seg[0].time);
  const rate = cycles / (tSpanMs / 1000);
  if (rate < 2 || rate > 10) return null; // 人声颤音通常 4-7Hz
  let sum = 0;
  for (let k = 0; k < cycles; k++) sum += Math.abs(peaks[k] - troughs[k]);
  const extent = sum / cycles * 100; // 1 半音 = 100 cents
  return { rate, extent };
}

/* ═══════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════ */
document.addEventListener("keydown", (e) => {
  // Don't trigger shortcuts when typing in input fields
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  
  switch (e.key) {
    case " ":
    case "Enter":
      // Space/Enter: Toggle listening
      e.preventDefault();
      if (isListening) {
        stop();
      } else {
        start();
      }
      break;
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
      // Number keys: Switch vocal range
      const rangeKeys = ["bass", "tenor", "alto", "soprano", "wide"];
      const rangeIndex = parseInt(e.key) - 1;
      if (rangeIndex < rangeKeys.length) {
        const rangeKey = rangeKeys[rangeIndex];
        const range = RANGES[rangeKey];
        if (range) {
          minMidi = range.min;
          maxMidi = range.max;
          $$(".pill").forEach(p => p.classList.toggle("active", p.dataset.range === rangeKey));
          bgCache = null;
        }
      }
      break;
    case "t":
    case "T":
      // T: Toggle theme
      applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
      break;
    case "c":
    case "C":
      // C: Clear pitch roll
      clearPitchRoll();
      break;
    case "Escape":
      // Escape: Close guide or stop listening
      if (!guideOverlay.classList.contains("hidden")) {
        guideOverlay.classList.add("hidden");
        localStorage.setItem("vs_guide_seen", "1");
      } else if (isListening) {
        stop();
      }
      break;
    case "?":
      // ?: Show guide
      guideOverlay.classList.remove("hidden");
      break;
  }
});

/* ═══════════════════════════════════════════
   EVENTS
   ═══════════════════════════════════════════ */
startButton.addEventListener("click", start);
stopButton.addEventListener("click", stop);
clearRollButton.addEventListener("click", clearPitchRoll);
if (exportCsvButton) exportCsvButton.addEventListener("click", () => exportTimeline("csv"));
if (exportJsonButton) exportJsonButton.addEventListener("click", () => exportTimeline("json"));
if (recordButton) recordButton.addEventListener("click", () => { isRecording ? stopRecording() : startRecording(); });
if (playbackButton) playbackButton.addEventListener("click", togglePlayback);
if (targetToggle) targetToggle.addEventListener("click", toggleTargetMode);
if (targetPreset) targetPreset.addEventListener("change", applyPreset);
if (targetListen) targetListen.addEventListener("click", previewTarget);
if (summaryClose) summaryClose.addEventListener("click", () => summaryOverlay.classList.add("hidden"));
if (micSelect) {
  micSelect.addEventListener("change", () => {
    selectedMicId = micSelect.value || "";
    localStorage.setItem("vs_mic_id", selectedMicId);
  });
}
if ($("#clearHistoryButton")) $("#clearHistoryButton").addEventListener("click", clearHistory);
$$("#windowGroup .pill").forEach(b => b.addEventListener("click", () => {
  rollWindow = parseInt(b.dataset.window, 10) || 14000;
  $$("#windowGroup .pill").forEach(p => p.classList.toggle("active", p === b));
  trimTimeline();
  bgCache = null;
}));

// Debounced resize handler
let resizeTimeout;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(resizeRoll, 100);
});

pitchRoll.addEventListener("pointerdown", playKey);
// 从后台切回时恢复 AudioContext（Chrome 会暂停后台音频上下文）
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  if (refAudioCtx && refAudioCtx.state === "suspended") refAudioCtx.resume();
});
$$(".pill").forEach(b => b.addEventListener("click", () => {
  const r = RANGES[b.dataset.range];
  if (!r) return;
  minMidi = r.min; maxMidi = r.max;
  $$(".pill").forEach(p => p.classList.toggle("active", p === b));
  bgCache = null;
}));

resizeRoll();
rollAnimId = requestAnimationFrame(tickRoll);
loadMicDevices();
renderHistory();

/* ─── Scroll to top on load ─── */
window.scrollTo(0, 0);

/* ─── Scroll Reveal ─── */
const revealObs = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("visible"); revealObs.unobserve(e.target); } });
}, { threshold: 0.1, rootMargin: "0px 0px -30px 0px" });
$$(".hero, .roll-section, .stats-section, .history-section, .tips-section, .shortcuts-section, .tuner-panel").forEach((el) => revealObs.observe(el));

/* ─── Cleanup on page unload ─── */
window.addEventListener("beforeunload", () => {
  exitReplay();
  stopPreview();
  stopRecording();
  if (isListening) {
    cancelAnimationFrame(animId);
    stream?.getTracks().forEach(t => t.stop());
    audioCtx?.close();
  }
  if (refAudioCtx) {
    refAudioCtx.close();
    refAudioCtx = null;
  }
  cancelAnimationFrame(rollAnimId);
});
