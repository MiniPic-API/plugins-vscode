/**
 * MiniPic 压缩 API 客户端（对接 `POST /v1/compress`，api-spec 4.2）。
 *
 * 契约：
 *  - 请求：原始图片字节为 body，`Authorization: Bearer mp_live_...`，
 *    查询参数 `quality`、`format`。
 *  - 响应：200 + 压缩后字节；体积/比率/尺寸经响应头返回。
 */

export interface CompressResult {
  data: Buffer;
  /** 输出 MIME（如 image/webp），用于推断输出扩展名。 */
  mime: string;
  inputSize: number;
  outputSize: number;
  /** 输出/输入 体积比（越小压得越狠）。 */
  ratio: number;
  width: number;
  height: number;
  /** 当月已计费张数（Compression-Count 头）。 */
  compressionCount?: number;
}

/** 携带 HTTP 状态码的 API 错误，便于上层按 401/413/429/422 分流处理。 */
export class MiniPicApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MiniPicApiError";
  }
}

export interface CompressParams {
  baseUrl: string;
  apiKey: string;
  data: Uint8Array;
  quality: string;
  format: string;
}

export async function compressBuffer(params: CompressParams): Promise<CompressResult> {
  const url =
    `${params.baseUrl}/v1/compress` +
    `?quality=${encodeURIComponent(params.quality)}` +
    `&format=${encodeURIComponent(params.format)}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: params.data,
    });
  } catch (e) {
    throw new MiniPicApiError(0, `网络请求失败：${(e as Error).message}`);
  }

  if (!resp.ok) {
    throw new MiniPicApiError(resp.status, await readErrorDetail(resp));
  }

  const data = Buffer.from(await resp.arrayBuffer());
  const h = resp.headers;
  return {
    data,
    mime: h.get("content-type") || "application/octet-stream",
    inputSize: numHeader(h.get("x-input-size")) ?? params.data.byteLength,
    outputSize: numHeader(h.get("x-output-size")) ?? data.byteLength,
    ratio: numHeader(h.get("x-ratio")) ?? data.byteLength / Math.max(1, params.data.byteLength),
    width: numHeader(h.get("image-width")) ?? 0,
    height: numHeader(h.get("image-height")) ?? 0,
    compressionCount: numHeader(h.get("compression-count")),
  };
}

export interface UsageInfo {
  month: string;
  compressed: number;
  free_quota: { total: number; used: number };
  pay_as_you_go: { count: number; estimated_amount_cny: string };
  /** 资源包余额（套餐包用户非空；服务端 /v1/usage 一直返回，旧客户端此前未解析）。 */
  bundles?: { remaining: number; total: number }[];
  /** 付费态（free 档为 false）：区分免费用户与付费/资源包用户。新版服务端字段，旧服务端缺省。 */
  has_payment?: boolean;
  /** 免费额度下次重置时刻（Unix 秒）。新版服务端字段；缺省时客户端按计费月推算。 */
  next_reset_at?: number;
}

export async function fetchUsage(baseUrl: string, apiKey: string): Promise<UsageInfo> {
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/v1/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    throw new MiniPicApiError(0, `网络请求失败：${(e as Error).message}`);
  }
  if (!resp.ok) {
    throw new MiniPicApiError(resp.status, await readErrorDetail(resp));
  }
  return (await resp.json()) as UsageInfo;
}

/** 解析服务端错误响应体（`{ error: { message } }`），失败则回退到状态码语义。 */
async function readErrorDetail(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { error?: { message?: string }; message?: string };
    const msg = body?.error?.message || body?.message;
    if (msg) {
      return msg;
    }
  } catch {
    // 非 JSON 响应体，落到下方状态码语义
  }
  switch (resp.status) {
    case 401:
      return "API Key 无效或缺失";
    case 413:
      return "图片超过体积上限";
    case 422:
      return "图片格式不支持或过于复杂";
    case 429:
      return "请求过于频繁或已达配额上限";
    default:
      return `请求失败（HTTP ${resp.status}）`;
  }
}

function numHeader(value: string | null): number | undefined {
  if (value == null) {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
