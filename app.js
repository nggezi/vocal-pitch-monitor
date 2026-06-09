const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const statusText = document.querySelector("#status");
const noteName = document.querySelector("#noteName");
const frequencyValue = document.querySelector("#frequencyValue");
const centsText = document.querySelector("#centsText");
const targetFrequency = document.querySelector("#targetFrequency");
const stability = document.querySelector("#stability");
const volume = document.querySelector("#volume");
const needle = document.querySelector("#needle");
const pitchRoll = document.querySelector("#pitchRoll");
const clearRollButton = document.querySelector("#clearRollButton");
const rangeButtons = document.querySelectorAll(".range-button");
const rollContext = pitchRoll.getContext("2d");

const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const pitchHistory = [];
const pitchTimeline = [];
const rollWindowMs = 14000;
const vocalRanges = {
  bass: { min: 36, max: 67 },
  tenor: { min: 43, max: 76 },
  alto: { min: 48, max: 81 },
  soprano: { min: 55, max: 88 },
  wide: { min: 33, max: 93 },
};

let audioContext;
let referenceAudioContext;
let analyser;
let microphone;
let mediaStream;
let animationId;
let rollAnimationId;
let buffer;
let minMidi = vocalRanges.tenor.min;
let maxMidi = vocalRanges.tenor.max;
let lastRollLayout = { keyboardWidth: 76, height: 430 };
let smoothedFrequency = null;
let smoothedCents = null;
let lastPitchTime = 0;
const SMOOTH_FACTOR = 0.15;
const CENTS_SMOOTH = 0.2;
const VOLUME_THRESHOLD = 0.006;
const HOLD_MS = 350;

function getThemeColor(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function getCanvasColors() {
  return {
    bg: getThemeColor("--roll-bg") || "#070910",
    grid: getThemeColor("--roll-grid") || "rgba(255,255,255,0.055)",
    cGrid: getThemeColor("--roll-c-grid") || "rgba(142,255,210,0.26)",
    keyLight: getThemeColor("--roll-key-light") || "#eef2ff",
    keyDark: getThemeColor("--roll-key-dark") || "#11131c",
    keyBlack: getThemeColor("--roll-key-black") || "#05060a",
    labelLight: getThemeColor("--roll-label-light") || "#141824",
    labelDark: getThemeColor("--roll-label-dark") || "#f4f7ff",
    text: getThemeColor("--roll-text") || "rgba(255,255,255,0.42)",
    border: getThemeColor("--roll-border") || "rgba(255,255,255,0.10)",
    accent: getThemeColor("--accent") || "#8effd2",
  };
}

startButton.addEventListener("click", startListening);
stopButton.addEventListener("click", stopListening);
clearRollButton.addEventListener("click", clearPitchRoll);
window.addEventListener("resize", resizePitchRoll);
pitchRoll.addEventListener("pointerdown", playPianoKeyFromPointer);
rangeButtons.forEach((button) => button.addEventListener("click", setVocalRange));

resizePitchRoll();
rollAnimationId = requestAnimationFrame(updatePitchRoll);

async function startListening() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("当前浏览器不支持麦克风，请换用新版 Chrome / Edge。", true);
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    microphone = audioContext.createMediaStreamSource(mediaStream);
    microphone.connect(analyser);
    buffer = new Float32Array(analyser.fftSize);

    startButton.disabled = true;
    stopButton.disabled = false;
    setStatus("正在监听。请唱一个稳定的单音。", false);
    detectPitch();
  } catch (error) {
    setStatus("无法打开麦克风：" + error.message, true);
  }
}

function stopListening() {
  cancelAnimationFrame(animationId);
  animationId = undefined;
  pitchHistory.length = 0;
  smoothedFrequency = null;
  smoothedCents = null;

  if (microphone) {
    microphone.disconnect();
    microphone = undefined;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = undefined;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = undefined;
  }

  startButton.disabled = false;
  stopButton.disabled = true;
  resetDisplay();
  setStatus("已停止监听。", false);
}

