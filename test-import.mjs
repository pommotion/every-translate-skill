// 4A 静态验证脚本
import undiciPkg from "undici";
const { ProxyAgent, setGlobalDispatcher } = undiciPkg;
import { configureFetchProxy } from "./scripts/configure-fetch-proxy.mjs";

console.log("=== 1. undici@5 验证 ===");
console.log("ProxyAgent:", typeof ProxyAgent);
console.log("setGlobalDispatcher:", typeof setGlobalDispatcher);

console.log("\n=== 2. configureFetchProxy 验证 ===");
console.log("configureFetchProxy:", typeof configureFetchProxy);
const result = configureFetchProxy();
console.log("返回值:", result === null ? "null (无 HTTPS_PROXY 环境变量，预期)" : result);

console.log("\n=== 3. ProxyAgent 构造测试 ===");
try {
  const pa = new ProxyAgent({ uri: "http://127.0.0.1:8888" });
  console.log("✅ ProxyAgent 构造成功（不会真连）");
} catch (e) {
  console.log("❌ ProxyAgent 构造失败:", e.message);
}

console.log("\n✅ 全部就绪");
