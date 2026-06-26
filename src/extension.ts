import * as path from "path";
import * as vscode from "vscode";

import { compressBuffer, fetchUsage, MiniPicApiError, UsageInfo } from "./api";
import {
  clearApiKey,
  getApiKey,
  IMAGE_EXTS,
  MiniPicConfig,
  readConfig,
  setApiKey,
} from "./config";

/** MIME → 输出扩展名（用于格式转换时确定新文件名）。 */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/tiff": "tiff",
};

/** 递归压缩时跳过的目录：版本库 / 依赖 / 构建产物 / 缓存（多为只读或不该改动）。 */
const IGNORED_DIRS = new Set<string>([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "bower_components",
  "vendor",
  // 构建 / 产物
  "build",
  "DerivedData",
  "SourcePackages",
  "Pods",
  "Carthage",
  ".build",
  "target",
  ".gradle",
  ".next",
  ".nuxt",
  ".output",
  // 缓存 / 虚拟环境
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
]);

/** 可转 WebP 的源格式（排除已是现代格式的 webp/avif、动图 gif、矢量 svg）。 */
const WEBP_CONVERTIBLE = new Set<string>(["png", "jpg", "jpeg", "bmp", "tiff", "tif"]);

/** 替换引用时扫描的文本文件类型。 */
const TEXT_EXTS = new Set<string>([
  "html", "htm", "vue", "svelte", "astro",
  "css", "scss", "sass", "less", "styl",
  "js", "cjs", "mjs", "jsx", "ts", "tsx",
  "md", "mdx", "json", "jsonc", "xml", "yml", "yaml",
  "php", "twig", "erb", "hbs", "ejs",
]);

let autoCompressor: AutoCompressor | undefined;
let statusBar: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "minipic.toggleAutoCompress";
  context.subscriptions.push(statusBar);

  autoCompressor = new AutoCompressor(context);
  context.subscriptions.push(autoCompressor);

  context.subscriptions.push(
    vscode.commands.registerCommand("minipic.compress", (clicked?: vscode.Uri, selected?: vscode.Uri[]) =>
      runCompress(context, clicked, selected),
    ),
    vscode.commands.registerCommand("minipic.setApiKey", () => commandSetApiKey(context)),
    vscode.commands.registerCommand("minipic.clearApiKey", () => commandClearApiKey(context)),
    vscode.commands.registerCommand("minipic.showUsage", () => commandShowUsage(context)),
    vscode.commands.registerCommand("minipic.toggleAutoCompress", () => commandToggleAutoCompress()),
    vscode.commands.registerCommand("minipic.convertToWebp", (clicked?: vscode.Uri, selected?: vscode.Uri[]) =>
      runConvertToWebp(context, clicked, selected),
    ),
  );

  // 配置变更时同步自动压缩开关与状态栏
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("minipic.autoCompress")) {
        syncAutoCompress();
      }
    }),
  );

  syncAutoCompress();
}

export function deactivate(): void {
  autoCompressor?.dispose();
  autoCompressor = undefined;
}

/** 按当前配置启停自动压缩并刷新状态栏。 */
function syncAutoCompress(): void {
  const enabled = vscode.workspace.getConfiguration("minipic").get<boolean>("autoCompress", false);
  if (enabled) {
    autoCompressor?.start();
  } else {
    autoCompressor?.stop();
  }
  if (statusBar) {
    statusBar.text = enabled ? "$(zap) MiniPic 自动" : "$(circle-slash) MiniPic";
    statusBar.tooltip = enabled
      ? "MiniPic 自动压缩：已开启（点击关闭）"
      : "MiniPic 自动压缩：已关闭（点击开启）";
    statusBar.show();
  }
}

async function commandToggleAutoCompress(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("minipic");
  const next = !cfg.get<boolean>("autoCompress", false);
  await cfg.update("autoCompress", next, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`MiniPic：自动压缩已${next ? "开启" : "关闭"}。`);
  // onDidChangeConfiguration 会触发 syncAutoCompress；此处无需重复
}

// ===================== 命令：压缩 =====================