function detectPitch() {
  analyser.getFloatTimeDomainData(buffer);

  const rms = getRms(buffer);
  volume.textContent = Math.round(rms * 1000);
  const now = performance.now();

  const rawFrequency = yinDetect(buffer, audioContext.sampleRate);

  const hasVoice = rawFrequency !== null && rawFrequency >= 65 && rawFrequency <= 1200 && rms >= VOLUME_THRESHOLD;

  if (hasVoice) {
    lastPitchTime = now;

    if (smoothedFrequency !== null) {
      const jumpCents = Math.abs(1200 * Math.log2(rawFrequency / smoothedFrequency));
      if (jumpCents > 400) {
        animationId = requestAnimationFrame(detectPitch);
        return;
      }
    }

    if (smoothedFrequency === null) {
      smoothedFrequency = rawFrequency;
    } else {
      smoothedFrequency = smoothedFrequency + SMOOTH_FACTOR * (rawFrequency - smoothedFrequency);
    }

    const note = frequencyToNote(smoothedFrequency);
    const target = noteToFrequency(note.midi);
    const cents = 1200 * Math.log2(smoothedFrequency / target);

    if (smoothedCents === null) {
      smoothedCents = cents;
    } else {
      smoothedCents = smoothedCents + CENTS_SMOOTH * (cents - smoothedCents);
    }

    const centsRounded = Math.round(smoothedCents);

    pitchHistory.push(cents);
    if (pitchHistory.length > 18) pitchHistory.shift();
    recordPitchPoint(smoothedFrequency, rms);

    noteName.textContent = note.name;
    frequencyValue.textContent = smoothedFrequency.toFixed(1);
    targetFrequency.textContent = target.toFixed(1) + " Hz";
    centsText.textContent = describeCents(centsRounded);
    stability.textContent = describeStability(pitchHistory);
    needle.style.left = (50 + clamp(smoothedCents, -50, 50)) + "%";
    setStatus("正在监听。请保持音量稳定。", false);

  } else if (smoothedFrequency !== null && now - lastPitchTime < HOLD_MS) {
    recordPitchPoint(smoothedFrequency, rms);

  } else {
    showNoPitch(rms < VOLUME_THRESHOLD ? "音量太小，请靠近麦克风。" : "暂未检测到稳定音高。");
    smoothedFrequency = null;
    smoothedCents = null;
  }

  animationId = requestAnimationFrame(detectPitch);
}

function yinDetect(samples, sampleRate) {
  const halfLen = Math.floor(samples.length / 2);
  const yinBuffer = new Float32Array(halfLen);

  for (let tau = 0; tau < halfLen; tau++) {
    let sum = 0;
    for (let i = 0; i < halfLen; i++) {
      const delta = samples[i] - samples[i + tau];
      sum += delta * delta;
    }
    yinBuffer[tau] = sum;
  }

  yinBuffer[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < halfLen; tau++) {
    runningSum += yinBuffer[tau];
    yinBuffer[tau] = yinBuffer[tau] * tau / runningSum;
  }

  const threshold = 0.15;
  let tauEstimate = -1;

  for (let tau = 2; tau < halfLen; tau++) {
    if (yinBuffer[tau] < threshold) {
      while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) {
        tau++;
      }
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate === -1) return null;

  const s0 = yinBuffer[tauEstimate - 1];
  const s1 = yinBuffer[tauEstimate];
  const s2 = yinBuffer[tauEstimate + 1] ?? s1;
  const shift = (s0 - s2) / (2 * (s0 - 2 * s1 + s2));
  const period = tauEstimate + (isNaN(shift) ? 0 : shift);

  return sampleRate / period;
}

