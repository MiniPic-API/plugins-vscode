import * as vscode from "vscode";

/** SecretStorage 中存放 API Key 的键名（优先于明文 settings）。 */
const SECRET_API_KEY = "minipic.apiKey";

/** 支持的输入图片扩展名（小写，不含点）。 */
export const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "avif",
  "tif",
  "tiff",
  "bmp",
]);

export interface MiniPicConfig {
  baseUrl: string;
  quality: string;
  format: string;
  skipIfLarger: boolean;
  keepOriginalOnConvert: boolean;
  maxFileSizeBytes: number;
}

/** 读取插件配置；baseUrl 去掉尾部斜杠便于拼接。 */
export function readConfig(): MiniPicConfig {
  const c = vscode.workspace.getConfiguration("minipic");
  return {
    baseUrl: (c.get<string>("baseUrl") || "https://api.minipic.cn").replace(/\/+$/, ""),
    quality: c.get<string>("quality") || "smart",
    format: c.get<string>("format") || "keep",
    skipIfLarger: c.get<boolean>("skipIfLarger", true),
    keepOriginalOnConvert: c.get<boolean>("keepOriginalOnConvert", true),
    maxFileSizeBytes: Math.max(1, c.get<number>("maxFileSizeMB", 80)) * 1024 * 1024,
  };
}

/** 取 API Key：优先 SecretStorage，回退到明文设置项。 */
export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const fromSecret = await context.secrets.get(SECRET_API_KEY);
  if (fromSecret) {
    return fromSecret.trim();
  }
  const fromSetting = vscode.workspace.getConfiguration("minipic").get<string>("apiKey");
  return fromSetting?.trim() || undefined;
}

export async function setApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store(SECRET_API_KEY, key.trim());
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_API_KEY);
}
