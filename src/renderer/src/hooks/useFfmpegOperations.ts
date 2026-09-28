import { useCallback } from 'react';
import sum from 'lodash/sum';
import pMap from 'p-map';
import invariant from 'tiny-invariant';
import i18n from 'i18next';

import { getSuffixedOutPath, transferTimestamps, getOutFileExtension, getOutDir, getHtml5ifiedPath, unlinkWithRetry, getFrameDuration, isMac, html5ifiedPrefix, html5dummySuffix, assertFileExists, copyFilePreserveTimestamps } from '../util';
import { isCuttingStart, isCuttingEnd, runFfmpegWithProgress, getFfCommandLine, getDuration, createChaptersFromSegments, readFileFfprobeMeta, getExperimentalArgs, getVideoTimescaleArgs, logStdoutStderr, runFfmpegConcat, RefuseOverwriteError, runFfmpeg, readFrames, readStreamFrameCount } from '../ffmpeg';
import { getEffectiveAvoidNegativeTs, getMapStreamsArgs, getStreamIdsToCopy } from '../util/streams';
import { needsSmartCut, getCodecParams } from '../smartcut';
import { getGuaranteedSegments, isDurationValid, segmentsTileFile } from '../segments';
import { normalizeFpsAndKeyint, timescaleForFps } from '../util/fpsKeyint';
import type { FFprobeStream } from '../../../common/ffprobe';
import type { AvoidNegativeTs, FfmpegHwAccel, Html5ifyMode, PreserveMetadata } from '../../../common/types';
import { deleteDispositionValue, type AllFilesMeta, type Chapter, type CopyfileStreams, type LiteFFprobeStream, type ParamsByFile, type SegmentToExport, type SegmentTransform } from '../types';
import type { LossyMode } from '../../../main';
import { UserFacingError } from '../../errors';
import mainApi from '../mainApi';
import { formatFfmpegNumber, getFixChannelLayoutFilter, getHwaccelArgs, hasCustomChannelLayout } from '../../../common/util';

const { join, resolve, dirname } = window.require('node:path');
const { writeFile, mkdir, access, constants: { W_OK } } = window.require('node:fs/promises');


export class OutputNotWritableError extends Error {
  constructor() {
    super();
    this.name = 'OutputNotWritableError';
  }
}

// [片段级变换] 把片段的 hflip/vflip/rot 变换转为 ffmpeg 视频滤镜链。
// rot 为顺时针角度：90° = transpose=1，180° = 两次 transpose=1，270° = transpose=2；
// 先旋转后翻转。fitToSourceDims 用于合并模式下把旋转片段 letterbox 回源尺寸，
// 避免 concat 时各分段帧尺寸不一致。
function getTransformVideoFilters(transform: SegmentTransform | undefined, fitToSourceDims: { width: number, height: number } | undefined): string[] {
  if (transform == null) return [];
  const filters: string[] = [];
  if (transform.rot != null) {
    if (transform.rot === 270) filters.push('transpose=2');
    else if (transform.rot === 180) filters.push('transpose=1', 'transpose=1');
    else filters.push('transpose=1');
  }
  if (transform.hflip) filters.push('hflip');
  if (transform.vflip) filters.push('vflip');
  if (fitToSourceDims != null) {
    filters.push(
      `scale=${fitToSourceDims.width}:${fitToSourceDims.height}:force_original_aspect_ratio=decrease`,
      `pad=${fitToSourceDims.width}:${fitToSourceDims.height}:(ow-iw)/2:(oh-ih)/2`,
    );
  }
  return filters;
}

async function writeChaptersFfmetadata(outDir: string, chapters: Chapter[] | undefined) {
  if (!chapters || chapters.length === 0) return undefined;

  const path = join(outDir, `ffmetadata-${Date.now()}.txt`);

  const ffmetadata = chapters.map(({ start, end, name }) => (
    `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.floor(start * 1000)}\nEND=${Math.floor(end * 1000)}\ntitle=${name || ''}`
  )).join('\n\n');
  console.log('Writing chapters', ffmetadata);
  await writeFile(path, ffmetadata);
  return path;
}

// Muxers implemented by ffmpeg's movenc.c, i.e. the ones that accept `-movflags`.
// Note: deliberately not util/streams.ts `isMov`, which is a narrower, UI oriented list.
const movencFormats = new Set(['3g2', '3gp', 'f4v', 'ipod', 'ismv', 'mov', 'mp4', 'psp']);

// [帧号精确吸附] 关键帧切割（流复制）下，ffmpeg 的 `-ss` 输入寻址实际落在 ≤ 切点的
// 关键帧上，而帧数若按名义切点计算，分段之间就会出现内容缝隙或重复（各段帧数之和
// 与源一致只是巧合性抵消）。这里一次性扫描全部关键帧（packet 标志位，纯解封装），
// 把每段起点吸附到 ≤ start 的关键帧，帧数取相邻段实际起点帧号之差（telescoping）：
// 分段铺满整个文件时，各段帧数之和恒等于源视频总帧数，且段间无缝无重叠。
// 仅在"只复制视频流"（无音轨等其它流）时启用——此时无需 -t 限制音频，
// `-frames:v` 可以独立决定视频长度。
async function computeSnappedFrameRanges({ filePath, videoStreamIndex, segments, fps, fileDuration }: {
  filePath: string,
  videoStreamIndex: number,
  segments: SegmentToExport[],
  fps: number,
  fileDuration: number | undefined,
}): Promise<{ ssTime: number | undefined, frameCount: number }[] | undefined> {
  const frames = await readFrames({ filePath, streamIndex: videoStreamIndex });
  if (frames.length === 0) return undefined;
  const kfTimes = frames.filter((frame) => frame.keyframe).map((frame) => frame.time);
  if (kfTimes.length === 0) return undefined;
  const firstPacketTime = frames[0]!.time;

  const totalFrames = await readStreamFrameCount({ filePath, streamIndex: videoStreamIndex })
    // 元数据缺失时用 (fileDuration - 首包时间) * fps 估算；仍不可用则放弃吸附
    ?? (fileDuration != null && Number.isFinite(fileDuration) ? Math.round((fileDuration - firstPacketTime) * fps) : undefined);
  if (totalFrames == null || totalFrames <= 0) return undefined;

  const halfFrame = 0.5 / fps;
  const relFrame = (t: number) => Math.round((t - firstPacketTime) * fps);

  const starts = segments.map(({ start }) => {
    if (start <= firstPacketTime + halfFrame) return { startF: 0, ssTime: undefined as number | undefined };
    let kfTime: number | undefined;
    for (let i = kfTimes.length - 1; i >= 0; i -= 1) {
      if (kfTimes[i]! <= start + halfFrame) { kfTime = kfTimes[i]; break; }
    }
    if (kfTime == null) return undefined;
    return { startF: relFrame(kfTime), ssTime: kfTime };
  });
  if (starts.some((s) => s == null)) return undefined;

  const tiling = segmentsTileFile(segments, fileDuration);
  const eps = 0.05;
  const result: { ssTime: number | undefined, frameCount: number }[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const { end } = segments[i]!;
    const s = starts[i]!;
    let endF: number;
    if (tiling) {
      // 铺满模式：本段终点 = 下一段实际起点；末段 = 源视频总帧数
      endF = i < segments.length - 1 ? starts[i + 1]!.startF : totalFrames;
    } else if (fileDuration != null && fileDuration - end <= eps) {
      endF = totalFrames;
    } else {
      endF = relFrame(end);
    }
    const frameCount = endF - s.startF;
    if (frameCount < 1) return undefined;
    result.push({ ssTime: s.ssTime, frameCount });
  }
  // 铺满模式下吸附后的起点必须严格递增，否则会出现段间重叠
  if (tiling) {
    for (let i = 1; i < result.length; i += 1) {
      const prev = starts[i - 1]!.startF;
      const cur = starts[i]!.startF;
      if (cur <= prev) return undefined;
    }
  }
  return result;
}

// Muxers implemented by ffmpeg's matroskaenc.c, i.e. the ones that accept `-default_mode`.
const matroskaencFormats = new Set(['matroska', 'webm']);

// ffmpeg tolerates private options belonging to a different muxer, but they add noise to the command line
// that we log, show in "Last commands" and include in error reports - which makes troubleshooting harder.
// If the output format is unknown, ffmpeg infers the muxer from the file extension, so keep the flags to be safe.
function getMovFlags({ outFormat, preserveMovData, movFastStart }: { outFormat: string | undefined, preserveMovData: boolean, movFastStart: boolean }) {
  if (outFormat != null && !movencFormats.has(outFormat)) return [];

  const flags: string[] = [];

  // https://video.stackexchange.com/a/26084/29486
  // https://github.com/mifi/lossless-cut/issues/331#issuecomment-623401794
  if (preserveMovData) flags.push('use_metadata_tags');

  // https://github.com/mifi/lossless-cut/issues/347
  if (movFastStart) flags.push('+faststart');

  if (flags.length === 0) return [];
  return flags.flatMap((flag) => ['-movflags', flag]);
}

// same as getMovFlags, but for the matroska muxer's private options
function getMatroskaFlags(outFormat: string | undefined) {
  if (outFormat != null && !matroskaencFormats.has(outFormat)) return [];

  return [
    '-default_mode', 'infer_no_subs',
    // because it makes sense to not force subtitles disposition to "default" if they were not default in the input file
    // after some testing, it seems that default is actually "infer", contrary to what is documented (ffmpeg doc says "passthrough" is default)
    // https://ffmpeg.org/ffmpeg-formats.html#Options-8
    // https://github.com/mifi/lossless-cut/issues/972#issuecomment-1015176316
  ];
}

