import type { CSSProperties } from 'react';

import type { SegmentTransform } from '../types';

// [片段级变换预览] 把片段的 hflip/vflip/rot 变换转成播放器 <video> 元素的 CSS transform，
// 实现实时播放预览（纯显示层变换，不解码、不重编码，GPU 加速，无性能开销）。
//
// 旋转 90°/270° 时需要把元素盒子宽高对调（否则旋转后画面溢出容器）：
// 元素绝对定位到容器中心，盒子尺寸 = 容器高x宽，再用 translate(-50%,-50%) 居中后旋转，
// 旋转后的盒子恰好填满容器，内容经 object-fit:contain 自动适配。
//
// CSS transform 链中右侧的函数先作用于内容：先旋转、后翻转，
// 与导出时的滤镜顺序（transpose → hflip/vflip）保持一致。
const getSegmentTransformPreviewStyle = (transform: SegmentTransform | undefined, containerSize: { width: number, height: number } | undefined): CSSProperties | undefined => {
  if (transform == null) return undefined;
  const { hflip, vflip, rot } = transform;
  if (!hflip && !vflip && rot == null) return undefined;

  const parts: string[] = [];
  const style: CSSProperties = {};

  if (rot != null) {
    const swapBox = rot === 90 || rot === 270;
    if (swapBox && containerSize != null) {
      style.position = 'absolute';
      style.left = '50%';
      style.top = '50%';
      style.width = containerSize.height;
      style.height = containerSize.width;
      parts.push('translate(-50%, -50%)', rot === 90 ? 'rotate(90deg)' : 'rotate(-90deg)');
    } else {
      // 180° 直接旋转；90°/270° 容器尺寸未知（极少发生）时兜底直接旋转
      parts.push(`rotate(${rot}deg)`);
    }
  }

  if (hflip) parts.push('scaleX(-1)');
  if (vflip) parts.push('scaleY(-1)');

  if (parts.length === 0) return undefined;
  return { ...style, transform: parts.join(' ') };
};

export default getSegmentTransformPreviewStyle;