async function runCompress(
  context: vscode.ExtensionContext,
  clicked?: vscode.Uri,
  selected?: vscode.Uri[],
): Promise<void> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    await promptMissingKey(context);
    return;
  }

  const config = readConfig();
  const roots = pickRoots(clicked, selected);
  if (roots.length === 0) {
    vscode.window.showWarningMessage("MiniPic：请在资源管理器中右键图片或文件夹后再压缩。");
    return;
  }

  const files = await collectImageFiles(roots, config.maxFileSizeBytes);
  if (files.length === 0) {
    vscode.window.showWarningMessage("MiniPic：未找到可压缩的图片（或均超过大小上限）。");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "MiniPic 压缩中…",
      cancellable: true,
    },
    async (progress, token) => {
      const summary = new CompressSummary();
      for (let i = 0; i < files.length; i++) {
        if (token.isCancellationRequested) {
          break;
        }
        const file = files[i];
        progress.report({
          message: `(${i + 1}/${files.length}) ${path.basename(file.fsPath)}`,
          increment: 100 / files.length,
        });
        try {
          await compressOne(file, apiKey, config, summary);
        } catch (e) {
          // 仅 401（Key 失效）整批中止；权限/网络/格式等单文件错静默计入失败、继续
          if (e instanceof MiniPicApiError && e.status === 401) {
            await handleAuthFailure(context);
            return;
          }
          summary.failed++;
          if (!summary.firstError) {
            summary.firstError = e instanceof Error ? e.message : String(e);
          }
        }
      }
      reportSummary(summary, files.length);
    },
  );
}

/** 压缩单个文件并按格式策略写回磁盘。 */
async function compressOne(
  file: vscode.Uri,
  apiKey: string,
  config: MiniPicConfig,
  summary: CompressSummary,
): Promise<void> {
  const input = await vscode.workspace.fs.readFile(file);
  const result = await compressBuffer({
    baseUrl: config.baseUrl,
    apiKey,
    data: input,
    quality: config.quality,
    format: config.format,
  });

  const origExt = normalizeExt(path.extname(file.fsPath).slice(1));
  const outExt = normalizeExt(MIME_EXT[result.mime] ?? origExt);
  const sameFormat = outExt === origExt;

  if (sameFormat) {
    // 同格式覆盖；变大且开启保护则跳过
    if (config.skipIfLarger && result.outputSize >= result.inputSize) {
      summary.skipped++;
      return;
    }
    markSelfWrite(file);
    await vscode.workspace.fs.writeFile(file, result.data);
  } else {
    // 转格式：写入新扩展名文件，按配置决定是否删除原文件
    const target = withExtension(file, outExt);
    markSelfWrite(target);
    await vscode.workspace.fs.writeFile(target, result.data);
    if (!config.keepOriginalOnConvert && target.fsPath !== file.fsPath) {
      await vscode.workspace.fs.delete(file);
    }
  }

  summary.succeeded++;
  summary.inputBytes += result.inputSize;
  summary.outputBytes += result.outputSize;
}

// ===================== 命令：转 WebP 并替换引用 =====================

async function runConvertToWebp(
  context: vscode.ExtensionContext,
  clicked?: vscode.Uri,
  selected?: vscode.Uri[],
): Promise<void> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    await promptMissingKey(context);
    return;
  }

  const config = readConfig();
  const roots = pickRoots(clicked, selected);
  if (roots.length === 0) {
    vscode.window.showWarningMessage("MiniPic：请右键文件夹（或图片）后再转 WebP。");
    return;
  }

  const files = await collectImageFiles(roots, config.maxFileSizeBytes, WEBP_CONVERTIBLE);
  if (files.length === 0) {
    vscode.window.showWarningMessage("MiniPic：未找到可转换的图片（png / jpg / bmp / tiff）。");
    return;
  }

  // 破坏性操作：删原图 + 改源码引用。模态确认，提示先提交便于回滚。
  const go = await vscode.window.showWarningMessage(
    `MiniPic：将把 ${files.length} 张图片转为 WebP（同时压缩），删除原图，并在工程内把对这些文件的引用改为 .webp。\n\n此操作会改写源码并删除文件，建议先用 Git 提交以便回滚。是否继续？`,
    { modal: true },
    "继续",
  );
  if (go !== "继续") {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "MiniPic 转 WebP 中…",
      cancellable: true,
    },
    async (progress, token) => {
      const summary = new CompressSummary();
      // 旧文件名(basename.ext) → 新文件名(basename.webp)，供引用替换
      const renameMap = new Map<string, string>();

      for (let i = 0; i < files.length; i++) {
        if (token.isCancellationRequested) {
          break;
        }
        const file = files[i];
        progress.report({
          message: `(${i + 1}/${files.length}) ${path.basename(file.fsPath)}`,
          increment: 100 / files.length,
        });
        try {
          await convertOneToWebp(file, apiKey, config, summary, renameMap);
        } catch (e) {
          if (e instanceof MiniPicApiError && e.status === 401) {
            await handleAuthFailure(context);
            return;
          }
          summary.failed++;
          if (!summary.firstError) {
            summary.firstError = e instanceof Error ? e.message : String(e);
          }
        }
      }

      let refFiles = 0;
      let refCount = 0;
      if (renameMap.size > 0 && !token.isCancellationRequested) {
        progress.report({ message: "更新代码引用…" });
        const r = await replaceReferences(renameMap);
        refFiles = r.files;
        refCount = r.count;
      }

      reportWebpSummary(summary, files.length, refFiles, refCount);
    },
  );
}

