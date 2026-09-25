const axios = require("axios");
const crypto = require("crypto");
const dns = require("dns").promises;
const fs = require("fs");
const net = require("net");
const path = require("path");
const sharp = require("sharp");
const { URL } = require("url");
const { createConfig, publicUrl, tempPathFor } = require("./config");
const { FORMAT_MIME_TYPES, FORMATS, ALLOWED_MIME_TYPES, MAX_PIXELS, MAX_DIMENSION } = require("./formats");

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function buildPrivateIpBlockList() {
  const blockList = new net.BlockList();
  blockList.addSubnet("0.0.0.0", 8, "ipv4");
  blockList.addSubnet("10.0.0.0", 8, "ipv4");
  blockList.addSubnet("100.64.0.0", 10, "ipv4");
  blockList.addSubnet("127.0.0.0", 8, "ipv4");
  blockList.addSubnet("169.254.0.0", 16, "ipv4");
  blockList.addSubnet("172.16.0.0", 12, "ipv4");
  blockList.addSubnet("192.168.0.0", 16, "ipv4");
  blockList.addSubnet("224.0.0.0", 4, "ipv4");
  blockList.addSubnet("240.0.0.0", 4, "ipv4");
  blockList.addAddress("::", "ipv6");
  blockList.addAddress("::1", "ipv6");
  blockList.addSubnet("fc00::", 7, "ipv6");
  blockList.addSubnet("fe80::", 10, "ipv6");
  blockList.addSubnet("64:ff9b::", 96, "ipv6");
  return blockList;
}

const privateIpBlockList = buildPrivateIpBlockList();

function isPrivateIp(address) {
  if (net.isIPv4(address)) return privateIpBlockList.check(address, "ipv4");
  if (net.isIPv6(address)) return privateIpBlockList.check(address, "ipv6");
  return true;
}

function isAllowedImage(metadata, contentType) {
  return metadata.width && metadata.height
    && metadata.width <= MAX_DIMENSION
    && metadata.height <= MAX_DIMENSION
    && metadata.width * metadata.height <= MAX_PIXELS
    && (metadata.pages || 1) === 1
    && FORMATS.has(metadata.format)
    && FORMAT_MIME_TYPES[metadata.format].has(contentType);
}

function assertSafeUrl(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname || parsed.hostname === "localhost" || parsed.hostname.endsWith(".local")) throw new Error("Unsafe image URL");
  if (net.isIP(parsed.hostname) && isPrivateIp(parsed.hostname)) throw new Error("Unsafe image URL");
  return parsed.toString();
}

function safeDnsLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }).then(
    (addresses) => {
      const requestedFamily = options && options.family ? options.family : 0;
      const match = requestedFamily ? addresses.find(({ family }) => family === requestedFamily) : addresses[0];
      if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address)) || !match) {
        callback(new Error("Unsafe image URL"));
        return;
      }
      callback(null, match.address, match.family);
    },
    (err) => callback(err),
  );
}

async function fetchImage(imageUrl) {
  let current = imageUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    current = assertSafeUrl(current);
    const response = await axios.get(current, {
      responseType: "arraybuffer",
      timeout: 15_000,
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      maxRedirects: 0,
      validateStatus: () => true,
      lookup: safeDnsLookup,
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      if (!response.headers.location) throw new Error("Too many redirects");
      current = new URL(response.headers.location, current).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error("Remote image request failed");
    const contentType = String(response.headers["content-type"] || "").split(";", 1)[0].toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(contentType) || response.data.byteLength > MAX_BYTES) throw new Error("Remote response is not an allowed image");
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
      let tempPath = null;
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
        tempPath = tempPathFor(blurDir, filename);
        await sharp(buffer, { limitInputPixels: MAX_PIXELS }).resize(40).blur(1).webp({ quality: 50 }).toFile(tempPath);
        await fs.promises.rename(tempPath, finalPath);
        return resultUrl;
      } catch {
        if (tempPath) await fs.promises.rm(tempPath, { force: true }).catch(() => {});
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
