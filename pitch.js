/* ═══════════════════════════════════════════
   PITCH CORE — YIN pitch detection (v3.3)
   独立检测核心：浏览器挂载到全局 PitchCore，
   Node 环境通过 require 使用，便于回归测试。
   ═══════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PitchCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PITCH_MIN = 55;         // 人声检测最低频率（Hz）
  const PITCH_MAX = 1500;       // 人声检测最高频率（Hz），对应 MIDI 90，对齐宽音域上限
  const YIN_THRESHOLD = 0.15;   // 常规周期阈值（CMND）
  const YIN_STRONG_THRESHOLD = 0.05; // 强周期阈值：跳过弱泛音谷

  let yinBuf = null;

  function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
  }

  /**
   * YIN 音高检测：差分函数 + CMND + 阈值选谷 + 抛物线插值。
   * 只搜索人声频率范围（PITCH_MIN–PITCH_MAX）对应的 tau，并复用缓冲区。
   * 返回 { freq, confidence }，静音或无稳定周期时返回 null。
   */
  function yin(samples, sr) {
    const half = samples.length >> 1;
    if (!yinBuf || yinBuf.length !== half) yinBuf = new Float32Array(half);
    const buf = yinBuf;
    let energy = 0;
    for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
    if (energy < 1e-8) return null; // 静音直接返回

    const minTau = Math.max(2, Math.floor(sr / PITCH_MAX));
    const maxTau = Math.min(half - 1, Math.ceil(sr / PITCH_MIN));
    for (let t = minTau; t < maxTau; t++) {
      let s = 0;
      for (let i = 0; i < half - t; i++) {
        const d = samples[i] - samples[i + t];
        s += d * d;
      }
      buf[t] = s;
    }

    // 预累计小 tau 的原始差分，避免 CMND 首个谷被自归一化放大导致高频八度误检
    let warmSum = 0;
    for (let t = 2; t < minTau; t++) {
      let s = 0;
      for (let i = 0; i < half - t; i++) {
        const d = samples[i] - samples[i + t];
        s += d * d;
      }
      warmSum += s;
    }
    buf[minTau - 1] = warmSum;

    let sum = 0, minVal = Infinity, minTauFound = -1;
    for (let t = minTau - 1; t < maxTau; t++) {
      sum += buf[t];
      // 周期整数倍处差分值可能下溢为 0，避免 NaN 丢谷
      buf[t] = sum > 1e-12 ? buf[t] * t / sum : 0;
      if (t >= minTau && buf[t] < minVal) {
        minVal = buf[t];
        minTauFound = t;
      }
    }
    if (minTauFound === -1 || minVal > YIN_THRESHOLD) return null;

    // 泛音纠偏：先找第一个足够深的周期谷（<0.05）。
    // 弱基频信号在半周期/1/3 周期处通常只有 0.06~0.15 的浅谷，
    // 真正的基频谷深得多，跳过浅谷即可避免把泛音当基频。
    let tau = -1;
    for (let t = minTau; t < maxTau - 1; t++) {
      if (buf[t] < YIN_STRONG_THRESHOLD) {
        while (t + 1 < maxTau && buf[t + 1] < buf[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau === -1) {
      // 没有足够深的谷时退回常规阈值，取第一个低于 0.15 的谷
      for (let t = minTau; t < maxTau - 1; t++) {
        if (buf[t] < YIN_THRESHOLD) {
          while (t + 1 < maxTau && buf[t + 1] < buf[t]) t++;
          tau = t;
          break;
        }
      }
      if (tau === -1) tau = minTauFound;
    }

    const s0 = buf[tau - 1] ?? buf[tau], s1 = buf[tau], s2 = buf[tau + 1] ?? s1;
    if (s1 < 1e-6) return { freq: sr / tau, confidence: minVal }; // 完美周期，不插值
    const d = s0 - 2 * s1 + s2;
    const shift = d === 0 ? 0 : clamp((s0 - s2) / (2 * d), -0.5, 0.5);
    return {
      freq: sr / (tau + (isNaN(shift) ? 0 : shift)),
      confidence: minVal,
    };
  }

  return { yin, PITCH_MIN, PITCH_MAX, YIN_THRESHOLD, YIN_STRONG_THRESHOLD };
});
