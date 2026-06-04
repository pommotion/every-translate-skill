// every-translate: fetch proxy 配置
// 简化版：undici@5 兼容（只支持 HTTP/HTTPS proxy，SOCKS5 留 P2）
import undiciPkg from "undici";
const { ProxyAgent, setGlobalDispatcher } = undiciPkg;

function normalizeProxyUrl(value) {
  const proxy = String(value || "").trim();
  if (!proxy) return "";
  return proxy;
}

function selectProxyUrl() {
  return (
    normalizeProxyUrl(process.env.HTTPS_PROXY) ||
    normalizeProxyUrl(process.env.https_proxy) ||
    normalizeProxyUrl(process.env.ALL_PROXY) ||
    normalizeProxyUrl(process.env.all_proxy) ||
    normalizeProxyUrl(process.env.HTTP_PROXY) ||
    normalizeProxyUrl(process.env.http_proxy)
  );
}

export function configureFetchProxy() {
  const proxyUrl = selectProxyUrl();
  if (!proxyUrl) return null;

  const lower = proxyUrl.toLowerCase();
  if (lower.startsWith("socks5://") || lower.startsWith("socks5h://")) {
    console.warn(`[proxy] SOCKS5 proxy not supported in P1 (undici@5). Use HTTP/HTTPS proxy or upgrade to undici@6+.`);
    return null;
  }

  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    try {
      const dispatcher = new ProxyAgent({ uri: proxyUrl });
      setGlobalDispatcher(dispatcher);
      return proxyUrl;
    } catch (error) {
      console.warn(`[proxy] Failed to configure ProxyAgent: ${error.message}`);
      return null;
    }
  }

  console.warn(`[proxy] Unsupported proxy scheme: ${proxyUrl}`);
  return null;
}
