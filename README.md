<div align="center">
	 

  <p><a href="https://losslesscut.app/"><img src="src/renderer/src/icon.svg" width="120" alt="LosslessCut" /></a></p>
  <p><a href="https://losslesscut.app/"><b>LosslessCut</b></a></p>
  无损视频/音频编辑的瑞士军刀
	

  <img src="https://github.com/mifi/lossless-cut/workflows/Build/release/badge.svg" />
  <a href="https://paypal.me/mifino/usd"><img src="https://img.shields.io/badge/Donate-PayPal-green.svg" /></a> <a href="https://github.com/mifi/lossless-cut#download"><img src="https://img.shields.io/github/v/release/mifi/lossless-cut" /></a> <a href="https://discord.gg/fhnEREfUJ3"><img src="https://img.shields.io/discord/986051448385183804" /></a> <a href="https://twitter.com/losslesscut"><img src="https://img.shields.io/twitter/follow/losslesscut?label=Twitter\&style=social" alt="Twitter"></a>
	 

	 

  <a href="https://mifi.no/thanks/">感谢我的赞助者们</a> 以及所有购买 LosslessCut 的用户！
	 

	 

  <p align="center"><img src="main_screenshot.jpg" width="600" alt="screenshot" /></p>
	 

	 

</div>

# ⚠️ 本分支修改说明（帧号精确切割）

