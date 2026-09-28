import { expect, describe, it } from 'vitest';

import { normalizeFpsAndKeyint, timescaleForFps } from './fpsKeyint';

// 规则：关键帧间隔取 0.2~0.5s 内能整除帧率的最小整数；
// ≥24fps 归一到最近的 6 的倍数；非整数帧率四舍五入
describe('normalizeFpsAndKeyint', () => {
  it('fps < 24 uses smallest divisor of fps in the 0.2~0.5s range', () => {
    expect(normalizeFpsAndKeyint(15)).toEqual({ outFps: 15, keyint: 3 }); // 3 或 5 都整除，取最小
    expect(normalizeFpsAndKeyint(20)).toEqual({ outFps: 20, keyint: 4 }); // 4/5/10 都整除，取最小
  });

  it('fps >= 24 rounds fps to nearest multiple of 6 and keyint is 6', () => {
    expect(normalizeFpsAndKeyint(24)).toEqual({ outFps: 24, keyint: 6 }); // 6/8/12 都整除，取最小 6
    expect(normalizeFpsAndKeyint(30)).toEqual({ outFps: 30, keyint: 6 }); // 6/10/15 都整除，取最小 6
    expect(normalizeFpsAndKeyint(36)).toEqual({ outFps: 36, keyint: 6 });
    expect(normalizeFpsAndKeyint(60)).toEqual({ outFps: 60, keyint: 6 });
    expect(normalizeFpsAndKeyint(50)).toEqual({ outFps: 48, keyint: 6 }); // 48 和 54 就近取 48
    expect(normalizeFpsAndKeyint(25)).toEqual({ outFps: 24, keyint: 6 });
  });

  it('non-integer fps is rounded to integer', () => {
    expect(normalizeFpsAndKeyint(29.97)).toEqual({ outFps: 30, keyint: 6 });
    expect(normalizeFpsAndKeyint(30.1)).toEqual({ outFps: 30, keyint: 6 });
    expect(normalizeFpsAndKeyint(23.976)).toEqual({ outFps: 24, keyint: 6 });
  });

  it('prime fps below 24 falls back to range lower bound', () => {
    expect(normalizeFpsAndKeyint(13)).toEqual({ outFps: 13, keyint: 3 }); // 13 为质数无整除值，取 0.2s 下限
  });
});

// 规则：15360 能整除该帧率时用 15360（与源视频一致，30fps→512 tick/帧）；否则 fps×1000
describe('timescaleForFps', () => {
  it('returns 15360 when divisible by fps', () => {
    expect(timescaleForFps(30)).toBe(15360);
    expect(timescaleForFps(24)).toBe(15360);
    expect(timescaleForFps(48)).toBe(15360);
    expect(timescaleForFps(60)).toBe(15360);
    expect(timescaleForFps(15)).toBe(15360);
  });

  it('falls back to fps*1000 when not divisible', () => {
    expect(timescaleForFps(25)).toBe(25000); // 15360/25 非整数
    expect(timescaleForFps(13)).toBe(13000);
  });
});
