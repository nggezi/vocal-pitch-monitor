/* ═══════════════════════════════════════════
   PITCH CORE — 回归测试
   运行：npm test 或 node test/pitch.test.js
   覆盖：纯音精度、弱基频泛音纠偏、静音/噪声拒绝、低音量识别。
   ═══════════════════════════════════════════ */
"use strict";

const assert = require("assert");
const { yin, PITCH_MIN, PITCH_MAX } = require("../pitch.js");

const SR = 48000;
const N = 4096;

// 确定性伪随机噪声（固定种子，测试可重复）
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function synth(f0, amps, noiseAmp, seed) {
  const rand = rng(seed || 42);
  const a = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let v = 0;
    for (let k = 0; k < amps.length; k++) {
      v += amps[k] * Math.sin(2 * Math.PI * f0 * (k + 1) * i / SR);
    }
    if (noiseAmp) v += (rand() * 2 - 1) * noiseAmp;
    a[i] = v;
  }
  let peak = 0;
  for (const v of a) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) {
    const s = 0.3 / peak;
    for (let i = 0; i < N; i++) a[i] *= s;
  }
  return a;
}

function centsBetween(a, b) {
  return Math.abs(1200 * Math.log2(a / b));
}

// 1. 纯音精度：全检测范围误差应小于 10 cents
const PURE_TONES = [55, 82, 110, 220, 330, 440, 660, 880, 1500];
for (const f of PURE_TONES) {
  const r = yin(synth(f, [1], 0), SR);
  assert.ok(r, `${f} Hz 纯音应被检测到`);
  assert.ok(
    centsBetween(r.freq, f) < 10,
    `${f} Hz 检测为 ${r.freq.toFixed(1)} Hz，误差 ${centsBetween(r.freq, f).toFixed(1)} cents`
  );
}
console.log(`PASS 纯音精度（${PURE_TONES.length} 个频点，误差 <10 cents）`);

// 2. 弱基频泛音纠偏：60 帧带噪信号应稳定锁定基频
const HARMONIC_CASES = [
  ["弱基频 + 强 2 次泛音", 220, [0.2, 1]],
  ["弱基频 + 强 3 次泛音", 220, [0.3, 0, 1]],
  ["弱基频 + 2/3/4 次泛音", 220, [0.2, 1, 0.8, 0.5]],
  ["常见泛音组合", 220, [0.4, 0.8, 0.6, 0.4]],
  ["女声泛音组合", 330, [0.3, 1, 0.8, 0.5]],
  ["男低泛音组合", 110, [0.3, 1, 0.8, 0.5]],
];
for (const [name, f0, amps] of HARMONIC_CASES) {
  for (let frame = 0; frame < 60; frame++) {
    const r = yin(synth(f0, amps, 0.05, 100 + frame), SR);
    assert.ok(r, `${name} 帧 ${frame} 应检测到音高`);
    assert.ok(
      centsBetween(r.freq, f0) < 60,
      `${name} 帧 ${frame} 锁定 ${r.freq.toFixed(1)} Hz（期望 ${f0} Hz）`
    );
  }
}
console.log(`PASS 弱基频泛音纠偏（${HARMONIC_CASES.length} 种音色 × 60 帧）`);

// 3. 静音与纯噪声应拒绝
assert.strictEqual(yin(new Float32Array(N), SR), null, "静音应返回 null");
const noise = synth(0, [0], 1, 7);
assert.strictEqual(yin(noise, SR), null, "白噪声应返回 null");
console.log("PASS 静音/噪声拒绝");

// 4. 低音量仍可识别（接近真实麦克风的安静输入）
const quiet = synth(440, [1], 0, 1);
const quietScale = 0.005 / 0.3;
for (let i = 0; i < quiet.length; i++) quiet[i] *= quietScale;
const q = yin(quiet, SR);
assert.ok(q, "低音量纯音应被检测到");
assert.ok(centsBetween(q.freq, 440) < 10, `低音量 440 Hz 检测为 ${q.freq.toFixed(1)} Hz`);
console.log("PASS 低音量识别");

// 5. 检测范围边界
assert.ok(PITCH_MIN <= 55 && PITCH_MAX >= 1500, "检测范围应覆盖 55–1500 Hz");
console.log(`PASS 频率范围（${PITCH_MIN}–${PITCH_MAX} Hz）`);

console.log("\n全部测试通过 ✓");