function getRms(samples) {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function frequencyToNote(frequency) {
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  const octave = Math.floor(midi / 12) - 1;
  const name = noteNames[((midi % 12) + 12) % 12] + octave;
  return { midi, name };
}

function noteToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function describeCents(cents) {
  if (Math.abs(cents) <= 5) return "非常准";
  if (cents > 0) return "偏高 " + cents + " cents";
  return "偏低 " + Math.abs(cents) + " cents";
}

function describeStability(values) {
  if (values.length < 6) return "采样中";
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / values.length;
  const deviation = Math.sqrt(variance);
  if (deviation <= 6) return "很稳定";
  if (deviation <= 14) return "较稳定";
  return "波动明显";
}

function showNoPitch(message) {
  noteName.textContent = "--";
  frequencyValue.textContent = "--";
  targetFrequency.textContent = "-- Hz";
  centsText.textContent = "--";
  stability.textContent = "--";
  needle.style.left = "50%";
  pitchHistory.length = 0;
  smoothedFrequency = null;
  smoothedCents = null;
  setStatus(message, false);
}

function resetDisplay() {
  noteName.textContent = "--";
  frequencyValue.textContent = "--";
  centsText.textContent = "--";
  targetFrequency.textContent = "-- Hz";
  stability.textContent = "--";
  volume.textContent = "--";
  needle.style.left = "50%";
  smoothedFrequency = null;
  smoothedCents = null;
}

function recordPitchPoint(frequency, rms) {
  const midi = 69 + 12 * Math.log2(frequency / 440);
  const now = performance.now();
  pitchTimeline.push({ midi, frequency, rms, time: now });
  trimPitchTimeline(now);
}

function clearPitchRoll() {
  pitchTimeline.length = 0;
  drawPitchRoll();
}

function trimPitchTimeline(now) {
  while (pitchTimeline.length && pitchTimeline[0].time < now - rollWindowMs) {
    pitchTimeline.shift();
  }
}

function resizePitchRoll() {
  const ratio = window.devicePixelRatio || 1;
  const rect = pitchRoll.getBoundingClientRect();
  pitchRoll.width = Math.max(1, Math.floor(rect.width * ratio));
  pitchRoll.height = Math.max(1, Math.floor(rect.height * ratio));
  rollContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  drawPitchRoll();
}

function updatePitchRoll() {
  drawPitchRoll();
  rollAnimationId = requestAnimationFrame(updatePitchRoll);
}

function drawPitchRoll() {
  const width = pitchRoll.clientWidth;
  const height = pitchRoll.clientHeight;
  const now = performance.now();
  const keyboardWidth = width < 560 ? 54 : 76;
  const plotLeft = keyboardWidth;
  const plotWidth = width - plotLeft;
  const rowHeight = height / (maxMidi - minMidi + 1);

  lastRollLayout = { keyboardWidth, height };
  trimPitchTimeline(now);
  rollContext.clearRect(0, 0, width, height);
  drawRollBackground(width, height, keyboardWidth, rowHeight);
  drawTimeGrid(plotLeft, plotWidth, height, now);
  drawPitchPath(plotLeft, plotWidth, height, now);
}

function drawRollBackground(width, height, keyboardWidth, rowHeight) {
  const c = getCanvasColors();
  rollContext.fillStyle = c.bg;
  rollContext.fillRect(0, 0, width, height);

  for (let midi = maxMidi; midi >= minMidi; midi -= 1) {
    const y = midiToY(midi, height);
    const noteIndex = ((midi % 12) + 12) % 12;
    const isBlack = [1, 3, 6, 8, 10].includes(noteIndex);
    const isC = noteIndex === 0;

    rollContext.fillStyle = isBlack ? "rgba(128,128,128,0.06)" : "rgba(128,128,128,0.12)";
    rollContext.fillRect(keyboardWidth, y, width - keyboardWidth, rowHeight);

    rollContext.strokeStyle = isC ? c.cGrid : c.grid;
    rollContext.lineWidth = isC ? 1.5 : 1;
    rollContext.beginPath();
    rollContext.moveTo(keyboardWidth, y);
    rollContext.lineTo(width, y);
    rollContext.stroke();

    rollContext.fillStyle = isBlack ? c.keyDark : c.keyLight;
    rollContext.fillRect(0, y + 1, keyboardWidth - 8, Math.max(1, rowHeight - 2));

    if (isBlack) {
      rollContext.fillStyle = c.keyBlack;
      rollContext.fillRect(0, y + 2, keyboardWidth * 0.64, Math.max(1, rowHeight - 4));
    }

    if (noteIndex === 0 || noteIndex === 4 || noteIndex === 7) {
      rollContext.fillStyle = isBlack ? c.labelDark : c.labelLight;
      rollContext.font = "700 11px system-ui, sans-serif";
      rollContext.textAlign = "right";
      rollContext.textBaseline = "middle";
      rollContext.fillText(midiToNoteName(midi), keyboardWidth - 14, y + rowHeight / 2);
    }
  }

  rollContext.fillStyle = c.border;
  rollContext.fillRect(keyboardWidth - 8, 0, 1, height);
}

function drawTimeGrid(plotLeft, plotWidth, height, now) {
  const c = getCanvasColors();
  rollContext.strokeStyle = c.grid;
  rollContext.lineWidth = 1;

  for (let secondsAgo = 0; secondsAgo <= rollWindowMs / 1000; secondsAgo += 2) {
    const x = plotLeft + plotWidth - (secondsAgo * 1000 / rollWindowMs) * plotWidth;
    rollContext.beginPath();
    rollContext.moveTo(x, 0);
    rollContext.lineTo(x, height);
    rollContext.stroke();
  }

  rollContext.fillStyle = c.text;
  rollContext.font = "700 11px system-ui, sans-serif";
  rollContext.textAlign = "right";
  rollContext.textBaseline = "top";
  rollContext.fillText("now", plotLeft + plotWidth - 10, 10);
  rollContext.textAlign = "left";
  rollContext.fillText("-" + Math.round(rollWindowMs / 1000) + "s", plotLeft + 10, 10);
}

function drawPitchPath(plotLeft, plotWidth, height, now) {
  const c = getCanvasColors();
  const points = pitchTimeline.filter((point) => point.midi >= minMidi && point.midi <= maxMidi);

  if (!points.length) {
    rollContext.fillStyle = c.text;
    rollContext.font = "800 18px system-ui, sans-serif";
    rollContext.textAlign = "center";
    rollContext.textBaseline = "middle";
    rollContext.fillText("开始唱歌后，这里会出现音高轨迹", plotLeft + plotWidth / 2, height / 2);
    return;
  }

  rollContext.lineCap = "round";
  rollContext.lineJoin = "round";

  drawPathStroke(points, plotLeft, plotWidth, height, now, c.accent + "38", 5);
  drawPathStroke(points, plotLeft, plotWidth, height, now, c.accent + "f2", 2);

  const last = points[points.length - 1];
  const x = timeToX(last.time, plotLeft, plotWidth, now);
  const y = midiToCenterY(last.midi, height);
  rollContext.fillStyle = c.accent;
  rollContext.beginPath();
  rollContext.arc(x, y, 3.5, 0, Math.PI * 2);
  rollContext.fill();
  drawLivePitchLabel(last, x, y, plotLeft, plotWidth, height, c);
}

function drawLivePitchLabel(point, x, y, plotLeft, plotWidth, height, c) {
  rollContext.font = "800 12px system-ui, sans-serif";
  const label = midiToNoteName(Math.round(point.midi));
  const paddingX = 8;
  const boxHeight = 24;
  const boxWidth = rollContext.measureText(label).width + paddingX * 2;
  const labelX = clamp(x + 10, plotLeft + 6, plotLeft + plotWidth - boxWidth - 8);
  const labelY = clamp(y - boxHeight - 8, 8, height - boxHeight - 8);

  rollContext.fillStyle = c.bg;
  rollContext.globalAlpha = 0.88;
  rollContext.fillRect(labelX, labelY, boxWidth, boxHeight);
  rollContext.globalAlpha = 1;
  rollContext.strokeStyle = c.accent;
  rollContext.lineWidth = 1;
  rollContext.strokeRect(labelX, labelY, boxWidth, boxHeight);
  rollContext.fillStyle = c.accent;
  rollContext.textAlign = "left";
  rollContext.textBaseline = "middle";
  rollContext.fillText(label, labelX + paddingX, labelY + boxHeight / 2);
}

function drawPathStroke(points, plotLeft, plotWidth, height, now, color, lineWidth) {
  rollContext.strokeStyle = color;
  rollContext.lineWidth = lineWidth;
  rollContext.beginPath();
  let previous;
  for (const point of points) {
    const x = timeToX(point.time, plotLeft, plotWidth, now);
    const y = midiToCenterY(point.midi, height);
    if (!previous || point.time - previous.time > 350) {
      rollContext.moveTo(x, y);
    } else {
      rollContext.lineTo(x, y);
    }
    previous = point;
  }
  rollContext.stroke();
}

function timeToX(time, plotLeft, plotWidth, now) {
  return plotLeft + ((time - (now - rollWindowMs)) / rollWindowMs) * plotWidth;
}

function midiToY(midi, height) {
  return ((maxMidi - midi) / (maxMidi - minMidi + 1)) * height;
}

function midiToCenterY(midi, height) {
  return ((maxMidi - midi + 0.5) / (maxMidi - minMidi + 1)) * height;
}

function midiToNoteName(midi) {
  const octave = Math.floor(midi / 12) - 1;
  return noteNames[((midi % 12) + 12) % 12] + octave;
}

function setVocalRange(event) {
  const range = vocalRanges[event.currentTarget.dataset.range];
  if (!range) return;
  minMidi = range.min;
  maxMidi = range.max;
  rangeButtons.forEach((button) => button.classList.toggle("active", button === event.currentTarget));
  drawPitchRoll();
}

function playPianoKeyFromPointer(event) {
  const rect = pitchRoll.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x > lastRollLayout.keyboardWidth - 8) return;
  const midi = yToMidi(y, lastRollLayout.height);
  playReferenceNote(midi);
  setStatus("参考音：" + midiToNoteName(midi) + " " + noteToFrequency(midi).toFixed(1) + " Hz", false);
}

