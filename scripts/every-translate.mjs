#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { configureFetchProxy } from "./configure-fetch-proxy.mjs";

const NEWSLETTER_URL = "https://every.to/newsletter";
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODEL = process.env.EVERY_NEWSLETTER_MODEL || "deepseek-v4-pro";
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const DISCOVERY_WINDOW_DAYS = 7;
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.EVERY_NEWSLETTER_FETCH_TIMEOUT_MS || "45000", 10);
const MODEL_TIMEOUT_MS = Number.parseInt(process.env.EVERY_NEWSLETTER_MODEL_TIMEOUT_MS || "240000", 10);
const CHROME_COOKIE_DB = path.join(process.env.HOME || "", "Library", "Application Support", "Google", "Chrome", "Default", "Cookies");
const CHROME_KEYCHAIN = path.join(process.env.HOME || "", "Library", "Keychains", "login.keychain-db");

const LOCKED_SIGNALS = [
  "Create a free account to continue reading",
  "Sign in to continue reading",
  "Subscribe to continue reading",
  "Unlock this article",
  "Become a subscriber",
  "This post is for paying subscribers",
  "Continue reading with a free account",
];

const FULL_POST_TAIL_SIGNALS = [
  "What did you think of this post?",
  "For sponsorship opportunities",
  "Upgrade to paid",
  "Already have an account?",
];

const NEWSLETTER_COMPLETE_SIGNALS = [
  "What did you think of this post?",
  "Write a comment",
  "Privacy Preferences",
  "Every Media, Inc.",
];

const GENERIC_LINK_TEXT = new Set([
  "Every",
  "Newsletter",
  "Home",
  "Login",
  "Sign In",
  "Subscribe",
  "Read More",
  "Start Here",
]);

const NON_ARTICLE_SECTIONS = new Set([
  "about",
  "careers",
  "cdn-cgi",
  "columnists",
  "consulting",
  "events",
  "faq",
  "login",
  "newsletter",
  "podcast",
  "search",
  "store",
  "studio",
  "subscribe",
  "team",
]);

const PROXY_ENV_KEYS = [
  "ALL_PROXY",
  "all_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
];

class PipelineStageError extends Error {
  constructor(stage, message) {
    super(message);
    this.name = "PipelineStageError";
    this.stage = stage;
  }
}

