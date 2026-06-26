# MiniPic 图片压缩 · VSCode 插件

在 VSCode 内一键压缩图片，由 [MiniPic](https://minipic.cn) 自研引擎驱动。支持 PNG / JPEG / WebP / GIF / AVIF / TIFF，可在压缩的同时转换格式（如转 WebP / AVIF 进一步减小体积）。

## 功能

- 资源管理器右键 **MiniPic: 压缩图片**：支持单张、多选、整个文件夹（递归）。
- 资源管理器右键 **MiniPic: 转 WebP 并替换引用**：把 PNG/JPEG/BMP/TIFF 转成更小的 WebP（同时压缩），删除原图，并在整个工程内自动把对这些图片的引用改写为 `.webp`——换格式 + 改代码一步到位。
- 质量档位：智能 / 高保真 / 极限 / 无损。
- 输出格式：保持原格式，或转 PNG/JPEG/WebP/GIF/AVIF/TIFF。
- 安全护栏：已压缩过的图片不再重复压缩，自动跳过；超大文件自动略过。
- **自动压缩**：右下角状态栏一键开启，工作区新增/改动的图片全自动托管压缩，无需手动操作。
- **MiniPic: 查看用量**：查看当月已用额度与剩余百分比、额度重置时间与按量预估。
- API Key 经 VSCode SecretStorage 安全存储，不写入明文配置。

## 快速开始

1. 在 [minipic.cn](https://minipic.cn) 控制台创建 API Key（`mp_live_` 开头）。
2. 按 `⌘⇧P`（Windows / Linux 为 `Ctrl+Shift+P`）打开命令面板，输入并执行 **MiniPic: 设置 API Key**，粘贴 Key。
3. 在资源管理器右键图片或文件夹 → **MiniPic: 压缩图片**（或 **MiniPic: 转 WebP 并替换引用**）。
4. 点击右下角状态栏的 **MiniPic** 开启自动压缩，项目图片全托管——新增/改动即自动压缩。

## 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `minipic.baseUrl` | `https://api.minipic.cn` | API 服务地址（私有化部署时修改） |
| `minipic.quality` | `smart` | 压缩质量档位 |
| `minipic.format` | `keep` | 输出格式 |
| `minipic.skipIfLarger` | `true` | 同格式压缩变大时跳过 |
| `minipic.keepOriginalOnConvert` | `true` | 转格式时保留原文件 |
| `minipic.maxFileSizeMB` | `80` | 跳过超过该大小的文件 |
| `minipic.autoCompress` | `false` | 监听新增/改动图片自动压缩（消耗配额） |
| `minipic.apiKey` | `""` | 明文回退（不推荐，建议用命令存储） |

## 说明

本插件通过 MiniPic 官方压缩接口 `POST /v1/compress` 工作，压缩在服务端完成。默认走智能档位：复杂图片优先保证画质，简单图片在肉眼无损的前提下大幅降低体积。压缩后的文件直接写回原路径（转格式时写新文件）。

**API 额度**：免费用户 500 张/月；Pro 用户 1,000 张/月（Pro 定价 ¥99/年）。额度之外可单独购买 API 资源包，具体定价以[官网](https://minipic.cn/pricing)为准。