function yToMidi(y, height) {
  const rowHeight = height / (maxMidi - minMidi + 1);
  const indexFromTop = clamp(Math.floor(y / rowHeight), 0, maxMidi - minMidi);
  return maxMidi - indexFromTop;
}

function playReferenceNote(midi) {
  referenceAudioContext = referenceAudioContext || new AudioContext();
  if (referenceAudioContext.state === "suspended") {
    referenceAudioContext.resume();
  }
  const oscillator = referenceAudioContext.createOscillator();
  const gain = referenceAudioContext.createGain();
  const now = referenceAudioContext.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(noteToFrequency(midi), now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.62);
  oscillator.connect(gain);
  gain.connect(referenceAudioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.65);
}

function setStatus(message, isError) {
  statusText.textContent = message;
  statusText.style.color = isError ? "var(--bad)" : "var(--muted)";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/* --- Theme Toggle --- */
const themeToggle = document.querySelector("#themeToggle");

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
}

themeToggle.addEventListener("click", function () {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "light" ? "dark" : "light");
});

const savedTheme = localStorage.getItem("theme");
if (savedTheme) {
  applyTheme(savedTheme);
}

/* --- Scroll Reveal --- */
const revealObserver = new IntersectionObserver(
  function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
);

document.querySelectorAll(".hero, .roll-card, .tips").forEach(function (el) {
  revealObserver.observe(el);
});