async function loadLocalEnv(root) {
  const disableProxy = /^(1|true|yes)$/i.test(process.env.EVERY_NEWSLETTER_DISABLE_PROXY || "");
  for (const name of [".env.local", ".env"]) {
    try {
      const raw = await fs.readFile(path.join(root, name), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (disableProxy && PROXY_ENV_KEYS.includes(match?.[1])) continue;
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function initFetchProxy() {
  const disableProxy = /^(1|true|yes)$/i.test(process.env.EVERY_NEWSLETTER_DISABLE_PROXY || "");
  if (disableProxy) {
    for (const key of PROXY_ENV_KEYS) delete process.env[key];
    return null;
  }
  return configureFetchProxy();
}

function parseArgs(argv) {
  const args = {
    command: argv[0] || "check",
    root: process.cwd(),
    limit: 10,
    processor: process.env.EVERY_NEWSLETTER_PROCESSOR || "prompt",
    model: DEFAULT_MODEL,
    url: "",
    title: "",
    dryRun: false,
    retrySkipped: false,
    push: true,
    skipPreflight: false,
  };

  if (args.command === "--help" || args.command === "-h") {
    args.command = "help";
    return args;
  }

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") args.root = path.resolve(argv[++index]);
    else if (arg === "--limit") args.limit = Number.parseInt(argv[++index], 10);
    else if (arg === "--processor") args.processor = argv[++index];
    else if (arg === "--model") args.model = argv[++index];
    else if (arg === "--url") args.url = argv[++index];
    else if (arg === "--title") args.title = argv[++index];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--retry-skipped") args.retrySkipped = true;
    else if (arg === "--no-push") args.push = false;
    else if (arg === "--skip-preflight") args.skipPreflight = true;
    else if (arg === "--help" || arg === "-h") args.command = "help";
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(args.limit) || args.limit < 1) args.limit = 10;
  return args;
}

function printHelp() {
  console.log(`Every Translate pipeline (独立于 every.beyondmotion.net)

Source: https://every.to/newsletter (just for content discovery)

Usage:
  every-translate.mjs check [--limit 10] [--root .]
  every-translate.mjs process [--limit 3] [--processor prompt|deepseek|openai|none]
  every-translate.mjs process --url https://every.to/... [--processor deepseek]
  every-translate.mjs run [--limit 3] [--processor prompt|deepseek|openai|none]
  every-translate.mjs index
  every-translate.mjs preflight

Defaults:
  source: ${NEWSLETTER_URL}
  processor: prompt
  model: ${DEFAULT_MODEL}
`);
}

async function ensureRepoDirs(root) {
  await fs.mkdir(path.join(root, "content", "articles"), { recursive: true });
  await fs.mkdir(path.join(root, "content"), { recursive: true });
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.mkdir(path.join(root, "processing", "pending"), { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

let cachedChromeEveryCookieHeader;

function decryptChromeCookie(encryptedHex, passphrase) {
  const encrypted = Buffer.from(encryptedHex || "", "hex");
  if (encrypted.length < 4 || encrypted.subarray(0, 3).toString("utf8") !== "v10") return "";
  const key = crypto.pbkdf2Sync(passphrase, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  return decrypted.subarray(32).toString("utf8");
}

function readChromeSafeStoragePassphrase() {
  const commandArgs = ["find-generic-password", "-s", "Chrome Safe Storage", "-w", CHROME_KEYCHAIN];
  const result = spawnSync("security", commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function readChromeEveryCookieHeader() {
  if (cachedChromeEveryCookieHeader !== undefined) return cachedChromeEveryCookieHeader;
  if (!CHROME_COOKIE_DB || !CHROME_KEYCHAIN) {
    cachedChromeEveryCookieHeader = "";
    return cachedChromeEveryCookieHeader;
  }

  const query = [
    "select name, value, hex(encrypted_value)",
    "from cookies",
    "where host_key like '%every.to%'",
  ].join(" ");
  const sqlite = spawnSync("sqlite3", [CHROME_COOKIE_DB, "-separator", "\t", query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (sqlite.status !== 0 || !sqlite.stdout.trim()) {
    cachedChromeEveryCookieHeader = "";
    return cachedChromeEveryCookieHeader;
  }

  const passphrase = readChromeSafeStoragePassphrase();
  const cookies = [];
  for (const line of sqlite.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, plainValue = "", encryptedHex = ""] = line.split("\t");
    if (!name) continue;
    let value = plainValue;
    if (!value && encryptedHex && passphrase) {
      try {
        value = decryptChromeCookie(encryptedHex, passphrase);
      } catch {
        value = "";
      }
    }
    if (!value) continue;
    cookies.push(`${name}=${value}`);
  }

  cachedChromeEveryCookieHeader = cookies.join("; ");
  return cachedChromeEveryCookieHeader;
}

function everyRequestHeaders() {
  const headers = {
    accept: "text/html,application/xhtml+xml",
    "accept-language": "en-US,en;q=0.9",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  };

  const cookieHeader = process.env.EVERY_NEWSLETTER_COOKIE_HEADER || readChromeEveryCookieHeader();
  if (cookieHeader) headers.cookie = cookieHeader;
  return headers;
}

function shouldFallbackToCurl(error) {
  const message = String(error?.message || error || "");
  const cause = String(error?.cause?.message || "");
  return /fetch failed/i.test(message) || /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(cause);
}

function curlRequest(url, { method = "GET", headers = {}, body = "", timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const args = ["-sS", "-L", "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))), "-X", method];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null || value === "") continue;
    args.push("-H", `${key}: ${value}`);
  }
  if (body) args.push("--data-binary", body);
  args.push("-w", "\n__CURL_STATUS__:%{http_code}", url);

  const result = spawnSync("curl", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !result.stdout.includes("__CURL_STATUS__:")) {
    throw new Error(result.stderr?.trim() || `curl exited with ${result.status}`);
  }

  const output = result.stdout || "";
  const markerIndex = output.lastIndexOf("\n__CURL_STATUS__:");
  if (markerIndex === -1) {
    throw new Error(result.stderr?.trim() || "curl response missing status marker");
  }

  const text = output.slice(0, markerIndex);
  const status = Number.parseInt(output.slice(markerIndex + "\n__CURL_STATUS__:".length).trim(), 10) || 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: result.stderr?.trim() || "",
    text,
    json() {
      return JSON.parse(text);
    },
  };
}

async function fetchText(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: everyRequestHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (!shouldFallbackToCurl(error)) throw error;
    response = curlRequest(url, {
      headers: everyRequestHeaders(),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  }
  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} ${response.statusText}: ${url}`);
  }
  return typeof response.text === "function" ? response.text() : response.text;
}

function everyMarkdownUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "every.to") return "";
    if (parsed.pathname.endsWith(".md")) return parsed.toString();
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}.md`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n*/u, "");
}

function parseYamlScalar(rawValue = "") {
  const value = rawValue.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
      .join(", ");
  }
  return value.replace(/^["']|["']$/g, "").trim();
}

function markdownToText(markdown) {
  return removeEveryNewsletterBoilerplate(stripFrontmatter(markdown))
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n*/u);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
    if (!item) continue;
    const [, key, rawValue] = item;
    data[key] = parseYamlScalar(rawValue);
  }
  return data;
}

async function fetchEveryMarkdown(url) {
  const markdownUrl = everyMarkdownUrl(url);
  if (!markdownUrl) return null;
  let response;
  const headers = {
    ...everyRequestHeaders(),
    accept: "text/markdown,text/plain;q=0.9,*/*;q=0.8",
  };
  try {
    response = await fetch(markdownUrl, { headers });
  } catch (error) {
    if (!shouldFallbackToCurl(error)) throw error;
    response = curlRequest(markdownUrl, { headers, timeoutMs: FETCH_TIMEOUT_MS });
  }
  if (!response.ok) return null;
  const markdown = typeof response.text === "function" ? await response.text() : response.text;
  const body = stripFrontmatter(markdown).trim();
  if (!body || body.length < 400) return null;
  return {
    url: markdownUrl,
    markdown,
    body,
    frontmatter: parseFrontmatter(markdown),
  };
}

function boolEnv(name) {
  return Boolean((process.env[name] || "").trim());
}

async function probeUrl(url) {
  try {
    const headers = {
      accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
    };
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(8000),
      });
    } catch (error) {
      if (!shouldFallbackToCurl(error)) throw error;
      response = curlRequest(url, { headers, timeoutMs: 8000 });
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: error.message || String(error),
    };
  }
}

async function commandPreflight(args) {
  await ensureRepoDirs(args.root);
  const report = {
    checkedAt: new Date().toISOString(),
    command: args.command,
    processor: args.processor,
    model: args.model,
    env: {
      deepseekApiKey: boolEnv("DEEPSEEK_API_KEY"),
      telegramBotToken: boolEnv("TELEGRAM_BOT_TOKEN"),
      telegramChatId: boolEnv("TELEGRAM_CHAT_ID"),
      cloudflareApiToken: boolEnv("CLOUDFLARE_API_TOKEN"),
      cloudflareAccountId: boolEnv("CLOUDFLARE_ACCOUNT_ID"),
      cloudflarePagesProject: boolEnv("CLOUDFLARE_PAGES_PROJECT_NAME"),
      allProxy: process.env.ALL_PROXY || "",
      httpsProxy: process.env.HTTPS_PROXY || "",
      httpProxy: process.env.HTTP_PROXY || "",
      noProxy: process.env.NO_PROXY || "",
    },
    network: {
      newsletter: await probeUrl(NEWSLETTER_URL),
      everyHome: await probeUrl("https://every.to/"),
      deepseekApi: await probeUrl(DEEPSEEK_BASE_URL),
      productionSite: await probeUrl("https://every.beyondmotion.net/"),
    },
  };

  await writeJson(path.join(args.root, "data", "preflight-results.json"), report);
  console.log(
    `Preflight: deepseek=${report.env.deepseekApiKey ? "yes" : "no"}, telegram=${report.env.telegramBotToken && report.env.telegramChatId ? "yes" : "no"}, cloudflare=${report.env.cloudflareApiToken ? "yes" : "no"}`,
  );
  console.log(
    `Preflight network: newsletter=${report.network.newsletter.status || "ERR"}, deepseek=${report.network.deepseekApi.status || "ERR"}, production=${report.network.productionSite.status || "ERR"}`,
  );
  console.log("Wrote data/preflight-results.json");
  return report;
}

function parseDate(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.valueOf()) ? null : date;
}

function isRecent(dateValue, days = DISCOVERY_WINDOW_DAYS) {
  const date = parseDate(dateValue);
  if (!date) return false;
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  return date.getTime() >= threshold;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function extractAttr(tag, name) {
  const pattern = new RegExp(`${name}=["']([^"']*)["']`, "i");
  return decodeEntities(tag.match(pattern)?.[1] || "").trim();
}

function normalizeAssetUrl(src, base = NEWSLETTER_URL) {
  try {
    return new URL(src, base).toString();
  } catch {
    return "";
  }
}

function extractArticleImages(html) {
  const images = [];
  const seen = new Set();
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = normalizeAssetUrl(extractAttr(tag, "src"));
    if (!src || seen.has(src)) continue;
    const isCover = src.includes("/uploads/post/cover/") && src.includes("full_page_cover");
    const isInline = src.includes("/uploads/editor/posts/");
    const isAd = src.includes("/uploads/editor/advertisements/");
    const isThumbnail = src.includes("/thumbnail_");
    if ((!isCover && !isInline) || isAd || isThumbnail) continue;
    seen.add(src);
    images.push({
      url: src,
      alt: extractAttr(tag, "alt"),
    });
  }
  return images;
}

function extractBalancedDiv(html, startIndex) {
  const openStart = html.lastIndexOf("<div", startIndex);
  if (openStart < 0) return "";

  const tagPattern = /<\/?div\b[^>]*>/gi;
  tagPattern.lastIndex = openStart;
  let depth = 0;
  let match;
  while ((match = tagPattern.exec(html))) {
    if (match[0].startsWith("</")) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(openStart, tagPattern.lastIndex);
  }
  return "";
}

function decodeJsonishAttribute(value) {
  if (!value) return "";
  return decodeEntities(value)
    .replace(/&amp;/g, "&")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/");
}

function extractStructuredArticleBody(html) {
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const raw = decodeEntities(match[1] || "").trim();
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const articleBody = typeof item.articleBody === "string" ? item.articleBody.trim() : "";
      if (!articleBody) continue;
      const type = Array.isArray(item["@type"]) ? item["@type"].join(",") : item["@type"] || "";
      if (!/article|posting/i.test(String(type))) continue;
      return articleBody;
    }
  }
  return "";
}

function tagContentToMarkdown(html) {
  return stripTags(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function imageTagToMarkdown(tag) {
  const src = normalizeAssetUrl(extractAttr(tag, "src"));
  if (!src) return "";
  const alt = extractAttr(tag, "alt") || "Original article image";
  return `\n\n![${alt}](${src})\n\n`;
}

function removeEveryNewsletterBoilerplate(markdown) {
  let output = markdown;

  const startPatterns = [
    /^(?:\*|_)?Was this newsletter forwarded to you\?[\s\S]*?(?:\*|_)?\n+/i,
    /^Hello, and happy Sunday!\s*Was this newsletter forwarded to you\?[\s\S]*?\n+/i,
  ];
  for (const pattern of startPatterns) output = output.replace(pattern, "");

  const footerPatterns = [
    /\n+That[’']s all for this week![\s\S]*$/i,
    /\n+To read more essays like this,[\s\S]*$/i,
    /\n+For sponsorship opportunities,[\s\S]*$/i,
    /\n+We build AI tools for readers like you[\s\S]*$/i,
    /\n+Subscribe\s*\n+\s*What did you think of this post\?[\s\S]*$/i,
    /\n+What did you think of this post\?[\s\S]*$/i,
    /\n+Upgrade to paid[\s\S]*$/i,
  ];
  for (const pattern of footerPatterns) output = output.replace(pattern, "");

  return output
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToPromptMarkdown(html) {
  let markdown = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");

  markdown = markdown.replace(
    /<div\b[^>]*class=["'][^"']*quill-block-image[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    (block) => {
      const dataSource = decodeJsonishAttribute(extractAttr(block, "data-source"));
      const url = dataSource.match(/"url"\s*:\s*"([^"]+)"/)?.[1];
      const caption = dataSource.match(/"caption"\s*:\s*"([^"]*)"/)?.[1] || "";
      if (url) {
        const alt = tagContentToMarkdown(caption) || "Original article image";
        return `\n\n![${alt}](${normalizeAssetUrl(url)})\n\n`;
      }
      const image = block.match(/<img\b[^>]*>/i)?.[0];
      return image ? imageTagToMarkdown(image) : "\n\n";
    },
  );

  const converted = decodeEntities(
    markdown
      .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, content) => `\n\n# ${tagContentToMarkdown(content)}\n\n`)
      .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, content) => `\n\n## ${tagContentToMarkdown(content)}\n\n`)
      .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_, content) => `\n\n### ${tagContentToMarkdown(content)}\n\n`)
      .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, (_, content) => `\n\n#### ${tagContentToMarkdown(content)}\n\n`)
      .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => `\n\n> ${tagContentToMarkdown(content).replace(/\n/g, "\n> ")}\n\n`)
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
        const label = tagContentToMarkdown(content);
        return label ? `[${label}](${decodeEntities(href)})` : "";
      })
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, content) => `**${tagContentToMarkdown(content)}**`)
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, content) => `*${tagContentToMarkdown(content)}*`)
      .replace(/<img\b[^>]*>/gi, (tag) => imageTagToMarkdown(tag))
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => `\n- ${tagContentToMarkdown(content)}`)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article)>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
  return removeEveryNewsletterBoilerplate(converted);
}

function extractMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1]).trim();
  }
  return "";
}

function normalizeUrl(href, base = NEWSLETTER_URL) {
  try {
    const url = new URL(href, base);
    if (url.hostname !== "every.to") return "";
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function isLikelyArticleUrl(url) {
  if (!url) return false;
  const parsed = new URL(url);
  const pathName = parsed.pathname.toLowerCase();
  if (pathName === "/" || pathName === "/newsletter") return false;
  const firstSegment = pathName.split("/").filter(Boolean)[0];
  if (firstSegment?.startsWith("@")) return false;
  if (NON_ARTICLE_SECTIONS.has(firstSegment)) return false;
  if (pathName.includes("/account") || pathName.includes("/login")) return false;
  if (pathName.includes("/about") || pathName.includes("/authors")) return false;
  if (pathName.includes("/privacy") || pathName.includes("/terms")) return false;
  return pathName.split("/").filter(Boolean).length >= 1;
}

function cleanTitle(value) {
  return stripTags(value)
    .replace(/\b([A-Z])\s+([a-z]{2,})/g, (_, letter, rest) =>
      letter === "I" && !/^sn[’']?t\b/.test(rest) ? `${letter} ${rest}` : `${letter}${rest}`,
    )
    .replace(/\bI\s+sn([’']t)\b/g, "Isn$1")
    .replace(/^Every\s*-\s*/i, "")
    .replace(/\s*\|\s*Every.*$/i, "")
    .replace(/\s+-\s+Every.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNewsletterItems(html, limit) {
  const candidates = new Map();
  for (const match of html.matchAll(/<div class="collection-post[\s\S]*?<\/div>\s*<\/div>/gi)) {
    const block = match[0];
    const href = block.match(/<a href="([^"]+)" class="shrink-0">/i)?.[1] || block.match(/<a href="([^"]+)">\s*<h3/i)?.[1] || "";
    const url = normalizeUrl(href);
    if (!isLikelyArticleUrl(url)) continue;
    const titleHtml = block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || "";
    const title = cleanTitle(titleHtml);
    if (!title || title.length < 8 || GENERIC_LINK_TEXT.has(title)) continue;
    const dateText = cleanTitle(block.match(/collection-mobile-hidden mb-2">\s*([\s\S]*?)\s*<\/div>/i)?.[1] || "");
    if (!candidates.has(url)) {
      candidates.set(url, {
        title,
        url,
        date: dateText || new Date().toISOString(),
        source: "newsletter",
      });
    }
  }
  if (candidates.size) {
    return [...candidates.values()].slice(0, limit);
  }

  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html))) {
    const url = normalizeUrl(match[1]);
    if (!isLikelyArticleUrl(url)) continue;
    const title = cleanTitle(match[2]);
    if (title.length < 8 || GENERIC_LINK_TEXT.has(title)) continue;
    if (!candidates.has(url)) {
      candidates.set(url, {
        title,
        url,
        source: "newsletter",
      });
    }
  }

  return [...candidates.values()].slice(0, limit);
}

function parseRssItems(xml, limit) {
  const items = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const title = cleanTitle(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "");
    const link = normalizeUrl(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "");
    const pubDate = decodeEntities(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "");
    if (!title || !link || !isLikelyArticleUrl(link)) continue;
    if (pubDate && !isRecent(pubDate)) continue;
    items.push({
      title,
      url: link,
      source: "rss",
    });
  }
  const deduped = new Map();
  for (const item of items) {
    if (!deduped.has(item.url)) deduped.set(item.url, item);
  }
  return [...deduped.values()].slice(0, limit);
}

function pickHtmlContainer(html) {
  const articleBodyIndex = html.search(/itemprop=["']articleBody["']/i);
  if (articleBodyIndex >= 0) {
    const articleBody = extractBalancedDiv(html, articleBodyIndex);
    if (articleBody) return articleBody;
  }
  const postBodyIndex = html.search(/<div\b[^>]*class=["'][^"']*post-body-content/i);
  if (postBodyIndex >= 0) {
    const postBody = extractBalancedDiv(html, postBodyIndex);
    if (postBody) return postBody;
  }
  const article = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/i);
  if (article?.[0]) return article[0];
  const main = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/i);
  if (main?.[0]) return main[0];
  const body = html.match(/<body\b[^>]*>[\s\S]*?<\/body>/i);
  return body?.[0] || html;
}

function hasPaywallAfterBody(html) {
  const bodyIndex = html.search(/itemprop=["']articleBody["']/i);
  if (bodyIndex < 0) return false;
  const tail = html.slice(bodyIndex, bodyIndex + 30000);
  if (!LOCKED_SIGNALS.some((signal) => tail.includes(signal))) return false;
  return (
    tail.includes("What is included in a subscription?") ||
    tail.includes("paywall-subscribe-button") ||
    tail.includes("Already have an account?") ||
    tail.includes("post_paywall")
  );
}

function hasCompleteNewsletterSignals(html) {
  return NEWSLETTER_COMPLETE_SIGNALS.some((signal) => html.includes(signal));
}

function isLikelyLockedTeaser(article, source = "") {
  if (!article.locked || !article.paywallAfterBody) return false;
  if (source === "newsletter" && article.completeNewsletterSignals) return false;
  if (article.wordCount < 900) return true;
  return !FULL_POST_TAIL_SIGNALS.some((signal) => article.text.includes(signal));
}

function isNewsletterLoggedOutPreview(article, source = "") {
  return source === "newsletter" && article.locked && article.paywallAfterBody && !article.completeNewsletterSignals;
}

function removeBoilerplate(html) {
  return html
    .replace(/<div class="ea-block[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, " ")
    .replace(/<h2\b[^>]*id=["']the-man-underneath-the-layers["'][^>]*>[\s\S]*$/i, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ")
    .replace(/<button\b[\s\S]*?<\/button>/gi, " ");
}

function excerptFrom(text) {
  return text
    .replace(/\s+/g, " ")
    .slice(0, 180)
    .trim();
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "article";
}

function datePrefix(dateValue) {
  const date = dateValue ? new Date(dateValue) : new Date();
  if (Number.isNaN(date.valueOf())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function yamlString(value) {
  if (value === null || value === undefined) return '""';
  return JSON.stringify(String(value));
}

function toFrontmatter(data) {
  const lines = [
    "---",
    `title: ${yamlString(data.title)}`,
    `slug: ${yamlString(data.slug)}`,
    `author: ${yamlString(data.author)}`,
    `date: ${yamlString(data.date)}`,
    `source_url: ${yamlString(data.sourceUrl)}`,
    `status: ${yamlString(data.status)}`,
    `hash: ${yamlString(data.hash)}`,
    `excerpt: ${yamlString(data.excerpt)}`,
    `image: ${yamlString(data.image)}`,
  ];
  if (data.images?.length) {
    lines.push("images:");
    for (const image of data.images) {
      lines.push(`  - url: ${yamlString(image.url)}`);
      lines.push(`    alt: ${yamlString(image.alt || "")}`);
    }
  }
  if (data.factcheck) {
    lines.push(`factcheck: ${yamlString(JSON.stringify(data.factcheck))}`);
  }
  if (data.review) {
    lines.push(`review: ${yamlString(JSON.stringify(data.review))}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function isLocked(html, text) {
  const combined = `${html}\n${text}`;
  return LOCKED_SIGNALS.find((signal) => combined.includes(signal)) || "";
}

async function extractArticle(url, fallbackTitle = "", source = "") {
  const html = await fetchText(url);
  const markdownArticle = source === "newsletter" ? await fetchEveryMarkdown(url) : null;
  const title =
    cleanTitle(markdownArticle?.frontmatter?.title || "") ||
    cleanTitle(extractMeta(html, "og:title")) ||
    cleanTitle(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "") ||
    cleanTitle(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "") ||
    fallbackTitle;
  const author =
    cleanTitle(markdownArticle?.frontmatter?.authors || "") ||
    extractMeta(html, "author") ||
    extractMeta(html, "article:author") ||
    cleanTitle(html.match(/rel=["']author["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] || "") ||
    "Every";
  const date =
    markdownArticle?.frontmatter?.published_at ||
    extractMeta(html, "article:published_time") ||
    html.match(/<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/i)?.[1] ||
    new Date().toISOString();
  const image = extractMeta(html, "og:image");
  const container = removeBoilerplate(pickHtmlContainer(html));
  const structuredArticleBody = extractStructuredArticleBody(html);
  const containerText = stripTags(container);
  const htmlText =
    structuredArticleBody && structuredArticleBody.length > containerText.length ? structuredArticleBody : containerText;
  const markdownText = markdownArticle ? markdownToText(markdownArticle.body) : "";
  const text = markdownText.length > htmlText.length ? markdownText : htmlText;
  const inlineImages = extractArticleImages(container);
  const coverImages = extractArticleImages(html).filter((item) => item.url.includes("/uploads/post/cover/"));
  const images = [...coverImages, ...inlineImages].filter(
    (imageItem, index, list) => list.findIndex((other) => other.url === imageItem.url) === index,
  );
  const lockSignal = isLocked(html, text);
  const paywallAfterBody = hasPaywallAfterBody(html);
  const completeNewsletterSignals = hasCompleteNewsletterSignals(html);
  const hash = sha256(text);

  return {
    url,
    title,
    author,
    date,
    image,
    images,
    text,
    sourceMarkdown: markdownArticle?.body || htmlToPromptMarkdown(container),
    hash,
    excerpt: excerptFrom(text),
    locked: markdownArticle ? false : Boolean(lockSignal),
    lockSignal,
    paywallAfterBody,
    completeNewsletterSignals: completeNewsletterSignals || Boolean(markdownArticle),
    structuredArticleBody: Boolean(structuredArticleBody) || Boolean(markdownArticle),
    wordCount: text.split(/\s+/).filter(Boolean).length,
    usedMarkdownSource: Boolean(markdownArticle),
  };
}

async function readPrompt(name) {
  return fs.readFile(path.join(SKILL_DIR, "references", "prompts", name), "utf8");
}

async function loadGlossary(root) {
  const glossaryPath = path.join(root, "glossary", "glossary.json");
  try {
    const raw = await fs.readFile(glossaryPath, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data?.terms) ? data.terms : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function parseHookJson(text, label) {
  // 容错：从文本中提取第一个完整的 JSON 对象
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object found in ${label} output`);
  try {
    return JSON.parse(match[0]);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} output: ${error.message}`);
  }
}

async function factcheckHook(article, drafts, glossary) {
  const prompt = await readPrompt("factcheck.md");
  const payload = `专有名词库（参考，可用于核对专有名词翻译）：
${JSON.stringify({ terms: glossary }, null, 2)}

原文（${article.title}）：
${article.text}

翻译稿：
${drafts.rewrite}

请按 factcheck prompt 的要求输出 JSON。`;

  try {
    const result = await callDeepSeek({
      model: "deepseek-v4-pro",
      systemPrompt: prompt,
      userPrompt: payload,
    });
    return parseHookJson(result, "factcheck");
  } catch (error) {
    console.warn(`[吴查查] factcheck failed for ${article.title}: ${error.message}`);
    return { passed: true, score: null, issues: [], error: String(error.message || error) };
  }
}

async function reviewHook(article, drafts, factcheck) {
  const prompt = await readPrompt("review.md");
  const payload = `原文（${article.title}）：
${article.text}

翻译稿：
${drafts.rewrite}

事实核查结果：
${JSON.stringify(factcheck, null, 2)}

请按 review prompt 的要求输出 JSON。`;

  try {
    const result = await callDeepSeek({
      model: "deepseek-v4-pro",
      systemPrompt: prompt,
      userPrompt: payload,
    });
    return parseHookJson(result, "review");
  } catch (error) {
    console.warn(`[周审稿] review failed for ${article.title}: ${error.message}`);
    return {
      passed: true,
      score: null,
      dimensions: {},
      mustFix: [],
      nice_to_have: [],
      verdict: "revise",
      error: String(error.message || error),
    };
  }
}

async function extractTermsHook(article, drafts, existingGlossary) {
  const prompt = await readPrompt("extract-terms.md");
  const existingEnglish = new Set((existingGlossary || []).map((t) => t.english.toLowerCase()));
  const payload = `原文（${article.title}）：
${article.text}

翻译稿：
${drafts.rewrite}

已有术语（不要重复）：
${JSON.stringify(existingGlossary || [], null, 2)}`;

  try {
    const result = await callDeepSeek({
      model: "deepseek-v4-pro",
      systemPrompt: prompt,
      userPrompt: payload,
    });
    const parsed = parseHookJson(result, "extract-terms");
    const terms = Array.isArray(parsed?.terms) ? parsed.terms : [];
    // 去重：只保留 glossary 中没有的
    const newTerms = terms.filter(
      (t) => !existingEnglish.has((t.english || "").toLowerCase()),
    );
    return newTerms;
  } catch (error) {
    console.warn(`[术语提取] extractTerms failed for ${article.title}: ${error.message}`);
    return [];
  }
}

async function saveGlossary(root, terms) {
  if (!terms || terms.length === 0) return;
  const glossaryPath = path.join(root, "glossary", "glossary.json");
  let existing = [];
  try {
    const raw = await fs.readFile(glossaryPath, "utf8");
    const data = JSON.parse(raw);
    existing = Array.isArray(data?.terms) ? data.terms : [];
  } catch {
    // 文件不存在或为空，从头开始
  }
  const existingEnglish = new Set(existing.map((t) => (t.english || "").toLowerCase()));
  const toAdd = terms.filter(
    (t) => !existingEnglish.has((t.english || "").toLowerCase()),
  );
  if (toAdd.length === 0) return;
  existing.push(...toAdd);
  await fs.writeFile(
    glossaryPath,
    JSON.stringify({ terms: existing }, null, 2) + "\n",
    "utf8",
  );
  console.log(`[名词库] +${toAdd.length} terms → ${glossaryPath} (total: ${existing.length})`);
}

function articlePromptPayload(article) {
  return `Title: ${article.title}
Author: ${article.author}
Date: ${article.date}
URL: ${article.url}

Images:

${article.images?.length ? article.images.map((image, index) => `${index + 1}. ${image.alt || "Original article image"}\n   ${image.url}`).join("\n") : "No article images found."}

Automation quality standard:

- The expected quality bar is the current published site articles: complete, information-dense, link-aware, clean, and publication-ready.
- Preserve the original article structure and paragraph order unless a paragraph is pure newsletter boilerplate.
- Preserve every meaningful original image in the rewrite at the closest corresponding location. Keep the Markdown image URL unchanged.
- Do not place all images at the top or bottom.
- Do not translate footer widgets, subscription buttons, sponsorship boilerplate, or article feedback controls.
- Prefer the current site publishing style for the rewrite: preserve source links, preserve useful section hierarchy, and avoid over-compressing multi-section newsletters into short summaries.
- The sprout note must stay grounded in the article, but it may extend with carefully chosen external cases, theories, historical context, research, or cross-domain analogies when they clearly sharpen the article's central idea instead of distracting from it.
- If you use an insight sentence, make it traceable to the source article.

Article:

${article.sourceMarkdown || article.text}`;
}

function assertDraftQuality(drafts, article = {}) {
  for (const [name, value] of Object.entries(drafts)) {
    if (!value || value.trim().length < 200) {
      throw new Error(`${name} draft is too short; refusing to write low-quality article`);
    }
  }
  const inlineImages = (article.images || []).filter((image) => image.url.includes("/uploads/editor/posts/"));
  if (inlineImages.length) {
    const missing = inlineImages.filter((image) => !drafts.rewrite.includes(image.url));
    if (missing.length) {
      throw new Error(
        `rewrite draft is missing ${missing.length}/${inlineImages.length} inline image(s): ${missing
          .map((image) => image.url)
          .join(", ")}`,
      );
    }
  }
}

async function callDeepSeek({ systemPrompt, userPrompt, model }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required for --processor deepseek");

  const requestBody = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    stream: false,
  };

  if (process.env.EVERY_NEWSLETTER_REASONING_EFFORT) {
    requestBody.reasoning_effort = process.env.EVERY_NEWSLETTER_REASONING_EFFORT;
  }
  if (process.env.EVERY_NEWSLETTER_THINKING) {
    requestBody.thinking = { type: process.env.EVERY_NEWSLETTER_THINKING };
  }

  const url = `${DEEPSEEK_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  const body = JSON.stringify(requestBody);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (error) {
    if (!shouldFallbackToCurl(error)) throw error;
    response = curlRequest(url, {
      method: "POST",
      headers,
      body,
      timeoutMs: MODEL_TIMEOUT_MS,
    });
  }

  if (!response.ok) {
    const errorText = typeof response.text === "function" ? await response.text() : response.text;
    throw new Error(`DeepSeek request failed ${response.status}: ${errorText}`);
  }

  const json = typeof response.json === "function" ? await response.json() : JSON.parse(response.text);
  const text = json.choices?.[0]?.message?.content?.trim() || "";
  if (!text) throw new Error("DeepSeek response did not include message content");
  return text;
}

async function writePromptPacket(root, article) {
  const rewritePrompt = await readPrompt("rewrite-zh.md");
  const sproutPrompt = await readPrompt("material-sprout.md");
  const slug = `${datePrefix(article.date)}-${slugify(article.title)}`;
  const packetDir = path.join(root, "processing", "pending", slug);
  await fs.mkdir(packetDir, { recursive: true });
  await writeJson(path.join(packetDir, "metadata.json"), {
    title: article.title,
    author: article.author,
    date: article.date,
    sourceUrl: article.url,
    slug,
    hash: article.hash,
    images: article.images || [],
  });
  await fs.writeFile(path.join(packetDir, "source.md"), articlePromptPayload(article));
  await fs.writeFile(
    path.join(packetDir, "rewrite.prompt.md"),
    `${rewritePrompt}\n\n---\n\n${articlePromptPayload(article)}\n`,
  );
  await fs.writeFile(
    path.join(packetDir, "material-sprout.prompt.md"),
    `${sproutPrompt}\n\n---\n\n${articlePromptPayload(article)}\n`,
  );
  return packetDir;
}

async function processWithDeepSeek(article, model, glossary = []) {
  const rewritePrompt = await readPrompt("rewrite-zh.md");
  const sproutPrompt = await readPrompt("material-sprout.md");
  const payload = articlePromptPayload(article);
  console.log(`Generating drafts with DeepSeek: ${article.title}`);
  const [rewrite, sprout] = await Promise.all([
    callDeepSeek({
      model,
      systemPrompt: rewritePrompt,
      userPrompt: payload,
    }),
    callDeepSeek({
      model,
      systemPrompt: sproutPrompt,
      userPrompt: payload,
    }),
  ]);
  const drafts = { rewrite, sprout };
  assertDraftQuality(drafts, article);
  console.log(`Generated drafts with DeepSeek: ${article.title}`);

  // 审核 hook 段
  console.log(`[吴查查] factcheck: ${article.title}`);
  drafts.factcheck = await factcheckHook(article, drafts, glossary);
  console.log(
    `[吴查查] ${drafts.factcheck.passed ? "✅ passed" : "❌ issues found"} score=${drafts.factcheck.score ?? "?"} issues=${drafts.factcheck.issues?.length || 0}`,
  );

  console.log(`[周审稿] review: ${article.title}`);
  drafts.review = await reviewHook(article, drafts, drafts.factcheck);
  console.log(
    `[周审稿] score=${drafts.review.score ?? "?"} verdict=${drafts.review.verdict ?? "?"} mustFix=${drafts.review.mustFix?.length || 0}`,
  );

  // 术语提取 hook
  console.log(`[术语提取] extract terms: ${article.title}`);
  const newTerms = await extractTermsHook(article, drafts, glossary);
  console.log(`[术语提取] found ${newTerms.length} new terms`);
  if (newTerms.length > 0) {
    drafts.newTerms = newTerms;
    console.log(
      `[术语提取] terms: ${newTerms.map((t) => t.english).join(", ")}`,
    );
  }

  return drafts;
}

async function writeArticle(root, article, drafts, status = "pending-review") {
  const slug = `${datePrefix(article.date)}-${slugify(article.title)}`;
  const filePath = path.join(root, "content", "articles", `${slug}.md`);
  const frontmatter = toFrontmatter({
    title: article.title,
    slug,
    author: article.author,
    date: article.date,
    sourceUrl: article.url,
    status,
    hash: article.hash,
    excerpt: article.excerpt,
    image: article.image,
    images: article.images || [],
    factcheck: drafts.factcheck || null,
    review: drafts.review || null,
  });
  const body = `${frontmatter}

<!-- REWRITE_START -->
${drafts.rewrite || "_待生成_"}
<!-- REWRITE_END -->

<!-- SPROUT_START -->
${drafts.sprout || "_待生成_"}
<!-- SPROUT_END -->
  `;
  await fs.writeFile(filePath, body);
  return { filePath, slug };
}

async function discover(limit) {
  const html = await fetchText(NEWSLETTER_URL);
  const items = extractNewsletterItems(html, limit);
  if (items.length === 0) throw new Error("No newsletter items found");
  return { source: "html", items };
}

async function processedUrls(root) {
  const articleDir = path.join(root, "content", "articles");
  const urls = new Set();
  try {
    const entries = await fs.readdir(articleDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const raw = await fs.readFile(path.join(articleDir, entry.name), "utf8");
      const match = raw.match(/^source_url:\s*["']?(.+?)["']?\s*$/m);
      if (match?.[1]) urls.add(match[1].replace(/^["']|["']$/g, ""));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return urls;
}

async function rebuildIndex(root) {
  const script = path.join(root, "scripts", "build-index.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) throw new Error("Failed to rebuild article index");
}

async function recordSkipped(root, article, reason) {
  const skippedPath = path.join(root, "content", "skipped.json");
  const skipped = await readJson(skippedPath, []);
  const next = skipped.filter((item) => item.sourceUrl !== article.url);
  next.push({
    title: article.title,
    sourceUrl: article.url,
    reason,
    signal: article.lockSignal || "",
    checkedAt: new Date().toISOString(),
    hash: article.hash || "",
  });
  await writeJson(skippedPath, next);
}

async function clearSkipped(root, sourceUrl) {
  const skippedPath = path.join(root, "content", "skipped.json");
  const skipped = await readJson(skippedPath, []);
  const next = skipped.filter((item) => item.sourceUrl !== sourceUrl);
  if (next.length !== skipped.length) {
    await writeJson(skippedPath, next);
  }
}

async function commandCheck(args) {
  await ensureRepoDirs(args.root);
  const discovery = await discover(args.limit);
  await writeJson(path.join(args.root, "data", "check-results.json"), {
    source: discovery.source,
    sourceUrl: NEWSLETTER_URL,
    checkedAt: new Date().toISOString(),
    candidateCount: discovery.items.length,
    items: discovery.items,
  });
  console.log(`Discovery source: ${discovery.source}`);
  for (const item of discovery.items) console.log(`${item.title}\n  ${item.url}`);
  console.log(`Wrote data/check-results.json with ${discovery.items.length} item(s)`);
  return discovery;
}

async function commandProcess(args) {
  await ensureRepoDirs(args.root);
  const discovery = args.url
    ? {
        source: "manual",
        items: [{ title: args.title || args.url, url: normalizeUrl(args.url), source: "manual" }],
      }
    : await discover(args.limit);
  const doneUrls = await processedUrls(args.root);
  const skippedPath = path.join(args.root, "content", "skipped.json");
  const skipped = await readJson(skippedPath, []);
  const skippedByUrl = new Map(skipped.map((item) => [item.sourceUrl, item]));
  const results = [];
  const summary = {
    discoverySource: discovery.source,
    candidateCount: discovery.items.length,
    processedCount: 0,
    promptCount: 0,
    capturedCount: 0,
    skippedCount: 0,
    alreadyProcessedCount: 0,
    alreadySkippedCount: 0,
    skippedReasons: {},
  };

  console.log(`Discovery source: ${discovery.source}`);
  console.log(`Candidate articles: ${discovery.items.length}`);

  for (const item of discovery.items) {
    if (doneUrls.has(item.url)) {
      console.log(`Already processed: ${item.title}`);
      results.push({ status: "already_processed", reason: "existing_article", title: item.title, url: item.url });
      summary.alreadyProcessedCount += 1;
      continue;
    }
    const skippedEntry = skippedByUrl.get(item.url);
    if (!args.retrySkipped && skippedEntry) {
      if (item.source === "newsletter" && skippedEntry.reason === "locked_teaser") {
        console.log(`Rechecking newsletter article with prior teaser flag: ${item.title}`);
      } else if (skippedEntry.reason !== "locked") {
        console.log(`Already skipped: ${item.title}`);
        results.push({ status: "already_skipped", reason: "skipped_cache", title: item.title, url: item.url });
        summary.alreadySkippedCount += 1;
        continue;
      }
      console.log(`Rechecking previously locked article: ${item.title}`);
    }

    console.log(`Fetching: ${item.title}`);
    const article = await extractArticle(item.url, item.title, item.source || "");
    if (isNewsletterLoggedOutPreview(article, item.source)) {
      throw new PipelineStageError(
        "content-shape",
        `Newsletter article resolved to a logged-out preview instead of full content: ${article.title}`,
      );
    }
    // Locked pages can still expose a teaser block; keep the guard conservative
    // so we do not publish partial articles as complete rewrites.
    if (article.locked && isLikelyLockedTeaser(article, item.source)) {
      const reason = article.paywallAfterBody ? "locked_teaser" : "locked";
      console.log(`Skipped locked article: ${article.title}`);
      if (!args.dryRun) await recordSkipped(args.root, article, reason);
      results.push({ status: "skipped", reason, title: article.title, url: article.url });
      summary.skippedCount += 1;
      summary.skippedReasons[reason] = (summary.skippedReasons[reason] || 0) + 1;
      continue;
    }
    if (article.locked && article.wordCount < 300) {
      console.log(`Skipped locked article: ${article.title}`);
      if (!args.dryRun) await recordSkipped(args.root, article, "locked");
      results.push({ status: "skipped", reason: "locked", title: article.title, url: article.url });
      summary.skippedCount += 1;
      summary.skippedReasons.locked = (summary.skippedReasons.locked || 0) + 1;
      continue;
    }
    if (article.wordCount < 300) {
      console.log(`Skipped low-content article: ${article.title}`);
      if (!args.dryRun) await recordSkipped(args.root, article, "low_content");
      results.push({ status: "skipped", reason: "low_content", title: article.title, url: article.url });
      summary.skippedCount += 1;
      summary.skippedReasons.low_content = (summary.skippedReasons.low_content || 0) + 1;
      continue;
    }

    if (args.processor === "prompt") {
      const packetDir = await writePromptPacket(args.root, article);
      if (!args.dryRun) await clearSkipped(args.root, article.url);
      console.log(`Prompt packet: ${path.relative(args.root, packetDir)}`);
      results.push({
        status: "prompt",
        title: article.title,
        url: article.url,
        slug: `${datePrefix(article.date)}-${slugify(article.title)}`,
      });
      summary.promptCount += 1;
    } else if (args.processor === "deepseek" || args.processor === "openai") {
      const glossary = await loadGlossary(args.root);
      if (glossary.length) console.log(`Loaded ${glossary.length} glossary terms`);
      const drafts = await processWithDeepSeek(article, args.model, glossary);
      const { filePath, slug } = await writeArticle(args.root, article, drafts, "pending-review");
      // 名词库自动收录
      if (drafts.newTerms && drafts.newTerms.length > 0) {
        await saveGlossary(args.root, drafts.newTerms);
      }
      if (!args.dryRun) await clearSkipped(args.root, article.url);
      console.log(`Article written: ${path.relative(args.root, filePath)}`);
      results.push({ status: "processed", title: article.title, url: article.url, slug });
      summary.processedCount += 1;
    } else if (args.processor === "none") {
      const { filePath, slug } = await writeArticle(
        args.root,
        article,
        {
          rewrite: `<!-- Source text captured for debugging. -->\n\n${article.text}`,
          sprout: "_Not generated. Re-run with --processor prompt or --processor deepseek._",
        },
        "captured",
      );
      if (!args.dryRun) await clearSkipped(args.root, article.url);
      console.log(`Captured article: ${path.relative(args.root, filePath)}`);
      results.push({ status: "captured", title: article.title, url: article.url, slug });
      summary.capturedCount += 1;
    } else {
      throw new Error(`Unsupported processor: ${args.processor}`);
    }
  }

  if (!args.dryRun) await rebuildIndex(args.root);
  const report = {
    checkedAt: new Date().toISOString(),
    processor: args.processor,
    dryRun: args.dryRun,
    ...summary,
    results,
  };
  await writeJson(path.join(args.root, "data", "process-results.json"), report);
  console.log(
    `Summary: source=${report.discoverySource}, candidates=${report.candidateCount}, processed=${report.processedCount}, prompt=${report.promptCount}, captured=${report.capturedCount}, skipped=${report.skippedCount}, already_processed=${report.alreadyProcessedCount}, already_skipped=${report.alreadySkippedCount}`,
  );
  if (report.skippedCount) {
    console.log(`Skip reasons: ${JSON.stringify(report.skippedReasons)}`);
  }
  console.log(`Wrote data/process-results.json`);
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await loadLocalEnv(args.root);
  initFetchProxy();
  if (args.command === "help") {
    printHelp();
    return;
  }
  if (args.command === "preflight") await commandPreflight(args);
  else if (args.command === "check") {
    if (!args.skipPreflight) await commandPreflight(args);
    await commandCheck(args);
  } else if (args.command === "process") {
    if (!args.skipPreflight) await commandPreflight(args);
    await commandProcess(args);
  }
  else if (args.command === "index") await rebuildIndex(args.root);
  else if (args.command === "run") {
    if (!args.skipPreflight) await commandPreflight(args);
    await commandProcess(args);
  } else {
    throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