/** 转单张为 WebP（含压缩），写出 .webp、删原图，并登记重命名映射。 */
async function convertOneToWebp(
  file: vscode.Uri,
  apiKey: string,
  config: MiniPicConfig,
  summary: CompressSummary,
  renameMap: Map<string, string>,
): Promise<void> {
  const input = await vscode.workspace.fs.readFile(file);
  // format=webp 经 /v1/compress：引擎在转格式的同时按质量档压缩（一次请求两件事）
  const result = await compressBuffer({
    baseUrl: config.baseUrl,
    apiKey,
    data: input,
    quality: config.quality,
    format: "webp",
  });

  const target = withExtension(file, "webp");
  markSelfWrite(target);
  await vscode.workspace.fs.writeFile(target, result.data);
  if (target.fsPath !== file.fsPath) {
    await vscode.workspace.fs.delete(file); // 删原图（已转 webp，引用随后改写）
  }

  renameMap.set(path.basename(file.fsPath), path.basename(target.fsPath));
  summary.succeeded++;
  summary.inputBytes += result.inputSize;
  summary.outputBytes += result.outputSize;
}

/**
 * 全工程替换图片引用：把文本文件里对 `name.png/.jpg/...` 的引用改为 `name.webp`。
 *
 * 匹配以「文件名 token」为粒度（前置非文件名字符 + 精确 basename.ext + 后不接单词字符），
 * 避免误伤 `app-logo.png`（目标 `logo.png` 时）这类更长文件名。仅替换确实转过的文件。
 * 局限：按 basename 匹配——若工程内别处有同名未转的图片，其引用可能被一并改写（已在确认弹窗提示先提交）。
 */
async function replaceReferences(
  renameMap: Map<string, string>,
): Promise<{ files: number; count: number }> {
  // 长名优先，避免交替式正则把短名匹配进长名
  const names = [...renameMap.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const re = new RegExp(`(^|[^\\w.\\-])(${names.join("|")})(?![\\w.])`, "g");

  const include = `**/*.{${[...TEXT_EXTS].join(",")}}`;
  const exclude = `**/{${[...IGNORED_DIRS].join(",")}}/**`;
  const uris = await vscode.workspace.findFiles(include, exclude);

  let files = 0;
  let count = 0;
  for (const uri of uris) {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      continue;
    }
    if (bytes.byteLength > 4 * 1024 * 1024) {
      continue; // 跳过超大文本文件
    }
    const text = Buffer.from(bytes).toString("utf8");
    let local = 0;
    const next = text.replace(re, (_m, pre: string, hit: string) => {
      local++;
      return pre + (renameMap.get(hit) ?? hit);
    });
    if (local > 0 && next !== text) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(next, "utf8"));
      files++;
      count += local;
    }
  }
  return { files, count };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reportWebpSummary(
  s: CompressSummary,
  total: number,
  refFiles: number,
  refCount: number,
): void {
  const errEg = s.failed && s.firstError ? `；例：${s.firstError}` : "";
  if (s.succeeded === 0) {
    vscode.window.showWarningMessage(
      `MiniPic：转 WebP 成功 0/${total}${s.failed ? `，失败 ${s.failed}` : ""}${errEg}。`,
    );
    return;
  }
  const saved = s.inputBytes - s.outputBytes;
  const pct = s.inputBytes > 0 ? Math.round((saved / s.inputBytes) * 100) : 0;
  const failStr = s.failed ? `，失败 ${s.failed}${errEg}` : "";
  vscode.window.showInformationMessage(
    `MiniPic：转 WebP ${s.succeeded}/${total} 张，省 ${formatBytes(saved)}（-${pct}%），` +
      `更新 ${refCount} 处引用（${refFiles} 个文件）${failStr}。`,
  );
}

