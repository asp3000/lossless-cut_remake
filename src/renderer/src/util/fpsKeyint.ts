// [GOP 计算] 关键帧间隔取 0.2~0.5 秒内、能整除帧率的最小整数帧数：
// - 帧率 ≥24：归一到最近的 6 的倍数（29.97→30、30.1→30、50→48、25→24），keyint 恒为 6
// - 帧率 <24：保留四舍五入后的整数帧率，在 [0.2s, 0.5s] 区间取最小整除值（15→3、20→4）
// - 质数帧率（如 13/17/19）区间内无整除值时，取区间下限（最接近 0.2s）
// eslint-disable-next-line import/prefer-default-export -- 便于测试直接具名导入
export function normalizeFpsAndKeyint(fps: number): { outFps: number, keyint: number } {
  const fpsInt = Math.max(1, Math.round(fps));
  if (fpsInt >= 24) {
    const outFps = Math.round(fpsInt / 6) * 6;
    return { outFps, keyint: 6 };
  }
  const min = Math.max(1, Math.ceil(fpsInt * 0.2));
  const max = Math.max(min, Math.floor(fpsInt * 0.5));
  for (let k = min; k <= max; k += 1) {
    if (fpsInt % k === 0) return { outFps: fpsInt, keyint: k };
  }
  return { outFps: fpsInt, keyint: min };
}

// mp4 视频轨 timescale 选择：15360 能被常见帧率整除（30fps→每帧恰好 512 tick，
// 与用户源视频一致）；不能整除时用 fps×1000，保证 CFR 下每帧恰好整数 tick、无累积误差
export function timescaleForFps(outFps: number): number {
  return 15360 % outFps === 0 ? 15360 : outFps * 1000;
}