本分支基于 [mifi/lossless-cut](https://github.com/mifi/lossless-cut) 修改，**核心改动：关键帧切割模式改为"按帧号精确切割"**，修复了原版关键帧切割导致的分段帧数偏差问题。

## 修改背景

原版 LosslessCut 在关键帧切割（流复制）模式下使用 `-t <时长>` 截断输出。FFmpeg 的 `-t` 在流复制时按 **dts（解码时间戳）** 判定截断点，对于含有 B 帧的视频（H264/H265 常见），dts 相对 pts（显示时间戳）存在延迟，导致**每个分段末尾会多带入若干帧**（通常等于 B 帧层数，如 2 帧）。

后果：把一个视频切成 N 段后，各分段帧数之和大于源视频总帧数；分段经外部工具（如补帧、超分）处理后，再按顺序 `concat -c copy` 合并时，无法与源视频逐帧对齐。

## 修改内容

修改位于 `src/renderer/src/hooks/useFfmpegOperations.ts` 的 `losslessCutSingle` 函数：

- 在关键帧切割模式（`keyframeCut`）下，按帧号计算本段精确视频帧数：`N = round((cutTo - cutFrom) × fps)`
- 在原有 `-t` 之外追加 **`-frames:v N`**，对视频流做确定性截断（`-t` 保留用于限制音频流）
- `-frames:v` 按输出包计数，不受 B 帧重排影响，保证每个分段的视频帧数精确等于两个关键帧之间的帧数，**各分段帧数之和与源视频完全一致**
- 智能切割（Smart Cut）的无损部分同样受益于该修复
- 仅在满足以下条件时启用（其余情况自动回退原逻辑）：
  - 使用关键帧切割模式（流复制）
  - 已成功检测到帧率（FPS）
  - 单一输入文件（不含外部附加文件）

## 使用要求

1. 在导出设置中启用**关键帧切割**模式
2. 分段边界应吸附到关键帧（可用时间线上的关键帧跳转）
3. 建议将"切割起点帧调整 / 切割终点帧调整"两个设置都设为 **0**，以获得逐帧精确对齐
4. 分段经处理后按顺序合并时使用 `ffmpeg -f concat -safe 0 -i list.txt -c copy`，再从源视频复制音轨即可

## 新增功能与修复（本分支扩展）

在帧号精确切割的基础上，本分支进一步扩展了以下功能与修复：

### 片段级变换（实时预览 + 导出重编码）

- 底栏新增**水平翻转 / 垂直翻转 / 右旋 90°** 三个按钮，仅作用于当前选中片段；旋转按钮循环切换 90° → 180° → 270° → 不旋转，并显示当前角度
- 播放器实时预览：基于 CSS transform（`scaleX`/`scaleY`/`rotate`），暂停单帧同样生效
- 变换持久化到 `.llc` 项目文件（`segmentTransform` 字段）
- 导出时：无变换片段纯流复制；有变换片段对主视频流注入 `hflip`/`vflip`/`transpose` 滤镜并重编码，其余轨道照常流复制
- 混合旋转（部分片段旋转 90°/270°）合并时，旋转片段自动 letterbox 回源尺寸

### 硬件编码（NVENC）

- 设置页新增「**启用硬件编码（NVENC）**」开关（默认关）。勾选后重编码使用：
  `h264_nvenc -preset p6 -tune hq -rc vbr -cq 19 -b:v 0`
  （`-b:v 0` 必须显式设置，否则 `-cq` 会被 NVENC 默认 2Mbps 码率上限覆盖）
- 未勾选时保持 `libx264 -crf 18 -preset medium`
- WebM 输出不走 NVENC（无 vp9 硬编编码器），始终使用 `libvpx-vp9`
- 解决了 libx264 默认线程数（逻辑核 ×1.5）导致导出时 CPU 满载、系统假死的问题

### 与源一致的编码参数（修复 CFR→VFR）

重编码片段不再使用 ffmpeg 默认行为，而是完整复刻源视频的可复现参数，确保切割合并后仍是恒定帧率：

```
-x264-params keyint=N:min-keyint=N:scenecut=0:force-cfr=1:bframes=0   # CPU 分支
-g N -forced-idr 1 -strict_gop 1 -no-scenecut 1 -bf 0                # NVENC 分支
-pix_fmt yuv420p -profile:v high -level 4.1 -r <outFps> -fps_mode cfr
-color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709
-video_track_timescale <timescale> -brand mp42
```

- `-bf 0`（禁用 B 帧）：源视频无 B 帧时，转码段带 B 帧会导致 concat 交界处 dts 被打上 1-tick 补丁、stts 表混入异类时长，MediaInfo 等工具据此误判为可变帧率
- 帧率与 GOP 动态计算（`fpsKeyint.ts`，含单元测试）：
  - ≥24fps：帧率就近归一到 6 的倍数（29.97→30、30.1→30、50→48），keyint=6
  - <24fps：取 0.2~0.5 秒内能整除帧率的最小整数（15→3、20→4），质数兜底取 0.2s 下限
- **帧率归一转码**：无变换片段若归一后帧率与源不同（如 29.97→30、50→48），也自动转码为固定 CFR 输出，不再流复制；相同则维持纯流复制
- timescale 统一（`timescaleForFps`）：流复制段与转码段强制同一视频轨 timescale（30fps→15360，每帧恰好 512 tick），修复混合时基（如源 1/90000 + 转码 1/15360）喂给 concat demuxer 导致合并成品时长膨胀数倍的严重 bug

### B 帧结构统一（混合合并全转码）

- 源视频带 B 帧（`has_b_frames > 0`）且本次导出存在至少一个转码段时，合并模式下所有片段统一重编码为无 B 帧结构，再 copy 合并
- 分段输出不含音频（纯视频），合并分两遍：第一遍纯视频 concat（时间轴零漂移），第二遍从源视频单遍复制音轨——**确保合并成品总时长与源精确一致**
- 各分段帧数由 `-frames:v` 按帧号守恒（telescoping），全 copy 合并（无转码段）不受影响

### 其他改进与修复

- **临时盘目录**：设置页可指定临时输出目录，导出先写临时盘再复制到最终目录（规避 SMB 网络盘写入僵死），复制保留时间戳
- **导出界面刷新节流**：ffmpeg 进度 IPC 节流 500ms，不再每行 stderr 触发全量重渲染
- ffmpeg 进度解析跳过 `time=N/A`（消除 Invalid time 日志噪音）；导出失败时 stderr 尾部 20 行写入日志
- 内置 FFmpeg 更换为官方 gyan 8.1.2 full build（原 n7.1-58 定制版存在 0xC0000005 偶发崩溃）
- electron-builder `electronDist` 本地化，打包零下载
- `.llc` 项目文件关联注册、Electron fuses 加固

## 构建（Windows）

项目根目录已新增 `build.bat`，双击或命令行执行即可：

1. 安装依赖（首次，自动配置 Electron 国内镜像）
2. 准备内置 FFmpeg（优先从本机 PATH 复制 `ffmpeg.exe`/`ffprobe.exe`，否则从 GitHub 下载）
3. `electron-vite build` 编译
4. `electron-builder --win --x64 --dir` 只产出 **win-unpacked 解压目录**（`dist/win-unpacked`，`electronDist` 已本地化，打包零下载），不再打包便携版单 exe

依赖环境：Node.js 18+（需加入 PATH）；下载 FFmpeg 备选方案需要 7-Zip。

---

LosslessCut 致力于成为终极的跨平台 FFmpeg 图形界面，对视频、音频、字幕及其他相关媒体文件执行极其快速的无损操作。
其核心功能是对视频和音频文件进行无损修剪与切割，非常适合对摄像机、GoPro、无人机等拍摄的大型视频文件进行粗剪以节省空间。它让你快速提取视频中的精彩部分并丢弃数 GB 的无用数据，而无需缓慢的重编码、不损失任何质量。还有更多[使用场景](#典型无损使用案例)。一切都极其快速，因为它几乎是直接的数据复制，由强大的 FFmpeg 完成所有繁重的工作。

## 目录

- [功能特性](#功能特性)
- [典型无损使用案例](#典型无损使用案例)
- [下载](#下载)
- [支持的格式](#支持的格式)
- [文档、用法与入门](#文档)
- [视频演示](#视频演示)
- [媒体报道](#媒体报道)
- [致谢](#致谢)

## 功能特性

- 对大多数视频和音频格式进行无损切割
- [智能切割 Smart cut](https://github.com/mifi/lossless-cut/issues/126)（实验性）
- 无损剪切视频/音频的片段（例如剪掉广告等）
- 无损重排视频/音频片段的顺序
- 无损合并/拼接任意文件（需编解码参数一致，例如来自同一台摄像机）
- 无损多轨道/多流编辑
  - 组合多个文件中的任意轨道（例如为视频添加音乐或字幕轨）
  - 移除不需要的轨道
  - 仅替换或重编码部分轨道
  - 从一个文件中提取所有轨道（将视频、音频、字幕、附件等轨道分别提取为独立文件）
- 查看所有轨道的技术数据。编辑文件元数据、每轨元数据和每轨 disposition
- 选择视频/音频轨道进行播放。可同时播放多个音轨。
- 快速的多文件工作流（注意：尚无批量导出功能）
- 键盘快捷键工作流
- 无损重封装（remux）视频/音频到不同的容器（文件）格式
- 以 JPEG/PNG 格式截取全分辨率视频快照（低或高质量）
- 将视频帧区间导出为图片（每隔 n 帧、每秒、按场景切换、最佳缩略图）
  - 仅从选定时间范围（分段）导出
  - 可选在图片文件名中包含原始时间戳
- 手动输入切割点时间
- 应用每文件时间码偏移（并自动从文件加载时间码）
- 更改视频的旋转/方向元数据
- 时间线缩放和帧/关键帧跳转，便于围绕关键帧切割
- 视频缩略图和音频波形
- 将项目的切割分段保存到项目文件
- 查看 FFmpeg 最后的命令日志，便于在命令行上修改并重新运行最近的命令
- 撤销/重做
- 高级分段查询与变更的 JS 表达式语言
- 为切割分段添加标签、注解
- [导入/导出](docs/index.md#importexport-projects)分段：MP4/MKV 章节标记、文本文件、YouTube、CSV、CUE、XML（DaVinci、Final Cut Pro）等
- MKV/MP4 内嵌章节标记编辑器
- 查看字幕
- 自定义键盘热键
- 黑场检测、静音检测和场景切换检测
- 将时间线划分为指定时长 L、指定大小（X MB）、指定段数 N 甚至随机长度的分段！
- 加速/减速视频或音频文件（[更改 FPS](https://github.com/mifi/lossless-cut/issues/1712)）
- 无损裁剪（crop）与宽高比修改
- 基础 [CLI](docs/cli.md) 与 [HTTP API](docs/api.md)
- 在地图上显示（DJI）内嵌 GPS 轨迹
- 通过 HTTP 无损下载视频（例如 HLS `.m3u8`）
- 极快速移除所有非关键帧（例如延时摄影）

## 典型无损使用案例

- 从录制的电视节目中剪除广告（并将 TS 转为 MP4）。
- 从文件中移除音轨。
- 从视频中提取音乐轨并按需剪切。
- 为视频添加音乐（或替换现有音轨）。
- 组合来自不同录制的音频和视频轨道。
- 将外部字幕嵌入视频
- 快速将 H264/H265 的 MKV 视频转换为 MOV 或 MP4 以便在 iPhone 上播放。
- 从其他工具导入切割时间列表（EDL 编辑决策列表、CSV），然后用 LosslessCut 执行这些切割。
- 将切割时间列表导出为 CSV EDL，在其他工具中继续处理。
- 按 MP4/MKV 章节快速切割文件。
- 按 [YouTube 视频](https://youtube-dl.org/)的章节（或评论中的音乐时间）快速切割。
- 更改文件音频/字幕轨道的语言标记。
- 从外部 JPEG 文件或时间线上的某一帧为视频/音频附加封面图/缩略图。
- 更改视频的作者、标题、GPS 位置、录制时间。
- 修复方向标记错误的视频旋转。
- 无需重编码快速循环播放视频/音频片段 X 次，见 [#284](https://github.com/mifi/lossless-cut/issues/284)。
- 将视频或其部分转换为 X 张图片文件（非无损）
- 按场景无损分割视频为多个文件（注意可能需要微调分段，见 [#330](https://github.com/mifi/lossless-cut/issues/330)。）
- 从音频/视频文件中剪除静音部分。
- 将视频分割成多个片段，例如满足 Twitter 的 140 秒限制。
- 为每个分段添加一个或多个标签，用标签整理分段，或用于创建输出的文件夹结构/层级。

另请参阅[菜谱手册](docs/recipes.md)

## 下载

如果你想支持我对 LosslessCut 的持续开发，并希望获得安全、简便的安装流程以及自动稳定更新，可以考虑从你喜欢的应用商店获取：

<a href="https://apps.apple.com/app/id1505323402"><img src="mac-app-store-badge.svg" alt="Mac App Store" height="50"/></a> <a href="https://www.microsoft.com/store/apps/9P30LSR4705L?cid=storebadge\&ocid=badge"><img src="ms-store-badge.svg" alt="MS badge" height="50"/></a>

Linux 版发布在 Snap Store：

<a href="https://snapcraft.io/losslesscut"><img src="https://github.com/mifi/lossless-cut/raw/master/snap-store-black.svg?sanitize=true" alt="Snapcraft" height="50"/></a>

如果你更喜欢手动下载可执行文件，这里永远免费（另请参阅[支持的操作系统](docs/requirements.md)）：

- macOS：[Intel](https://github.com/mifi/lossless-cut/releases/latest/download/LosslessCut-mac-x64.dmg) / [Apple Silicon](https://github.com/mifi/lossless-cut/releases/latest/download/LosslessCut-mac-arm64.dmg) DMG（注意 PKG **不可用**）
- Windows：[7zip](https://github.com/mifi/lossless-cut/releases/latest/download/LosslessCut-win-x64.7z)（Windows 7、8 和 8.1 在 [v3.50.0 之后不再支持](docs/requirements.md)）
- Linux：[x64 tar.bz2](https://github.com/mifi/lossless-cut/releases/latest/download/LosslessCut-linux-x64.tar.bz2) / [x64 AppImage](https://github.com/mifi/lossless-cut/releases/latest/download/LosslessCut-linux-x86_64.AppImage) / [arm64 tar.bz2](https://github.com/mifi/lossless-cut/releases/latest/download/LosslessCut-linux-arm64.tar.bz2) / [树莓派 armv7l](https://github.com/mifi/lossless-cut/releases/latest/download/LosslessCut-linux-armv7l.tar.bz2)
- [更多发布版本](https://github.com/mifi/lossless-cut/releases) - 注意 APPX（Windows）和 PKG（macOS）**不可用**）
- [最新 nightly 构建 🧪](https://mifi.no/llc/nightly/)

注意，以上是[仅有的官方下载渠道](docs/index.md#faq)。也有非官方发布版本，例如 [Flathub](https://flathub.org/apps/details/no.mifi.losslesscut)（非本人维护）。应用商店与 GitHub 下载的区别？[请参阅 FAQ](docs/index.md#faq)。

![](./donate.svg)

LosslessCut 由我一人维护，并将永远保持免费开源。如果它对你有用，请考虑支持我的工作。也可以[向 FFmpeg 团队捐款](https://www.ffmpeg.org/donations.html)，因为他们居功至伟。

[Paypal](https://paypal.me/mifino/usd) | [加密货币](https://mifi.no/thanks) | [更多方式](https://mifi.no/thanks)

## 支持的格式


LosslessCut 使用 Chromium 浏览器的 HTML5 视频播放器，并非所有格式/编解码器都受[原生支持](https://www.chromium.org/audio-video)。通常，以下文件格式可用：`MP4`、`MOV`、`WebM`、`Matroska`、`OGG` 和 `WAV`。音频编解码器：`FLAC`、`MP3`、`Opus`、`PCM`、`Vorbis` 和 `AAC`。视频编解码器：`H264`、`AV1`、`Theora`、`VP8`、`VP9` 和 `H265`（需硬件解码器）。了解[编解码器与格式的区别](docs/index.md#primer-videoaudio-codecs-vs-formats)。未列出的编解码器和格式仍可通过 `文件` 菜单转换为受支持的格式/编解码器（先尝试 *最快：FFmpeg 辅助播放* 选项）。之后会创建一个低质量版本的文件并在播放器中打开。注意，实际的切割/导出操作仍在原始文件上执行，因此依然是无损的。这意味着理论上可以打开任何 FFmpeg 能解码的文件。

## 文档

- 官方网站：[LosslessCut.app](https://losslesscut.app)
- **[入门、FAQ 与使用文档](docs/index.md)**
- [故障排除、已知问题与限制](docs/troubleshooting.md)
- [参与贡献](CONTRIBUTING.md)

### 视频演示

- [常见功能](https://www.youtube.com/watch?v=pYHMxXy05Jg)
- [如何为 MP4 添加缩略图/封面](https://www.youtube.com/watch?v=4pYJ93cn80E)
- [如何为视频添加多语言音轨](https://www.youtube.com/watch?v=MRBGDsuw_WU)
- 你的视频？放这里！

## 媒体报道

- [Console newsletter](https://console.substack.com/p/console-93)
- Hacker News [2024](https://news.ycombinator.com/item?id=40829494) [2022](https://news.ycombinator.com/item?id=33969490) [2020-10](https://news.ycombinator.com/item?id=24883030) [2020-01](https://news.ycombinator.com/item?id=22026412) [2016](https://news.ycombinator.com/item?id=12885585)
- [Wikipedia](https://en.m.wikipedia.org/wiki/LosslessCut)
- 你的链接？放这里！
- theo (YouTube) [1](https://youtu.be/FI5ba4RRE8U?t=246) [2](https://youtu.be/uaCypXEJjes?t=381)

![Star History Chart](https://api.star-history.com/svg?repos=mifi/lossless-cut\&type=Date)

## 致谢

- 应用图标由 [Dimi Kazak](http://www.flaticon.com/authors/dimi-kazak) 制作，来自 [www.flaticon.com](http://www.flaticon.com)，授权协议 [CC 3.0 BY](http://creativecommons.org/licenses/by/3.0/)。
- [Lottie 动画来自 Chris Gannon](https://lottiefiles.com/7077-magic-flow)。
- 感谢 Adi Abinun 和 [@abdul-alhasany](https://github.com/mifi/lossless-cut/issues/2561) 的界面设计工作。
- 感谢参与翻译的译者们。[你也可以参与！](docs/translation.md)
- [感谢所有支持](https://mifi.no/thanks/)我开源工作的人 🙌

---

用 ❤️ 制作于 [🇳🇴](https://www.youtube.com/watch?v=uQIv8Vo9_Jc)

[更多 mifi.no 的应用](https://mifi.no/)

在 [GitHub](https://github.com/mifi/)、[YouTube](https://www.youtube.com/channel/UC6XlvVH63g0H54HSJubURQA)、[IG](https://www.instagram.com/mifi.no/)、[Twitter](https://twitter.com/mifi_no) 上关注我，获取更多精彩内容！