// ===================== 命令：Key 管理 / 用量 =====================

async function commandSetApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: "MiniPic API Key",
    prompt: "粘贴你的 API Key（mp_live_ 开头），可在 minipic.cn 控制台获取。",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "mp_live_...",
    validateInput: (v) =>
      v.trim().startsWith("mp_live_") || v.trim().startsWith("mp_test_")
        ? undefined
        : "Key 应以 mp_live_ 或 mp_test_ 开头",
  });
  if (key) {
    await setApiKey(context, key);
    vscode.window.showInformationMessage("MiniPic：API Key 已安全保存。");
  }
}

async function commandClearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await clearApiKey(context);
  vscode.window.showInformationMessage("MiniPic：API Key 已清除。");
}

async function commandShowUsage(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    await promptMissingKey(context);
    return;
  }
  const config = readConfig();
  try {
    const u = await fetchUsage(config.baseUrl, apiKey);
    await presentUsage(u, config.baseUrl);
  } catch (e) {
    await handleCompressError(context, e);
  }
}

/**
 * 用量展示：第一行「已用/额度 + 剩余百分比」，第二行一句总结（重置时间 + 分档引导）。
 * - 资源包用户：仅提示额度充足 / 不足（不足给「购买资源包」按钮）；
 * - 已付费订阅用户：提示额度状态 + 重置时间；
 * - 免费用户：提示重置时间 + 引导开通 Pro（给「开通 Pro」按钮）。
 */
async function presentUsage(u: UsageInfo, baseUrl: string): Promise<void> {
  const total = u.free_quota.total;
  const used = u.free_quota.used;
  const remaining = Math.max(0, total - used);
  const pct = total > 0 ? Math.round((remaining / total) * 100) : 0;
  const payg = u.pay_as_you_go;
  const bundle = (u.bundles ?? []).find((b) => b.total > 0);
  const resetText = formatResetDate(u);

  const paygSuffix =
    payg && payg.count > 0 ? `｜按量 ${payg.count} 张 ≈ ¥${payg.estimated_amount_cny}` : "";
  const headline =
    `MiniPic 用量（${u.month}）：免费额度已用 ${used}/${total} 张` +
    `（剩余 ${remaining} 张 · ${pct}%）${paygSuffix}`;

  let summary: string;
  const actions: string[] = [];
  if (bundle) {
    // 套餐包/资源包用户：只提示额度充足 / 不足
    const low = bundle.remaining <= Math.max(50, Math.ceil(bundle.total * 0.1));
    summary =
      `资源包余额 ${bundle.remaining}/${bundle.total} 张，${low ? "额度不足，请及时续购" : "额度充足"}；` +
      `免费额度将于 ${resetText} 重置。`;
    if (low) {
      actions.push("购买资源包");
    }
  } else if (u.has_payment) {
    // 已付费订阅用户（无资源包）：仅提示额度状态 + 重置时间
    summary =
      remaining > 0
        ? `额度充足，将于 ${resetText} 重置。`
        : `本月额度已用尽，超出部分按量计费；额度将于 ${resetText} 重置。`;
  } else {
    // 免费用户：引导开通 Pro
    summary = `免费额度将于 ${resetText} 重置。开通 Pro：1,000 张/月，仅 ¥99/年（约 ¥8/月）。`;
    actions.push("开通 Pro");
  }

  const pick = await vscode.window.showInformationMessage(`${headline}\n${summary}`, ...actions);
  if (pick === "开通 Pro") {
    await openSite(baseUrl, "/pricing");
  } else if (pick === "购买资源包") {
    await openSite(baseUrl, "/console/billing");
  }
}

