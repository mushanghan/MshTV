# Windows 内置媒体工具

MshTV 的 Windows 发布包内置 FFmpeg 9.0.2 和 ffprobe。它们作为独立进程读取媒体信息、提取静态封面并生成 WebP 预览和音频峰值。浏览器负责播放原始视频和音频。

## 对应源码与许可证

[v0.9.4 的 Release](https://github.com/mushanghan/MshTV/releases/tag/v0.9.4) 同时提供 Windows 安装包、媒体工具和对应源码包。源码包包含未修改的上游源文件归档及实际使用的构建脚本。

| 组件 | 来源 | 许可证 |
| --- | --- | --- |
| FFmpeg 9.0.2 | [FFmpeg 源码](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz) | LGPL-2.1-or-later |
| libwebp 1.6.0 | [WebP 源码](https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz) | BSD-3-Clause，附 WebP 专利授权 |
| zlib 1.4 | [zlib 源码](https://zlib.net/zlib-1.4.tar.gz) | Zlib |
| dav1d 1.5.3 | [VideoLAN 源码](https://download.videolan.org/pub/videolan/dav1d/1.5.3/dav1d-1.5.3.tar.xz) | BSD-2-Clause |

构建禁用了网络协议、硬件加速、采集设备和 FFplay。保留浏览器常见视频、音频和静态影像所需的原生解码、AV1 软件解码，以及静态 WebP 和 PCM 输出。安装目录的 `licenses/ffmpeg/` 包含媒体组件的许可文本和来源。可独立获取、修改和构建这些工具。

## 复建工具与安装包

准备 [w64devkit 2.11.0 x64](https://github.com/skeeto/w64devkit/releases/tag/v2.11.0)、Git for Windows、Meson 1.10.0 和 Ninja 1.13.0。将 Git、Meson 与 Ninja 放在 `PATH`，准备 Release 中的源码归档。`-WorkDirectory` 需是尚未存在、没有空格的 ASCII 路径。

```powershell
pwsh -File tools/ffmpeg/build-media.ps1 -Sources C:/ffmpeg-sources `
  -Toolchain C:/w64devkit -WorkDirectory C:/mshtv-media-build
```

脚本先校验源码归档的 SHA-256，再在本地编译。FFmpeg 的配置选项见脚本。编译时没有修改任何上游源码。MinGW-w64、GCC 和构建工具的来源及构建配置见 [w64devkit 2.11.0 源码](https://github.com/skeeto/w64devkit/tree/v2.11.0)。

构建官方安装包可使用 Release 中的 `MshTV-Windows-MediaTools-x64.zip`。解压后将包含 `ffmpeg.exe`、`ffprobe.exe` 和 `licenses/` 的目录传给构建脚本。官方分发流程使用 [媒体二进制校验清单](../tools/ffmpeg/windows-media.lock.json) 核对两个程序，编译环境变化后需重新记录校验值与对应构建材料。安装与运行时均从本地读取组件。

```powershell
pwsh -File tools/build-windows.ps1 -Version 0.9.4 -MediaKit C:/mshtv-media-build/media-kit
```