const getChaptersInputArgs = (ffmetadataPath: string | undefined) => (ffmetadataPath ? ['-f', 'ffmetadata', '-i', ffmetadataPath] : []);

async function tryDeleteFiles(paths: string[]) {
  return pMap(paths, (path) => unlinkWithRetry(path).catch((err) => console.error('Failed to delete', path, err)), { concurrency: 5 });
}

export async function maybeMkDeepOutDir({ outputDir, fileOutPath }: { outputDir: string, fileOutPath: string }) {
  // cutFileNames might contain slashes and therefore might have a subdir(tree) that we need to mkdir
  // https://github.com/mifi/lossless-cut/issues/1532
  const actualOutputDir = dirname(fileOutPath);
  if (actualOutputDir !== outputDir) await mkdir(actualOutputDir, { recursive: true });
}


function useFfmpegOperations({ filePath, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart, isEncoding, lossyMode, enableOverwriteOutput, outputPlaybackRate, cutFromAdjustmentFrames, cutToAdjustmentFrames, appendLastCommandsLog, encCustomBitrate, appendFfmpegCommandLog, ffmpegHwaccel, hwEncode }: {
  filePath: string | undefined,
  treatInputFileModifiedTimeAsStart: boolean,
  treatOutputFileModifiedTimeAsStart: boolean | null | undefined,
  enableOverwriteOutput: boolean,
  isEncoding: boolean,
  lossyMode: LossyMode | undefined,
  outputPlaybackRate: number,
  cutFromAdjustmentFrames: number,
  cutToAdjustmentFrames: number,
  appendLastCommandsLog: (a: string) => void,
  encCustomBitrate: number | undefined,
  appendFfmpegCommandLog: (args: string[]) => void,
  ffmpegHwaccel: FfmpegHwAccel,
  // [硬件编码] 有变换片段重编码时改用 NVENC（h264_nvenc），大幅降低 CPU 占用
  hwEncode: boolean,
}) {
  const shouldSkipExistingFile = useCallback(async (path: string) => {
    const fileExists = await mainApi.pathExists(path);

    // If output file exists, check that it is writable, so we can inform user if it's not (or else ffmpeg will fail with "Permission denied")
    // this seems to sometimes happen on Windows, not sure why.
    if (fileExists) {
      try {
        await access(path, W_OK);
      } catch {
        throw new OutputNotWritableError();
      }
    }
    const shouldSkip = !enableOverwriteOutput && fileExists;
    if (shouldSkip) console.log('Not overwriting existing file', path);
    return shouldSkip;
  }, [enableOverwriteOutput]);

  const getOutputPlaybackRateArgs = useCallback(() => (outputPlaybackRate !== 1 ? ['-itsscale', String(1 / outputPlaybackRate)] : []), [outputPlaybackRate]);

  const concatFiles = useCallback(async ({ paths, outDir, outPath, metadataFromPath, includeAllStreams, streams, outFormat, ffmpegExperimental, onProgress = () => undefined, preserveMovData, movFastStart, chapters, preserveMetadataOnMerge, videoTimebase, videoOnly }: {
    paths: string[],
    outDir: string | undefined,
    outPath: string,
    metadataFromPath: string,
    includeAllStreams: boolean,
    streams: FFprobeStream[],
    outFormat?: string | undefined,
    ffmpegExperimental: boolean,
    onProgress?: (a: number) => void,
    preserveMovData: boolean,
    movFastStart: boolean,
    chapters: Chapter[] | undefined,
    preserveMetadataOnMerge: boolean,
    videoTimebase?: number | undefined,
    videoOnly?: boolean | undefined,
  }) => {
    if (await shouldSkipExistingFile(outPath)) return { haveExcludedStreams: false };

    console.log('Merging files', { paths }, 'to', outPath);

    const durations = await pMap(paths, async (path) => (await getDuration(path)) ?? 0, { concurrency: 1 });
    const totalDuration = sum(durations);

    let chaptersPath: string | undefined;
    if (chapters) {
      const chaptersWithNames = chapters.map((chapter, i) => ({ ...chapter, name: chapter.name || `Chapter ${i + 1}` }));
      invariant(outDir != null);
      chaptersPath = await writeChaptersFfmetadata(outDir, chaptersWithNames);
    }

    try {
      let inputArgs: string[] = [];
      let inputIndex = 0;

      // Keep track of input index to be used later
      // eslint-disable-next-line no-inner-declarations
      function addInput(args: string[]) {
        inputArgs = [...inputArgs, ...args];
        const retIndex = inputIndex;
        inputIndex += 1;
        return retIndex;
      }

      // concat list - always first
      addInput([
        // https://blog.yo1.dog/fix-for-ffmpeg-protocol-not-on-whitelist-error-for-urls/
        '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe,fd',
        '-i', '-',
      ]);

      let metadataSourceIndex: number | undefined;
      if (preserveMetadataOnMerge) {
        // If preserve metadata, add the first file (we will get metadata from this input)
        metadataSourceIndex = addInput(['-i', metadataFromPath]);
      }

      let chaptersInputIndex: number | undefined;
      if (chaptersPath) {
        // if chapters, add chapters source file
        chaptersInputIndex = addInput(getChaptersInputArgs(chaptersPath));
      }

      // [帧号精确合并] videoOnly: 只映射真正的视频流（排除封面图 attached_pic），
      // 用于"纯视频 concat（时间轴严格精确）+ 从源视频单遍复制音轨"的合并切割流程
      const streamsToMap = videoOnly ? streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) : streams;
      const { streamIdsToCopy, excludedStreamIds } = getStreamIdsToCopy({ streams: streamsToMap, includeAllStreams });
      const mapStreamsArgs = getMapStreamsArgs({
        allFilesMeta: { [metadataFromPath]: { streams: streamsToMap } },
        copyFileStreams: [{ path: metadataFromPath, streamIds: streamIdsToCopy }],
        outFormat,
        manuallyCopyDisposition: true,
        needFlac: true, // https://github.com/mifi/lossless-cut/issues/2636
      });

      // Keep this similar to losslessCutSingle()
      const ffmpegArgs = [
        '-hide_banner',
        // No progress if we set loglevel warning :(
        // '-loglevel', 'warning',

        ...inputArgs,

        ...mapStreamsArgs,

        // -map_metadata 0 with concat demuxer doesn't transfer metadata from the concat'ed file input (index 0) when merging.
        // So we use the first file file (index 1) for metadata
        // Can only do this if allStreams (-map 0) is set
        ...(metadataSourceIndex != null ? ['-map_metadata', String(metadataSourceIndex)] : []),

        ...(chaptersInputIndex != null ? ['-map_chapters', String(chaptersInputIndex)] : []),

        ...getMovFlags({ outFormat, preserveMovData, movFastStart }),
        ...getMatroskaFlags(outFormat),

        // See https://github.com/mifi/lossless-cut/issues/170
        '-ignore_unknown',

        ...getExperimentalArgs(ffmpegExperimental),

        ...getVideoTimescaleArgs(videoTimebase),

        ...(outFormat ? ['-f', outFormat] : []),
        '-y', outPath,
      ];

      // https://superuser.com/questions/787064/filename-quoting-in-ffmpeg-concat
      // Must add "file:" or we get "Impossible to open 'pipe:xyz.mp4'" on newer ffmpeg versions
      // https://superuser.com/questions/718027/ffmpeg-concat-doesnt-work-with-absolute-path
      const concatTxt = paths.map((file) => `file 'file:${resolve(file).replaceAll('\'', String.raw`'\''`)}'`).join('\n');

      const ffmpegCommandLine = getFfCommandLine('ffmpeg', ffmpegArgs);

      const fullCommandLine = `echo -e "${concatTxt.replaceAll('\n', String.raw`\n`)}" | ${ffmpegCommandLine}`;
      console.log(fullCommandLine);
      appendLastCommandsLog(fullCommandLine);

      const result = await runFfmpegConcat({ ffmpegArgs, concatTxt, totalDuration, onProgress });
      logStdoutStderr(result);

      await transferTimestamps({ inPath: metadataFromPath, outPath, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart, duration: totalDuration });

      return { haveExcludedStreams: excludedStreamIds.length > 0 };
    } finally {
      if (chaptersPath) await tryDeleteFiles([chaptersPath]);
    }
  }, [appendLastCommandsLog, shouldSkipExistingFile, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart]);

  const losslessCutSingle = useCallback(async ({
    keyframeCut: ssBeforeInput, avoidNegativeTs, copyFileStreams, cutFrom, cutTo, chaptersPath, onProgress, outPath,
    fileDuration, rotation, allFilesMeta, outFormat, shortestFlag, ffmpegExperimental, preserveMetadata, preserveMovData, preserveChapters, movFastStart, paramsByFile, videoTimebase, detectedFps, videoOnly, preciseFrameCount, preciseCutFrom, transform, fitToSourceDims, forceTranscode,
  }: {
    keyframeCut: boolean,
    avoidNegativeTs: AvoidNegativeTs | undefined,
    copyFileStreams: CopyfileStreams,
    cutFrom: number,
    cutTo: number,
    chaptersPath: string | undefined,
    onProgress: (p: number) => void,
    outPath: string,
    fileDuration: number | undefined,
    rotation: number | undefined,
    allFilesMeta: AllFilesMeta,
    outFormat: string,
    shortestFlag: boolean,
    ffmpegExperimental: boolean,
    preserveMetadata: PreserveMetadata,
    preserveMovData: boolean,
    preserveChapters: boolean,
    movFastStart: boolean,
    paramsByFile: ParamsByFile,
    videoTimebase?: number | undefined,
    detectedFps?: number | undefined,
    videoOnly?: boolean | undefined,
    preciseFrameCount?: number | undefined,
    preciseCutFrom?: number | undefined,
    // [片段级变换] 有变换的片段：视频流加滤镜重编码，其余流仍流复制
    transform?: SegmentTransform | undefined,
    fitToSourceDims?: { width: number, height: number } | undefined,
    // [B 帧结构统一] 合并模式下源带 B 帧且存在转码段时，本段强制转码（见 cutMultiple 内注释）
    forceTranscode?: boolean | undefined,
  }) => {
    const frameDuration = getFrameDuration(detectedFps);

    const cuttingStart = isCuttingStart(cutFrom);
    const cutFromWithAdjustment = cutFrom + cutFromAdjustmentFrames * frameDuration;
    const cutToWithAdjustment = cutTo + cutToAdjustmentFrames * frameDuration;
    const cuttingEnd = isCuttingEnd(cutTo, fileDuration);
    const areWeCutting = cuttingStart || cuttingEnd;
    if (areWeCutting) console.log('Cutting from', cuttingStart ? `${cutFrom} (${cutFromWithAdjustment} adjusted ${cutFromAdjustmentFrames} frames)` : 'start', 'to', cuttingEnd ? `${cutTo} (adjusted ${cutToAdjustmentFrames} frames)` : 'end');

    let cutDuration = cutToWithAdjustment - cutFromWithAdjustment;
    if (detectedFps != null) cutDuration = Math.max(cutDuration, frameDuration); // ensure at least one frame duration

    // Don't cut if not needed: https://github.com/mifi/lossless-cut/issues/50
    // [帧号精确吸附] preciseCutFrom 是 ≤ cutFrom 的实际关键帧时间，-ss 落点与
    // 帧数计算的基准一致，消除段间缝隙/重叠
    const cutFromArgs = cuttingStart ? ['-ss', formatFfmpegNumber(preciseCutFrom ?? cutFromWithAdjustment)] : [];
    // preciseFrameCount 模式下只复制视频流，无需 -t 限制音频；且 -t 的名义时长
    // 会把吸附后多出的尾部视频帧截掉，必须省略
    const cutToArgs = cuttingEnd && preciseFrameCount == null ? ['-t', formatFfmpegNumber(cutDuration)] : [];

    // [帧号精确合并] videoOnly: 切分时只保留视频流（排除封面图），用于"铺满分段"的
    // 合并切割流程——纯视频分段文件时长精确，concat 时间轴零漂移，音轨最后从源视频复制
    const copyFileStreamsFiltered = (videoOnly
      ? copyFileStreams.map(({ path, streamIds }) => ({
        path,
        streamIds: streamIds.filter((streamId) => {
          const stream = allFilesMeta[path]?.streams.find((s) => s.index === streamId);
          return stream != null && stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1;
        }),
      }))
      : copyFileStreams).filter(({ streamIds }) => streamIds.length > 0);

    // [帧率与 GOP 归一] 关键帧间隔按 0.2~0.5s 区间动态计算，≥24fps 归一到 6 的倍数，
    // 非整数帧率（29.97/30.1）四舍五入后以固定 CFR 输出
    const { outFps, keyint } = normalizeFpsAndKeyint(detectedFps ?? 30);
    // [帧率归一判定] 归一后帧率与源不同（如 29.97→30、50→48）时视频需转码；webm 不做帧率归一
    const fpsNeedsNormalize = detectedFps != null && outFormat !== 'webm' && outFps !== detectedFps;

    // [帧号精确切割] 关键帧切割（流复制）模式下，`-t` 按 dts 截断，在 B 帧重排的
    // 视频里会多带入若干帧，导致各分段帧数之和与源视频不一致（分段经外部工具
    // 处理后按序 concat -c copy 时无法与源视频逐帧对齐）。
    // 这里按帧号计算本段精确视频帧数 N = round(cutTo*fps) - round(cutFrom*fps)，
    // 追加 `-frames:v N` 对视频流做确定性截断；`-t` 保留用于限制音频流。
    // 用绝对帧号差可伸缩（telescoping）：各段帧数之和恒等于 round(总时长*fps)。
    // 仅在：关键帧切割 + 已检测到帧率 + 单输入文件（不含外部附加文件）时启用。
    // 末段若到文件结尾（cuttingEnd 为 false），用 fileDuration 作为终点同样截断。
    // 注意：帧率归一转码时帧率会变，按源帧率数出的帧数在输出帧率下不成立，必须跳过。
    // B 帧结构统一强制转码（forceTranscode）不改变帧率，帧数计算依然精确，保留之——
    // 各段帧数之和恒等于 round(总时长*fps)，保证合并后总时长与源一致（telescoping）。
    const canUsePreciseFrames = ssBeforeInput && detectedFps != null && copyFileStreamsFiltered.length === 1;
    const preciseEnd = cuttingEnd ? cutToWithAdjustment : (isDurationValid(fileDuration) ? fileDuration : undefined);
    const framesVPreciseArgs = fpsNeedsNormalize || !canUsePreciseFrames || preciseEnd == null
      ? []
      : preciseFrameCount != null
        ? ['-frames:v', String(preciseFrameCount)]
        : ['-frames:v', String(Math.max(1, Math.round(preciseEnd * detectedFps) - Math.round(cutFromWithAdjustment * detectedFps)))];

    // remove -avoid_negative_ts make_zero when not cutting start (no -ss), or else some videos get blank first frame in QuickLook
    // note: `make_zero`/`make_non_negative` get downgraded to `auto` when copying a cover art stream, or else the
    // output gets the segment's end time as its duration, see https://github.com/mifi/lossless-cut/issues/3009
    const effectiveAvoidNegativeTs = getEffectiveAvoidNegativeTs({ avoidNegativeTs, allFilesMeta, copyFileStreams: copyFileStreamsFiltered });
    const avoidNegativeTsArgs = cuttingStart && effectiveAvoidNegativeTs && ssBeforeInput ? ['-avoid_negative_ts', String(effectiveAvoidNegativeTs)] : [];

    // If cutting multiple files, `-ss` must be before `-i`, regardless of `ssBeforeInput` choice
    // and it seems that `-t` must be after `-i` #896
    const inputFilesArgs = copyFileStreamsFiltered.length > 1
      ? copyFileStreamsFiltered.flatMap(({ streamIds, path }) => {
        const fileParams = paramsByFile.get(path);
        // Don't cut/seek cover art or images attached by users - it will break them, see https://github.com/mifi/lossless-cut/issues/2884
        const streamParams = streamIds.map((streamId) => fileParams?.paramsByStream.get(streamId));
        if (streamIds.length === 1 && streamParams[0]?.disposition === 'attached_pic') {
          return ['-i', path];
        }

        const itsOffsetArgs = fileParams?.offset ? ['-itsoffset', formatFfmpegNumber(fileParams.offset)] : [];

        return [
          ...cutFromArgs,
          ...itsOffsetArgs,
          '-i', path,
          ...cutToArgs,
        ];
      })
      : [
        ...(ssBeforeInput ? cutFromArgs : []),
        '-i', copyFileStreamsFiltered[0]!.path,
        ...(!ssBeforeInput ? cutFromArgs : []),
        ...cutToArgs,
        ...framesVPreciseArgs,
      ];

    const chaptersInputIndex = copyFileStreamsFiltered.length;

    const rotationArgs = rotation !== undefined ? ['-display_rotation:v:0', String(360 - rotation)] : [];

    invariant(filePath != null);

    // [片段级变换] 找到主文件被复制的第一条视频流，为它注入滤镜 + 编码器参数。
    // 通过 getVideoArgs 扩展点：返回的参数会替代该输出流默认的 -c:N copy。
    const transformVideoFilters = getTransformVideoFilters(transform, fitToSourceDims);
    const mainCopiedVideoStreamId = copyFileStreamsFiltered.find(({ path }) => path === filePath)?.streamIds.find((streamId) => {
      const stream = allFilesMeta[filePath]?.streams.find((s) => s.index === streamId);
      return stream != null && stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1;
    });
    // [转码判定] 有变换必转码；无变换时若帧率需归一（如 29.97→30、50→48）也转码，
    // 以固定帧率输出；相同则维持流复制。合并模式下源带 B 帧且存在转码段时，
    // 流复制段被强制转码（forceTranscode，由 cutMultiple 计算传入），保证全片结构一致。
    const segmentNeedsTranscode = transformVideoFilters.length > 0 || fpsNeedsNormalize || forceTranscode;
    const getTransformVideoArgs = segmentNeedsTranscode && mainCopiedVideoStreamId != null
      ? ({ streamIndex, outputIndex }: { streamIndex: number, outputIndex: number }) => {
        if (streamIndex !== mainCopiedVideoStreamId) return undefined;
        const isWebm = outFormat === 'webm';
        // [对齐源编码参数] 源视频为 CFR + 强制固定 GOP + bt709/high@4.1 + timescale 15360。
        // 重编码片段若用 ffmpeg 默认行为（保留 VFR 时间戳、默认 GOP），concat 后会变成动态帧率；
        // 因此把源的全部可复现参数带上，让输出与源一致。GOP/帧率按 normalizeFpsAndKeyint 动态计算。
        // webm 无 NVENC 编码器，始终用 libvpx-vp9；mp4 勾选硬件编码时用 NVENC，
        // -b:v 0 让 -cq 真正生效（否则会套用默认 2Mbps 码率上限）
        let encodeArgs: string[];
        if (isWebm) {
          encodeArgs = [`-c:${outputIndex}`, 'libvpx-vp9', `-crf:${outputIndex}`, '30', '-b:v', '0'];
        } else if (hwEncode) {
          encodeArgs = [
            `-c:${outputIndex}`, 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', `-cq:${outputIndex}`, '19', '-b:v', '0',
            // NVENC 版的源参数复刻：固定 GOP、强制 IDR 关键帧、最小化 GOP 码率波动、禁用 scenecut
            // 对应 x264 的 keyint=N:min-keyint=N:scenecut=0:force-cfr=1（帧率 CFR 由 -fps_mode cfr 保证）
            // （ffmpeg 8 布尔选项必须显式传 1，否则会吞掉下一个参数）
            `-g:${outputIndex}`, String(keyint), `-forced-idr:${outputIndex}`, '1', `-strict_gop:${outputIndex}`, '1', `-no-scenecut:${outputIndex}`, '1',
            // [禁用 B 帧] 源视频无 B 帧；转码段若带 B 帧，其 dts 延迟会与流复制段在 concat 交界处
            // 冲突（ffmpeg 强制 dts 单调会把边界几个 packet 的 duration 弄成 1 tick 的碎片值），
            // 导致合并成品的 stts 表混入异常时长、部分工具（MediaInfo 等）误判为动态帧率。
            // 禁用后转码段与 copy 段结构一致，拼接边界干净（实测 1800 帧全部精确 512 tick）。
            `-bf:${outputIndex}`, '0',
          ];
        } else {
          encodeArgs = [
            `-c:${outputIndex}`, 'libx264', `-crf:${outputIndex}`, '18', '-preset', 'medium',
            // 与源一致的 x264 参数：keyint=N:min-keyint=N:scenecut=0:force-cfr=1
            // bframes=0 同上：源无 B 帧，转码段禁用 B 帧以保证 concat 边界干净
            `-x264-params:${outputIndex}`, `keyint=${keyint}:min-keyint=${keyint}:scenecut=0:force-cfr=1:bframes=0`,
          ];
        }
        // h264 专属的流级参数（vp9 不接受 high profile / 4.1 level）
        const h264Args = isWebm ? [] : [
          `-pix_fmt:${outputIndex}`, 'yuv420p',
          `-profile:v:${outputIndex}`, 'high',
          `-level:${outputIndex}`, '4.1',
          `-r:${outputIndex}`, String(outFps),
          `-fps_mode:${outputIndex}`, 'cfr',
          `-color_range:${outputIndex}`, 'tv',
          `-colorspace:${outputIndex}`, 'bt709',
          `-color_primaries:${outputIndex}`, 'bt709',
          `-color_trc:${outputIndex}`, 'bt709',
        ];
        // movenc 容器级参数：timescale 与流复制段统一（timescaleForFps，30fps→15360），
        // concat 时基才能对齐不产生换算误差；brand 同源
        // （-movflags +faststart / -avoid_negative_ts 由程序既有配置项处理，此处不重复）
        const movencArgs = outFormat == null || movencFormats.has(outFormat)
          ? ['-video_track_timescale', String(timescaleForFps(outFps)), '-brand', 'mp42']
          : [];
        return [
          ...(transformVideoFilters.length > 0 ? [`-filter:${outputIndex}`, transformVideoFilters.join(',')] : []),
          ...encodeArgs,
          ...h264Args,
          ...movencArgs,
        ];
      }
      : undefined;

    // This function tries to calculate the output stream index needed for -metadata:s:x and -disposition:x arguments
    // It is based on the assumption that copyFileStreamsFiltered contains the order of the input files (and their respective streams orders) sent to ffmpeg, to hopefully calculate the same output stream index values that ffmpeg does internally.
    // It also takes into account previously added files that have been removed and disabled streams.
    function mapInputStreamIndexToOutputIndex(inputFilePath: string, inputFileStreamIndex: number) {
      let streamCount = 0;
      // Count copied streams of all files until this input file
      const foundFile = copyFileStreamsFiltered.find(({ path: path2, streamIds }) => {
        if (path2 === inputFilePath) return true;
        streamCount += streamIds.length;
        return false;
      });
      if (!foundFile) return undefined; // Could happen if a tag has been edited on an external file, then the file was removed

      // Then add the index of the current stream index to the count
      const copiedStreamIndex = foundFile.streamIds.indexOf(inputFileStreamIndex);
      if (copiedStreamIndex === -1) return undefined; // Could happen if a tag has been edited on a stream, but the stream is disabled
      return streamCount + copiedStreamIndex;
    }

    const customFileMetadataArgs = Object.entries(paramsByFile.get(filePath)?.metadata ?? {}).flatMap(([key, value]) => [
      '-metadata', `${key}=${value}`,
    ]);

    const mapStreamsArgs = getMapStreamsArgs({
      copyFileStreams: copyFileStreamsFiltered,
      allFilesMeta,
      outFormat,
      needFlac: areWeCutting,
      ...(getTransformVideoArgs != null && { getVideoArgs: getTransformVideoArgs }),
    });

    const customParamsArgs = (() => {
      const ret: string[] = [];
      for (const [fileId, { paramsByStream }] of paramsByFile.entries()) {
        for (const [streamId, streamParams] of paramsByStream.entries()) {
          const outputIndex = mapInputStreamIndexToOutputIndex(fileId, streamId);
          if (outputIndex != null) {
            const { disposition } = streamParams;
            if (disposition != null) {
              // "0" means delete the disposition for this stream
              const dispositionArg = disposition === deleteDispositionValue ? '0' : disposition;
              ret.push(`-disposition:${outputIndex}`, String(dispositionArg));
            }

            const bitstreamFilters: string[] = [];
            if (streamParams.bsfH264Mp4toannexb) bitstreamFilters.push('h264_mp4toannexb');
            if (streamParams.bsfHevcMp4toannexb) bitstreamFilters.push('hevc_mp4toannexb');
            if (streamParams.bsfHevcAudInsert) bitstreamFilters.push('hevc_metadata=aud=insert');

            const getFileStreams = () => allFilesMeta[fileId]?.streams;
            const getStream = () => getFileStreams()?.find((s) => s.index === streamId);

            // Lossless crop via codec bitstream metadata (#643)
            if (streamParams.crop) {
              const { left, right, top, bottom } = streamParams.crop;
              if (left > 0 || right > 0 || top > 0 || bottom > 0) {
                // Look up codec_name from allFilesMeta to determine the correct bitstream filter
                const streamInfo = getStream();
                const codecName = streamInfo?.codec_name;

                const cropParams = `crop_left=${left}:crop_right=${right}:crop_top=${top}:crop_bottom=${bottom}`;
                if (codecName === 'h264') {
                  bitstreamFilters.push(`h264_metadata=${cropParams}`);
                } else if (codecName === 'hevc') {
                  bitstreamFilters.push(`hevc_metadata=${cropParams}`);
                }
              }
            }

            // Lossless aspect ratio (SAR) via codec bitstream metadata (#643)
            if (streamParams.aspectRatio) {
              const { num, den } = streamParams.aspectRatio;
              if (num > 0 && den > 0) {
                const streamInfo = getStream();
                const codecName = streamInfo?.codec_name;

                if (codecName === 'h264') {
                  bitstreamFilters.push(`h264_metadata=sample_aspect_ratio=${num}/${den}`);
                } else if (codecName === 'hevc') {
                  bitstreamFilters.push(`hevc_metadata=sample_aspect_ratio=${num}/${den}`);
                } else {
                  // For non-H264/HEVC codecs, use container-level -aspect flag
                  ret.push('-aspect', `${num}:${den}`);
                }
              }
            }

            if (bitstreamFilters.length > 0) {
              ret.push(`-bsf:${outputIndex}`, bitstreamFilters.join(','));
            }

            if (streamParams.tag != null) {
              ret.push(`-tag:${outputIndex}`, streamParams.tag);
            }

            // custom stream metadata
            if (streamParams.metadata != null) {
              for (const [tag, value] of Object.entries(streamParams.metadata)) {
                ret.push(`-metadata:s:${outputIndex}`, `${tag}=${value}`);
              }
            }
          }
        }
      }
      return ret;
    })();

    function getPreserveMetadata() {
      if (preserveMetadata === 'default') return ['-map_metadata', '0']; // todo isn't this ffmpeg default and can be omitted? https://stackoverflow.com/a/67508734/6519037
      if (preserveMetadata === 'none') return ['-map_metadata', '-1'];
      if (preserveMetadata === 'nonglobal') return ['-map_metadata:g', '-1']; // https://superuser.com/a/1546267/658247
      return [];
    }

    function getPreserveChapters() {
      if (chaptersPath) return ['-map_chapters', String(chaptersInputIndex)];
      // todo should preserve chapters be hardcoded (and disabled in UI) when segmentsToChaptersOnly mode is enabled?
      if (!preserveChapters) return ['-map_chapters', '-1']; // https://github.com/mifi/lossless-cut/issues/2176
      return []; // default: includes chapters from input
    }

    const ffmpegArgs = [
      '-hide_banner',
      // No progress if we set loglevel warning :(
      // '-loglevel', 'warning',

      ...getOutputPlaybackRateArgs(),

      ...rotationArgs,

      ...inputFilesArgs,
      ...getChaptersInputArgs(chaptersPath),

      ...avoidNegativeTsArgs,

      ...mapStreamsArgs,

      ...getPreserveMetadata(),

      ...getPreserveChapters(),

      ...(shortestFlag ? ['-shortest'] : []),

      ...getMovFlags({ outFormat, preserveMovData, movFastStart }),
      ...getMatroskaFlags(outFormat),

      ...customFileMetadataArgs,

      ...customParamsArgs,

      // See https://github.com/mifi/lossless-cut/issues/170
      '-ignore_unknown',

      ...getExperimentalArgs(ffmpegExperimental),

      // [统一视频轨 timescale] 正常切割路径（videoTimebase 未传）下，流复制段必须与转码段
      // 使用同一 timescale（timescaleForFps）。若流复制段继承源时基（如 1/90000）而转码段
      // 是 1/15360，concat demuxer 不做时基换算，复制段 pts 会按原始 tick 数原样写入合并
      // 成品（1/30s=3000 tick 落进 15360 时基变成 0.195s/帧），导致时长成倍膨胀、且复制段
      // 的虚高 pts 把后续所有片段顶死（每帧仅 +1 tick）。smart cut 路径显式传源
      // videoTimebase，其内部两段本就同源时基，保持原行为。
      ...(videoTimebase != null
        ? getVideoTimescaleArgs(videoTimebase)
        : (outFormat == null || movencFormats.has(outFormat)
          ? ['-video_track_timescale', String(timescaleForFps(normalizeFpsAndKeyint(detectedFps ?? 30).outFps))]
          : [])),

      '-f', outFormat, '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpegWithProgress({ ffmpegArgs, duration: cutDuration, onProgress });
    logStdoutStderr(result);

    await transferTimestamps({ inPath: filePath, outPath, cutFrom, cutTo, treatInputFileModifiedTimeAsStart, duration: isDurationValid(fileDuration) ? fileDuration : undefined, treatOutputFileModifiedTimeAsStart });
  }, [appendFfmpegCommandLog, cutFromAdjustmentFrames, cutToAdjustmentFrames, filePath, getOutputPlaybackRateArgs, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart, hwEncode]);

  // inspired by https://gist.github.com/fernandoherreradelasheras/5eca67f4200f1a7cc8281747da08496e
  const cutEncodeSmartPart = useCallback(async ({ cutFrom, cutTo, outPath, outFormat, videoCodec, videoBitrate, videoTimebase, allFilesMeta, copyFileStreams, videoStreamIndex, ffmpegExperimental, hasBFrames }: {
    cutFrom: number,
    cutTo: number,
    outPath: string,
    outFormat: string,
    videoCodec: string,
    videoBitrate: number,
    videoTimebase: number,
    allFilesMeta: AllFilesMeta,
    copyFileStreams: CopyfileStreams,
    videoStreamIndex: number,
    ffmpegExperimental: boolean,
    hasBFrames: number | undefined,
  }) => {
    invariant(filePath != null);

    function getVideoArgs({ streamIndex, outputIndex }: { streamIndex: number, outputIndex: number }) {
      if (streamIndex !== videoStreamIndex) return undefined;

      const args = [
        `-c:${outputIndex}`, videoCodec,
        `-b:${outputIndex}`, String(videoBitrate),
      ];

      // seems like ffmpeg handles this itself well when encoding same source file
      // if (videoLevel != null) args.push(`-level:${outputIndex}`, videoLevel);
      // if (videoProfile != null) args.push(`-profile:${outputIndex}`, videoProfile);

      return args;
    }

    const mapStreamsArgs = getMapStreamsArgs({
      allFilesMeta,
      copyFileStreams,
      outFormat,
      getVideoArgs,
    });

    const ffmpegArgs = [
      '-hide_banner',
      // No progress if we set loglevel warning :(
      // '-loglevel', 'warning',

      '-ss', formatFfmpegNumber(cutFrom), // if we don't -ss before -i, seeking will be slow for long files, see https://github.com/mifi/lossless-cut/issues/126#issuecomment-1135451043
      '-i', filePath,
      '-ss', '0', // If we don't do this, the output seems to start with an empty black after merging with the encoded part
      '-t', formatFfmpegNumber(cutTo - cutFrom),

      ...mapStreamsArgs,

      // See https://github.com/mifi/lossless-cut/issues/170
      '-ignore_unknown',

      ...getVideoTimescaleArgs(videoTimebase),

      ...(hasBFrames ? ['-bf', String(hasBFrames)] : []),

      ...getExperimentalArgs(ffmpegExperimental),

      '-f', outFormat, '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    await runFfmpeg(ffmpegArgs);
  }, [appendFfmpegCommandLog, filePath]);

  const cutMultiple = useCallback(async ({
    outputDir, customOutDir, segments: segmentsIn, cutFileNames, fileDuration, rotation, detectedFps, onProgress: onTotalProgress, keyframeCut, copyFileStreams, allFilesMeta, outFormat, shortestFlag, ffmpegExperimental, preserveMetadata, preserveMetadataOnMerge, preserveMovData, preserveChapters, movFastStart, avoidNegativeTs, paramsByFile, chapters, videoOnly, fitTransformedToSourceDims, sourceVideoDims, tempOutDir, willMerge,
  }: {
    outputDir: string,
    customOutDir: string | undefined,
    segments: SegmentToExport[],
    cutFileNames: string[],
    fileDuration: number | undefined,
    rotation: number | undefined,
    detectedFps: number | undefined,
    onProgress: (p: number) => void,
    keyframeCut: boolean,
    copyFileStreams: CopyfileStreams,
    allFilesMeta: AllFilesMeta,
    outFormat: string | undefined,
    shortestFlag: boolean,
    ffmpegExperimental: boolean,
    preserveMetadata: PreserveMetadata,
    preserveMovData: boolean,
    preserveMetadataOnMerge: boolean,
    preserveChapters: boolean,
    movFastStart: boolean,
    avoidNegativeTs: AvoidNegativeTs | undefined,
    paramsByFile: ParamsByFile,
    chapters: Chapter[] | undefined,
    videoOnly?: boolean | undefined,
    // [片段级变换] 合并模式下，若只有部分片段旋转了 90°，把旋转片段 letterbox 回源尺寸
    fitTransformedToSourceDims?: boolean | undefined,
    sourceVideoDims?: { width: number, height: number } | undefined,
    // [临时盘] 设置后 ffmpeg 先写该目录，再复制到最终输出目录（合并模式下片段保留在临时目录供 concat）
    tempOutDir?: string | undefined,
    willMerge?: boolean | undefined,
  }) => {
    console.log('paramsByFile', paramsByFile);

    const segments = getGuaranteedSegments(segmentsIn, fileDuration);

    const singleProgresses: Record<number, number> = {};
    function onSingleProgress(id: number, singleProgress: number) {
      singleProgresses[id] = singleProgress;
      return onTotalProgress((sum(Object.values(singleProgresses)) / segments.length));
    }

    invariant(filePath != null);
    await assertFileExists(filePath);

    // [帧号精确吸附] 条件：关键帧切割 + 纯流复制（非编码）+ 已检测到帧率
    // + 仅复制主文件的单条视频流（即"只导视频"场景）
    // + 帧率无需归一（帧率归一时视频会转码，按源帧率数出的帧数在输出帧率下不成立）
    let snappedRanges: { ssTime: number | undefined, frameCount: number }[] | undefined;
    const mainCopyEntry = copyFileStreams.length === 1 ? copyFileStreams[0] : undefined;
    const mainStreams = mainCopyEntry != null ? allFilesMeta[filePath]?.streams : undefined;
    const videoOnlyStreamIds = mainCopyEntry != null
      ? mainCopyEntry.streamIds.filter((streamId) => {
        const stream = mainStreams?.find((s) => s.index === streamId);
        return stream != null && stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1;
      })
      : [];
    // [帧率归一] 归一后帧率与源不同（如 29.97→30、50→48）时，所有无变换片段也要转码（webm 不做帧率归一）
    const fpsNormalized = detectedFps != null && outFormat !== 'webm' && normalizeFpsAndKeyint(detectedFps).outFps !== detectedFps;
    // [B 帧结构统一] 源视频带 B 帧 + 合并 + 存在任一转码段时，流复制段也强制转码。
    // 原因：流复制段继承源的 B 帧结构（dts 比 pts 延迟若干帧），而转码段以 -bf 0 输出无 B 帧；
    // concat demuxer 在「无 B 帧段 ↔ 带 B 帧段」交界处为保持 dts 单调会把边界 packet 的
    // duration 改写成 1-tick 碎片值，stts 表混入异类时长，MediaInfo 类工具据此误判为可变帧率。
    // 统一为无 B 帧结构后交界干净（实测混合拼接全程精确 CFR）。全 copy 合并无转码段，不受影响。
    const sourceVideoHasBFrames = (mainStreams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)?.has_b_frames ?? 0) > 0;
    const anySegmentTranscodes = segments.some((s) => ('transform' in s && s.transform != null)) || fpsNormalized;
    const forceTranscodeAll = willMerge === true && sourceVideoHasBFrames && anySegmentTranscodes && outFormat !== 'webm';
    if (keyframeCut && !isEncoding && detectedFps != null && !fpsNormalized && !forceTranscodeAll && mainCopyEntry != null
      && videoOnlyStreamIds.length === 1 && videoOnlyStreamIds[0] === mainCopyEntry.streamIds[0]) {
      try {
        snappedRanges = await computeSnappedFrameRanges({
          filePath, videoStreamIndex: videoOnlyStreamIds[0]!, segments, fps: detectedFps, fileDuration,
        });
        if (snappedRanges != null) console.log('Snapped segment boundaries to keyframes:', snappedRanges);
      } catch (err) {
        console.error('Failed to snap segments to keyframes, falling back to nominal cut points', err);
      }
    }

    const chaptersPath = await writeChaptersFfmetadata(tempOutDir ?? outputDir, chapters);

    // This function will either call losslessCutSingle (if no smart cut enabled)
    // or if enabled, will first cut&encode the part before the next keyframe, trying to match the input file's codec params
    // then it will cut the part *from* the keyframe to "end", and concat them together and return the concated file
    // so that for the calling code it looks as if it's just a normal segment
    const cutSegment = async ({ start: desiredCutFrom, end: cutTo, transform }: SegmentToExport, i: number) => {
      const onProgress = (progress: number) => onSingleProgress(i, progress / 2);
      const onConcatProgress = (progress: number) => onSingleProgress(i, (1 + progress) / 2);

      const finalOutPath = join(outputDir, cutFileNames[i]!);

      if (await shouldSkipExistingFile(finalOutPath)) return { path: finalOutPath, created: false };

      // [临时盘] 设置了临时目录时，ffmpeg 先写临时文件，成功后再复制到最终输出目录并删除临时文件。
      // 合并模式下片段保留在临时目录供后续 concat 使用（由调用方在合并完成后清理）。
      const outPath = tempOutDir != null ? join(tempOutDir, cutFileNames[i]!) : finalOutPath;
      if (outPath !== finalOutPath) await mkdir(tempOutDir!, { recursive: true });

      await maybeMkDeepOutDir({ outputDir, fileOutPath: finalOutPath });

      const finishSegment = async (createdPath: string) => {
        if (tempOutDir == null || willMerge) return { path: createdPath, created: true };
        await copyFilePreserveTimestamps(createdPath, finalOutPath);
        await unlinkWithRetry(createdPath);
        return { path: finalOutPath, created: true };
      };

      // [片段级变换] 有变换的片段统一走 losslessCutSingle（其内部会对视频流加滤镜重编码），
      // 不走 smart cut 分支，避免变换被忽略
      if (!isEncoding || transform != null) {
        // simple lossless cut
        invariant(outFormat != null);
        await losslessCutSingle({
          cutFrom: desiredCutFrom, cutTo, chaptersPath, outPath, copyFileStreams, keyframeCut, avoidNegativeTs, fileDuration, rotation, allFilesMeta, outFormat, shortestFlag, ffmpegExperimental, preserveMetadata, preserveMovData, preserveChapters, movFastStart, paramsByFile, detectedFps, videoOnly, preciseFrameCount: snappedRanges?.[i]?.frameCount, preciseCutFrom: snappedRanges?.[i]?.ssTime, onProgress: (progress) => onSingleProgress(i, progress),
          transform, fitToSourceDims: fitTransformedToSourceDims === true ? sourceVideoDims : undefined,
          forceTranscode: forceTranscodeAll,
        });
        return finishSegment(outPath);
      }

      // we are probably encoding (`isEncoding`: true, smart cut or lossy mode)

      // smart cut only supports cutting main file (no externally added files)
      const { streams } = allFilesMeta[filePath]!;
      const streamsToCopyFromMainFile = copyFileStreams.find(({ path }) => path === filePath)!.streamIds
        .flatMap((streamId) => {
          const match = streams.find((stream) => stream.index === streamId);
          return match ? [match] : [];
        });

      const sourceCodecParams = await getCodecParams({ path: filePath, fileDuration, streams: streamsToCopyFromMainFile });
      const { videoStream, videoTimebase } = sourceCodecParams;

      const videoCodec = lossyMode ? lossyMode.videoEncoder : sourceCodecParams.videoCodec;

      const copyFileStreamsFiltered = [{
        path: filePath,
        // with smart cut, we only copy/cut *one* video stream, and *all* other non-video streams (main file only)
        streamIds: streamsToCopyFromMainFile.filter((stream) => stream.index === videoStream.index || stream.codec_type !== 'video').map((stream) => stream.index),
      }];

      // eslint-disable-next-line no-shadow
      async function cutEncodeSmartPartWrapper({ cutFrom, cutTo, outPath }: { cutFrom: number, cutTo: number, outPath: string }) {
        if (await shouldSkipExistingFile(outPath)) return;
        invariant(videoCodec != null);
        invariant(sourceCodecParams.videoBitrate != null);
        invariant(sourceCodecParams.videoTimebase != null);
        invariant(filePath != null);
        invariant(outFormat != null);
        await cutEncodeSmartPart({ cutFrom, cutTo, outPath, outFormat, videoCodec, videoBitrate: encCustomBitrate != null ? encCustomBitrate * 1000 : sourceCodecParams.videoBitrate, videoStreamIndex: videoStream.index, videoTimebase: sourceCodecParams.videoTimebase, allFilesMeta, copyFileStreams: copyFileStreamsFiltered, ffmpegExperimental, hasBFrames: sourceCodecParams.videoStream.has_b_frames });
      }

      const cutEncodeWholePart = async () => {
        await cutEncodeSmartPartWrapper({ cutFrom: desiredCutFrom, cutTo, outPath });
        return finishSegment(outPath);
      };

      if (lossyMode) {
        console.log('Lossy mode: cutting/encoding the whole segment', { desiredCutFrom, cutTo });
        return cutEncodeWholePart();
      }

      const { losslessCutFrom, segmentNeedsSmartCut } = await needsSmartCut({ path: filePath, desiredCutFrom, videoStream });
      if (segmentNeedsSmartCut && !detectedFps) throw new UserFacingError(i18n.t('Smart cut is not possible when FPS is unknown'));
      console.log('Smart cut on video stream', videoStream.index);

      // If we are cutting within two keyframes, just encode the whole part and return that
      // See https://github.com/mifi/lossless-cut/pull/1267#issuecomment-1236381740
      if (segmentNeedsSmartCut && losslessCutFrom > cutTo) {
        console.log('Segment is between two keyframes, cutting/encoding the whole segment', { desiredCutFrom, losslessCutFrom, cutTo });
        return cutEncodeWholePart();
      }

      invariant(outFormat != null);

      const ext = getOutFileExtension({ isCustomFormatSelected: true, outFormat, filePath });

      if (segmentNeedsSmartCut) {
        console.log('Cutting/encoding lossless part', { from: losslessCutFrom, to: cutTo });
      }

      const losslessPartOutPath = segmentNeedsSmartCut
        ? getSuffixedOutPath({ customOutDir, filePath, nameSuffix: `smartcut-segment-copy-${i}${ext}` })
        : outPath;

      // for smart cut we need to use keyframe cut here, and no avoid_negative_ts
      await losslessCutSingle({
        cutFrom: losslessCutFrom, cutTo, chaptersPath, outPath: losslessPartOutPath, copyFileStreams: copyFileStreamsFiltered, keyframeCut: true, avoidNegativeTs: undefined, fileDuration, rotation, allFilesMeta, outFormat, shortestFlag, ffmpegExperimental, preserveMetadata, preserveMovData, preserveChapters, movFastStart, paramsByFile, videoTimebase, detectedFps, onProgress,
      });

      // We don't need to concat, just return the single cut file (we may need smart cut in other segments though)
      if (!segmentNeedsSmartCut) return finishSegment(outPath);

      // We need to concat

      const smartCutEncodedPartOutPath = getSuffixedOutPath({ customOutDir, filePath, nameSuffix: `smartcut-segment-encode-${i}${ext}` });
      const smartCutSegmentsToConcat = [smartCutEncodedPartOutPath, losslessPartOutPath];

      try {
        const frameDuration = getFrameDuration(detectedFps);
        // Subtract one frame so we don't end up with duplicates when concating, and make sure we don't create a 0 length segment
        const encodeCutToSafe = Math.max(desiredCutFrom + frameDuration, losslessCutFrom - frameDuration);

        console.log('Cutting/encoding smart part', { from: desiredCutFrom, to: encodeCutToSafe });
        await cutEncodeSmartPartWrapper({ cutFrom: desiredCutFrom, cutTo: encodeCutToSafe, outPath: smartCutEncodedPartOutPath });

        // need to re-read streams because indexes may have changed. Using main file as source of streams and metadata
        const { streams: streamsAfterCut } = await readFileFfprobeMeta(losslessPartOutPath);

        await concatFiles({ paths: smartCutSegmentsToConcat, outDir: outputDir, outPath, metadataFromPath: losslessPartOutPath, outFormat, includeAllStreams: true, streams: streamsAfterCut, ffmpegExperimental, preserveMovData, movFastStart, chapters, preserveMetadataOnMerge, videoTimebase, onProgress: onConcatProgress });
        return finishSegment(outPath);
      } finally {
        await tryDeleteFiles(smartCutSegmentsToConcat);
      }
    };

    try {
      return await pMap(segments, cutSegment, { concurrency: 1 });
    } finally {
      if (chaptersPath) await tryDeleteFiles([chaptersPath]);
    }
  }, [shouldSkipExistingFile, isEncoding, filePath, lossyMode, losslessCutSingle, cutEncodeSmartPart, encCustomBitrate, concatFiles]);

  const concatCutSegments = useCallback(async ({ customOutDir, outFormat, segmentPaths, ffmpegExperimental, onProgress, preserveMovData, movFastStart, chapterNames, preserveMetadataOnMerge, mergedOutFilePath, segments, fileDuration, detectedFps }: {
    customOutDir: string | undefined,
    outFormat: string | undefined,
    segmentPaths: string[],
    ffmpegExperimental: boolean,
    onProgress: (p: number) => void,
    preserveMovData: boolean,
    movFastStart: boolean,
    chapterNames: (string | undefined)[] | undefined,
    preserveMetadataOnMerge: boolean,
    mergedOutFilePath: string,
    segments: { start: number, end: number }[],
    fileDuration: number | undefined,
    detectedFps: number | undefined,
  }) => {
    const outDir = getOutDir(customOutDir, filePath);

    if (await shouldSkipExistingFile(mergedOutFilePath)) return;

    invariant(filePath != null);

    // [合并 timescale] 与分段保持一致的 timescale（30fps→15360，每帧恰好 512 tick），
    // 避免 movenc 自选时基引入换算舍入；仅对 movenc 系容器生效
    const isMovenc = outFormat == null || movencFormats.has(outFormat);
    const mergeTimescale = detectedFps != null && isMovenc
      ? timescaleForFps(normalizeFpsAndKeyint(detectedFps).outFps)
      : undefined;

    const chapters = await createChaptersFromSegments({ paths: segmentPaths, defaultChapterNames: chapterNames });

    const metadataFromPath = segmentPaths[0];
    invariant(metadataFromPath != null);
    // need to re-read streams because may have changed
    const { streams } = await readFileFfprobeMeta(metadataFromPath);

    // [帧号精确合并] 若分段无缝铺满整个源视频，改用「纯视频 concat（时间轴严格精确）
    // + 从源视频单遍复制音轨」两遍流程：旧流程直接 concat 含音频的分段时，每段音轨的
    // AAC 帧粒度/priming/seek 前移与视频 B 帧重排偏移会使 concat demuxer 逐段多推进
    // 约 0.07~0.09s，长视频累积数秒误差。
    const segmentsTile = segmentsTileFile(segments, fileDuration);

    if (segmentsTile) {
      const tmpVideoPath = `${mergedOutFilePath}.tmpvideo`;
      try {
        // 第一遍：仅 concat 视频流（每段帧数已由 -frames:v 精确控制，时间轴零漂移）
        await concatFiles({ paths: segmentPaths, outDir, outPath: tmpVideoPath, metadataFromPath, outFormat, includeAllStreams: true, streams, ffmpegExperimental, onProgress, preserveMovData, movFastStart, chapters, preserveMetadataOnMerge, videoTimebase: mergeTimescale, videoOnly: true });

        // 第二遍：从源视频单遍复制音轨（音频连续完整，与源视频一致）
        const formatArgs: string[] = outFormat != null ? ['-f', outFormat] : [];
        const muxArgs: string[] = [
          '-hide_banner',
          '-i', tmpVideoPath,
          '-i', filePath,
          '-map', '0:v',
          '-map', '1:a?',
          '-c', 'copy',
          ...(mergeTimescale != null ? ['-video_track_timescale', String(mergeTimescale)] : []),
          '-map_metadata', '0',
          '-map_chapters', '0',
          ...getMovFlags({ outFormat, preserveMovData, movFastStart }),
          ...formatArgs,
          '-y', mergedOutFilePath,
        ];
        appendFfmpegCommandLog(muxArgs);
        const result = await runFfmpeg(muxArgs);
        logStdoutStderr(result);
      } finally {
        await tryDeleteFiles([tmpVideoPath]);
      }
      return;
    }

    await concatFiles({ paths: segmentPaths, outDir, outPath: mergedOutFilePath, metadataFromPath, outFormat, includeAllStreams: true, streams, ffmpegExperimental, onProgress, preserveMovData, movFastStart, chapters, preserveMetadataOnMerge, videoTimebase: mergeTimescale });
  }, [appendFfmpegCommandLog, concatFiles, filePath, shouldSkipExistingFile]);

  // This is just used to load something into the player with correct duration,
  // so that the user can seek and then we render frames using ffmpeg & MediaSource
  const html5ifyDummy = useCallback(async ({ filePath: filePathArg, outPath, onProgress }: {
    filePath: string,
    outPath: string,
    onProgress: (p: number) => void,
  }) => {
    console.log('Making ffmpeg-assisted dummy file', { filePathArg, outPath });

    const duration = await getDuration(filePathArg);

    const ffmpegArgs = [
      '-hide_banner',

      // This is just a fast way of generating an empty dummy file
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t', String(duration),
      '-acodec', 'flac',
      '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpegWithProgress({ ffmpegArgs, duration, onProgress });
    logStdoutStderr(result);

    await transferTimestamps({ inPath: filePathArg, outPath, duration, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart });
  }, [appendFfmpegCommandLog, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart]);

  const html5ify = useCallback(async ({ customOutDir, filePath: filePathArg, speed, hasAudio, hasVideo, onProgress }: {
    customOutDir: string | undefined,
    filePath: string,
    speed: Html5ifyMode,
    hasAudio: boolean,
    hasVideo: boolean,
    onProgress: (p: number) => void,
  }) => {
    console.log('html5ifyAndLoad', { speed, hasVideo, hasAudio });

    if (speed === 'fastest') {
      const path = getSuffixedOutPath({ customOutDir, filePath: filePathArg, nameSuffix: `${html5ifiedPrefix}${html5dummySuffix}.mkv` });
      await html5ifyDummy({ filePath: filePathArg, outPath: path, onProgress });
      return path;
    }

    const outPath = getHtml5ifiedPath(customOutDir, filePathArg, speed);
    invariant(outPath != null);

    let audio: 'hq' | 'lq' | 'copy' | undefined;
    if (hasAudio) {
      if (speed === 'slowest') audio = 'hq';
      else if (['slow-audio', 'fast-audio'].includes(speed)) audio = 'lq';
      else if (['fast-audio-remux'].includes(speed)) audio = 'copy';
    }

    let video: 'hq' | 'lq' | 'copy' | undefined;
    if (hasVideo) {
      if (speed === 'slowest') video = 'hq';
      else if (['slow-audio', 'slow'].includes(speed)) video = 'lq';
      else video = 'copy';
    }

    console.log('Making HTML5 friendly version', { filePathArg, outPath, speed, video, audio });

    let videoArgs: string[];
    let audioArgs: string[];

    // h264/aac_at: No licensing when using HW encoder (Video/Audio Toolbox on Mac)
    // https://github.com/mifi/lossless-cut/issues/372#issuecomment-810766512

    switch (video) {
      case 'hq': {
        // eslint-disable-next-line unicorn/prefer-ternary
        if (isMac) {
          videoArgs = ['-vf', 'format=yuv420p', '-allow_sw', '1', '-vcodec', 'h264', '-b:v', '15M'];
        } else {
          // AV1 is very slow
          // videoArgs = ['-vf', 'format=yuv420p', '-sws_flags', 'neighbor', '-vcodec', 'libaom-av1', '-crf', '30', '-cpu-used', '8'];
          // Theora is a bit faster but not that much
          // videoArgs = ['-vf', '-c:v', 'libtheora', '-qscale:v', '1'];
          // videoArgs = ['-vf', 'format=yuv420p', '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1'];
          // x264 can only be used in GPL projects
          videoArgs = ['-vf', 'format=yuv420p', '-c:v', 'libx264', '-profile:v', 'high', '-preset:v', 'slow', '-crf', '17'];
        }
        break;
      }
      case 'lq': {
        const targetHeight = 400;

        // eslint-disable-next-line unicorn/prefer-ternary
        if (isMac) {
          videoArgs = ['-vf', `scale=-2:${targetHeight},format=yuv420p`, '-allow_sw', '1', '-sws_flags', 'lanczos', '-vcodec', 'h264', '-b:v', '1500k'];
        } else {
          // videoArgs = ['-vf', `scale=-2:${targetHeight},format=yuv420p`, '-sws_flags', 'neighbor', '-c:v', 'libtheora', '-qscale:v', '1'];
          // x264 can only be used in GPL projects
          videoArgs = ['-vf', `scale=-2:${targetHeight},format=yuv420p`, '-sws_flags', 'neighbor', '-c:v', 'libx264', '-profile:v', 'baseline', '-x264opts', 'level=3.0', '-preset:v', 'ultrafast', '-crf', '28'];
        }
        break;
      }
      case 'copy': {
        videoArgs = ['-vcodec', 'copy'];
        break;
      }
      default: {
        videoArgs = ['-vn'];
      }
    }

    switch (audio) {
      case 'hq': {
        // eslint-disable-next-line unicorn/prefer-ternary
        if (isMac) {
          audioArgs = ['-acodec', 'aac_at', '-b:a', '192k'];
        } else {
          audioArgs = ['-acodec', 'flac'];
        }
        break;
      }
      case 'lq': {
        // eslint-disable-next-line unicorn/prefer-ternary
        if (isMac) {
          audioArgs = ['-acodec', 'aac_at', '-ar', '44100', '-ac', '2', '-b:a', '96k'];
        } else {
          audioArgs = ['-acodec', 'flac', '-ar', '11025', '-ac', '2'];
        }
        break;
      }
      case 'copy': {
        audioArgs = ['-acodec', 'copy'];
        break;
      }
      default: {
        audioArgs = ['-an'];
      }
    }

    // Some files (e.g. DV/DVCPRO .mov) have an audio channel layout that ffmpeg cannot resample or
    // downmix, which makes the encode fail. Relabel the channels first so that it can.
    // We don't pass -map, so ffmpeg picks one audio stream by itself. Therefore only apply the filter
    // when every audio stream has the same channel count, or the filter might not match the picked stream.
    let audioFilterArgs: string[] = [];
    if (audio != null && audio !== 'copy') {
      try {
        const audioStreams = (await readFileFfprobeMeta(filePathArg)).streams.filter((s) => s.codec_type === 'audio');
        const unsupportedStream = audioStreams.find((s) => hasCustomChannelLayout(s.channel_layout));
        const sameChannelCount = new Set(audioStreams.map((s) => s.channels)).size === 1;
        if (unsupportedStream != null && sameChannelCount) {
          const filter = getFixChannelLayoutFilter({ channels: unsupportedStream.channels, channelLayout: unsupportedStream.channel_layout });
          if (filter != null) audioFilterArgs = ['-af', filter];
        }
      } catch (err) {
        // don't fail the conversion just because we couldn't probe it
        console.warn('Failed to probe audio channel layout', err);
      }
    }

    const ffmpegArgs = [
      '-hide_banner',
      ...((video === 'lq' || video === 'hq') ? getHwaccelArgs(ffmpegHwaccel) : []),

      '-i', filePathArg,
      ...videoArgs,
      ...audioArgs,
      ...audioFilterArgs,
      '-sn',
      '-y', outPath,
    ];

    const duration = await getDuration(filePathArg);
    appendFfmpegCommandLog(ffmpegArgs);
    const { stdout } = await runFfmpegWithProgress({ ffmpegArgs, duration, onProgress });

    console.log(new TextDecoder().decode(stdout));

    invariant(outPath != null);
    await transferTimestamps({ inPath: filePathArg, outPath, duration, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart });
    return outPath;
  }, [appendFfmpegCommandLog, ffmpegHwaccel, html5ifyDummy, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart]);

  // https://stackoverflow.com/questions/34118013/how-to-determine-webm-duration-using-ffprobe
  const fixInvalidDuration = useCallback(async ({ filePath: filePathArg, outPath, onProgress }: {
    filePath: string,
    outPath: string,
    onProgress: (a: number) => void,
  }) => {
    const ffmpegArgs = [
      '-hide_banner',

      '-i', filePathArg,

      // https://github.com/mifi/lossless-cut/issues/1415
      '-map_metadata', '0',
      '-map', '0',
      '-ignore_unknown',

      '-c', 'copy',
      '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpegWithProgress({ ffmpegArgs, onProgress });
    logStdoutStderr(result);

    return outPath;
  }, [appendFfmpegCommandLog]);

  // https://github.com/mifi/lossless-cut/issues/2111
  const decimate = useCallback(async ({ filePath: filePathArg, outPath, n, fps }: {
    n: number,
    fps: number,
    filePath: string,
    outPath: string,
  }) => {
    const ffmpegArgs = [
      '-hide_banner',

      // https://stackoverflow.com/questions/73710657/remove-all-non-keyframes-from-h-264-avc-video-without-re-encoding
      // https://stackoverflow.com/questions/67088473/remove-all-non-key-frames-from-video-without-re-encoding
      // '-discard', 'nokey', // doesn't seem to work with hevc, so use noise=drop=not(key) instead
      // https://chatgpt.com/share/6a1c3be1-1064-83ec-b5c1-fa91ddf3cde8
      '-i', filePathArg,
      '-map', 'v:0',
      '-c', 'copy',
      '-bsf:v', `noise=drop=not(key),noise=drop='mod(n\\,${formatFfmpegNumber(n)})',setts=ts='N/${formatFfmpegNumber(fps)}/TB_OUT'`,
      '-an',
      '-ignore_unknown',
      '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpeg(ffmpegArgs);
    logStdoutStderr(result);

    return outPath;
  }, [appendFfmpegCommandLog]);

  function getPreferredCodecFormat(stream: LiteFFprobeStream) {
    const map = {
      mp3: { format: 'mp3', ext: 'mp3' },
      opus: { format: 'opus', ext: 'opus' },
      vorbis: { format: 'ogg', ext: 'ogg' },
      h264: { format: 'mp4', ext: 'mp4' },
      hevc: { format: 'mp4', ext: 'mp4' },
      eac3: { format: 'eac3', ext: 'eac3' },

      subrip: { format: 'srt', ext: 'srt' },
      mov_text: { format: 'mp4', ext: 'mp4' },

      m4a: { format: 'ipod', ext: 'm4a' },
      aac: { format: 'adts', ext: 'aac' },
      jpeg: { format: 'image2', ext: 'jpeg' },
      png: { format: 'image2', ext: 'png' },

      // TODO add more
      // TODO allow user to change?
    } as const;

    const match = map[stream.codec_name as keyof typeof map];
    if (match) return match;

    // default fallbacks:
    if (stream.codec_type === 'video') return { ext: 'mkv', format: 'matroska' } as const;
    if (stream.codec_type === 'audio') return { ext: 'mka', format: 'matroska' } as const;
    if (stream.codec_type === 'subtitle') return { ext: 'mks', format: 'matroska' } as const;
    if (stream.codec_type === 'data') return { ext: 'bin', format: 'data' } as const; // https://superuser.com/questions/1243257/save-data-stream

    return undefined;
  }

  const extractNonAttachmentStreams = useCallback(async ({ customOutDir, streams }: {
    customOutDir?: string | undefined, streams: FFprobeStream[],
  }) => {
    invariant(filePath != null);
    if (streams.length === 0) return [];

    const outStreams = streams.flatMap((s) => {
      const format = getPreferredCodecFormat(s);
      const { index } = s;

      if (format == null || index == null) return [];

      return [{
        index,
        codec: s.codec_name || s.codec_tag_string || s.codec_type,
        type: s.codec_type,
        format,
      }];
    });

    // console.log(outStreams);


    let streamArgs: string[] = [];
    const outPaths = await pMap(outStreams, async ({ index, codec, type, format: { format, ext } }) => {
      const outPath = getSuffixedOutPath({ customOutDir, filePath, nameSuffix: `stream-${index}-${type}-${codec}.${ext}` });
      if (!enableOverwriteOutput && await mainApi.pathExists(outPath)) throw new RefuseOverwriteError();

      streamArgs = [
        ...streamArgs,
        '-map', `0:${index}`, '-c', 'copy', '-f', format, '-y', outPath,
      ];
      return outPath;
    }, { concurrency: 1 });

    const ffmpegArgs = [
      '-hide_banner',

      '-i', filePath,
      ...streamArgs,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const { stdout } = await runFfmpeg(ffmpegArgs);
    console.log(new TextDecoder().decode(stdout));

    return outPaths;
  }, [appendFfmpegCommandLog, enableOverwriteOutput, filePath]);

  const extractAttachmentStreams = useCallback(async ({ customOutDir, streams }: {
    customOutDir?: string | undefined, streams: FFprobeStream[],
  }) => {
    invariant(filePath != null);
    if (streams.length === 0) return [];

    console.log('Extracting', streams.length, 'attachment streams');

    let streamArgs: string[] = [];
    const outPaths = await pMap(streams, async ({ index, codec_name: codec, codec_type: type }) => {
      const ext = codec || 'bin';
      const outPath = getSuffixedOutPath({ customOutDir, filePath, nameSuffix: `stream-${index}-${type}-${codec}.${ext}` });
      invariant(outPath != null);
      if (!enableOverwriteOutput && await mainApi.pathExists(outPath)) throw new RefuseOverwriteError();

      streamArgs = [
        ...streamArgs,
        `-dump_attachment:${index}`, outPath,
      ];
      return outPath;
    }, { concurrency: 1 });

    const ffmpegArgs = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      ...streamArgs,
      '-i', filePath,
    ];

    try {
      appendFfmpegCommandLog(ffmpegArgs);
      const { stdout } = await runFfmpeg(ffmpegArgs);
      console.log(new TextDecoder().decode(stdout));
    } catch (err) {
      // Unfortunately ffmpeg will exit with code 1 even though it's a success
      // Note: This is kind of hacky:
      if (err instanceof Error && 'exitCode' in err && 'stderr' in err && err.exitCode === 1 && typeof err.stderr === 'string' && err.stderr.includes('At least one output file must be specified')) return outPaths;
      throw err;
    }
    return outPaths;
  }, [appendFfmpegCommandLog, enableOverwriteOutput, filePath]);

  // https://stackoverflow.com/questions/32922226/extract-every-audio-and-subtitles-from-a-video-with-ffmpeg
  const extractStreams = useCallback(async ({ customOutDir, streams }: {
    customOutDir: string | undefined, streams: FFprobeStream[],
  }) => {
    invariant(filePath != null);
    await assertFileExists(filePath);

    const attachmentStreams = streams.filter((s) => s.codec_type === 'attachment');
    const nonAttachmentStreams = streams.filter((s) => s.codec_type !== 'attachment');

    // TODO progress

    // Attachment streams are handled differently from normal streams
    return [
      ...(await extractNonAttachmentStreams({ customOutDir, streams: nonAttachmentStreams })),
      ...(await extractAttachmentStreams({ customOutDir, streams: attachmentStreams })),
    ];
  }, [extractAttachmentStreams, extractNonAttachmentStreams, filePath]);

  return {
    cutMultiple, concatFiles, html5ify, html5ifyDummy, fixInvalidDuration, decimate, concatCutSegments, extractStreams, tryDeleteFiles,
  };
}

export default useFfmpegOperations;

export type FfmpegOperations = ReturnType<typeof useFfmpegOperations>;