/** 免费额度重置日期文案：优先服务端 next_reset_at，缺省时按计费月推算下个自然月 1 日。 */
function formatResetDate(u: UsageInfo): string {
  let d: Date;
  if (typeof u.next_reset_at === "number" && u.next_reset_at > 0) {
    d = new Date(u.next_reset_at * 1000);
  } else {
    // 回退：u.month = "2026-06" → 下个自然月 1 日（本地时区）
    const [y, m] = u.month.split("-").map((s) => parseInt(s, 10));
    d =
      Number.isFinite(y) && Number.isFinite(m)
        ? new Date(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)
        : new Date();
  }
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 从 API baseUrl 推导站点 URL（去掉 api. 子域）并打开指定路径。 */
async function openSite(baseUrl: string, urlPath: string): Promise<void> {
  let siteBase = baseUrl;
  try {
    const url = new URL(baseUrl);
    url.hostname = url.hostname.replace(/^api\./, "");
    siteBase = url.origin;
  } catch {
    // baseUrl 非法时退回原值
  }
  await vscode.env.openExternal(vscode.Uri.parse(`${siteBase}${urlPath}`));
}

// ===================== 辅助逻辑 =====================

/** 右键单选/多选归一：优先多选数组，回退单击 Uri。 */
function pickRoots(clicked?: vscode.Uri, selected?: vscode.Uri[]): vscode.Uri[] {
  if (selected && selected.length > 0) {
    return selected;
  }
  return clicked ? [clicked] : [];
}

/** 递归展开文件夹，筛出受支持且不超限的图片文件（exts 可指定子集，默认全部支持格式）。 */
async function collectImageFiles(
  roots: vscode.Uri[],
  maxBytes: number,
  exts: Set<string> = IMAGE_EXTS,
): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  const seen = new Set<string>();

  async function walk(uri: vscode.Uri): Promise<void> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return;
    }
    if (stat.type & vscode.FileType.Directory) {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      for (const [name, type] of entries) {
        // 跳过版本库 / 依赖 / 构建产物 / 缓存目录：多为只读或不该改动，
        // 递归进去只会触发 EACCES 或压到不该压的产物（如 Xcode DerivedData）
        if (type & vscode.FileType.Directory && IGNORED_DIRS.has(name)) {
          continue;
        }
        await walk(vscode.Uri.joinPath(uri, name));
      }
      return;
    }
    const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
    if (!exts.has(ext) || stat.size > maxBytes || seen.has(uri.fsPath)) {
      return;
    }
    seen.add(uri.fsPath);
    out.push(uri);
  }

  for (const root of roots) {
    await walk(root);
  }
  return out;
}

/** 401（Key 失效）专用：清除 Key 并引导重设。批量与单次共用。 */
async function handleAuthFailure(context: vscode.ExtensionContext): Promise<void> {
  await clearApiKey(context);
  const pick = await vscode.window.showErrorMessage(
    "MiniPic：API Key 无效，已清除。请重新设置。",
    "设置 API Key",
  );
  if (pick) {
    await commandSetApiKey(context);
  }
}

/** 单次操作错误处理（如查看用量）：401 走重设引导，其余直接弹错。返回是否致命。 */
async function handleCompressError(context: vscode.ExtensionContext, e: unknown): Promise<boolean> {
  if (e instanceof MiniPicApiError && e.status === 401) {
    await handleAuthFailure(context);
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e);
  vscode.window.showErrorMessage(`MiniPic 压缩失败：${msg}`);
  return false;
}

async function promptMissingKey(context: vscode.ExtensionContext): Promise<void> {
  const pick = await vscode.window.showInformationMessage(
    "MiniPic：尚未设置 API Key。可在 minipic.cn 控制台获取后设置。",
    "设置 API Key",
  );
  if (pick) {
    await commandSetApiKey(context);
  }
}

function reportSummary(s: CompressSummary, total: number): void {
  // 失败时附带首条原因，省去逐文件弹窗又能让用户看清问题
  const errEg = s.failed && s.firstError ? `；例：${s.firstError}` : "";
  if (s.succeeded === 0) {
    const parts = [`成功 0/${total}`];
    if (s.skipped) parts.push(`跳过 ${s.skipped}`);
    if (s.failed) parts.push(`失败 ${s.failed}`);
    vscode.window.showWarningMessage(`MiniPic：${parts.join("，")}${errEg}。`);
    return;
  }
  const saved = s.inputBytes - s.outputBytes;
  const pct = s.inputBytes > 0 ? Math.round((saved / s.inputBytes) * 100) : 0;
  const tail = [];
  if (s.skipped) tail.push(`跳过 ${s.skipped}`);
  if (s.failed) tail.push(`失败 ${s.failed}`);
  const tailStr = tail.length ? `（${tail.join("，")}${errEg}）` : "";
  vscode.window.showInformationMessage(
    `MiniPic：压缩 ${s.succeeded}/${total} 张，节省 ${formatBytes(saved)}（-${pct}%）${tailStr}。`,
  );
}

