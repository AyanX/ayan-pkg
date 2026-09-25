const axios = require("axios");
const crypto = require("crypto");
const dns = require("dns").promises;
const fs = require("fs");
const net = require("net");
const path = require("path");
const sharp = require("sharp");
const { URL } = require("url");
const { createConfig, publicUrl } = require("./config");

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const FORMAT_MIME_TYPES = {
  jpeg: new Set(["image/jpeg", "image/jpg"]),
  png: new Set(["image/png"]),
  webp: new Set(["image/webp"]),
  avif: new Set(["image/avif"]),
};
const ALLOWED_TYPES = new Set(Object.values(FORMAT_MIME_TYPES).flatMap((types) => [...types]));
const FORMATS = new Set(Object.keys(FORMAT_MIME_TYPES));
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const normalized = address.toLowerCase();
  return net.isIPv6(address) && (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:"));
}

function isAllowedImage(metadata, contentType) {
  return metadata.width && metadata.height
    && metadata.width <= 10_000
    && metadata.height <= 10_000
    && metadata.width * metadata.height <= MAX_PIXELS
    && (metadata.pages || 1) === 1
    && FORMATS.has(metadata.format)
    && FORMAT_MIME_TYPES[metadata.format].has(contentType);
}

async function assertSafeUrl(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname || parsed.hostname === "localhost" || parsed.hostname.endsWith(".local")) throw new Error("Unsafe image URL");
  if (net.isIP(parsed.hostname)) {
    if (isPrivateIp(parsed.hostname)) throw new Error("Unsafe image URL");
  } else {
    const addresses = await dns.lookup(parsed.hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw new Error("Unsafe image URL");
  }
  return parsed.toString();
}

async function fetchImage(imageUrl) {
  let current = imageUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    current = await assertSafeUrl(current);
    const response = await axios.get(current, {
      responseType: "arraybuffer",
      timeout: 15_000,
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      maxRedirects: 0,
      validateStatus: () => true,
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirects === 3 || !response.headers.location) throw new Error("Too many redirects");
      current = new URL(response.headers.location, current).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error("Remote image request failed");
    const contentType = String(response.headers["content-type"] || "").split(";", 1)[0].toLowerCase();
    if (!ALLOWED_TYPES.has(contentType) || response.data.byteLength > MAX_BYTES) throw new Error("Remote response is not an allowed image");
    return { buffer: Buffer.from(response.data), contentType };
  }
  throw new Error("Too many redirects");
}

function createBlurImage(options = {}) {
  const config = createConfig(options);
  const inFlight = new Map();
  return async function generateBlurImage(imageUrl) {
    const source = String(imageUrl || "");
    if (inFlight.has(source)) return inFlight.get(source);

    const work = (async () => {
      try {
        const { buffer, contentType } = await fetchImage(source);
        const metadata = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
        if (!isAllowedImage(metadata, contentType)) return null;

        const hash = crypto.createHash("sha256").update(buffer).digest("hex");
        const blurDir = path.join(config.uploadDir, "blur");
        const filename = `blur-${hash}.webp`;
        const finalPath = path.join(blurDir, filename);
        const resultUrl = publicUrl(config, `blur/${filename}`);
        if (fs.existsSync(finalPath)) return resultUrl;

        await fs.promises.mkdir(blurDir, { recursive: true });
        const tempPath = path.join(blurDir, `.${filename}.${crypto.randomBytes(8).toString("hex")}.tmp`);
        try {
          await sharp(buffer, { limitInputPixels: MAX_PIXELS }).resize(40).blur(1).webp({ quality: 50 }).toFile(tempPath);
          await fs.promises.rename(tempPath, finalPath);
          return resultUrl;
        } catch {
          await fs.promises.rm(tempPath, { force: true }).catch(() => {});
          return null;
        }
      } catch {
        return null;
      }
    })();

    inFlight.set(source, work);
    try {
      return await work;
    } finally {
      inFlight.delete(source);
    }
  };
}

const generateBlurImage = createBlurImage();
module.exports = generateBlurImage;
module.exports.createBlurImage = createBlurImage;