/** 同目录替换扩展名得到新 Uri。 */
function withExtension(uri: vscode.Uri, ext: string): vscode.Uri {
  const dir = path.dirname(uri.fsPath);
  const base = path.basename(uri.fsPath, path.extname(uri.fsPath));
  return vscode.Uri.file(path.join(dir, `${base}.${ext}`));
}

/** 扩展名归一：jpeg→jpg、tif→tiff，便于「同格式」判断。 */
function normalizeExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpeg") return "jpg";
  if (e === "tif") return "tiff";
  return e;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

class CompressSummary {
  succeeded = 0;
  skipped = 0;
  failed = 0;
  inputBytes = 0;
  outputBytes = 0;
  /** 首个失败原因（批量时只报一次，避免逐文件弹窗） */
  firstError?: string;
}

// ===================== 自动压缩（监听新增/改动） =====================

/** 自写防回环：记录刚由插件写出的文件路径及过期时间，避免文件监听回声触发再压缩。 */
const selfWriteGuard = new Map<string, number>();
const SELF_WRITE_GUARD_MS = 8000;

function markSelfWrite(uri: vscode.Uri): void {
  selfWriteGuard.set(uri.fsPath, Date.now() + SELF_WRITE_GUARD_MS);
}

function isSelfWrite(uri: vscode.Uri): boolean {
  const expiry = selfWriteGuard.get(uri.fsPath);
  if (expiry == null) {
    return false;
  }
  if (Date.now() > expiry) {
    selfWriteGuard.delete(uri.fsPath);
    return false;
  }
  return true;
}

/**
 * 监听工作区图片的新增/改动并自动压缩。
 *
 * 防回环靠两点：① 写回前 markSelfWrite 登记目标路径，监听到自写回声即跳过；
 * ② 每文件 800ms 去抖，合并连续保存。无 Key 时静默跳过、不打扰。
 */
class AutoCompressor implements vscode.Disposable {
  private watcher?: vscode.FileSystemWatcher;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private keyInvalid = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  start(): void {
    if (this.watcher) {
      return;
    }
    this.keyInvalid = false;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      "**/*.{png,jpg,jpeg,webp,gif,avif,tif,tiff,bmp}",
    );
    this.watcher.onDidCreate((u) => this.schedule(u));
    this.watcher.onDidChange((u) => this.schedule(u));
  }

  stop(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  dispose(): void {
    this.stop();
  }

  private schedule(uri: vscode.Uri): void {
    if (this.keyInvalid || isSelfWrite(uri)) {
      return;
    }
    const key = uri.fsPath;
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        void this.run(uri);
      }, 800),
    );
  }

  private async run(uri: vscode.Uri): Promise<void> {
    if (this.keyInvalid || isSelfWrite(uri)) {
      return;
    }
    const apiKey = await getApiKey(this.context);
    if (!apiKey) {
      return; // 未配置 Key：静默跳过，不打扰
    }
    const config = readConfig();

    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return; // 文件已不存在
    }
    const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
    if (!IMAGE_EXTS.has(ext) || stat.size > config.maxFileSizeBytes) {
      return;
    }

    try {
      const summary = new CompressSummary();
      await compressOne(uri, apiKey, config, summary);
      if (summary.succeeded > 0) {
        const saved = summary.inputBytes - summary.outputBytes;
        const pct = summary.inputBytes > 0 ? Math.round((saved / summary.inputBytes) * 100) : 0;
        vscode.window.setStatusBarMessage(
          `MiniPic：已压缩 ${path.basename(uri.fsPath)}，省 ${formatBytes(saved)}（-${pct}%）`,
          4000,
        );
      }
    } catch (e) {
      if (e instanceof MiniPicApiError && e.status === 401) {
        // Key 失效：暂停自动压缩避免反复弹错
        this.keyInvalid = true;
        await clearApiKey(this.context);
        vscode.window.showErrorMessage("MiniPic：API Key 无效，自动压缩已暂停，请重新设置后再开启。");
      }
      // 其余错误静默，避免自动模式刷屏
    }
  }
}
