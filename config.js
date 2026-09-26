const crypto = require("crypto");
const path = require("path");
const { URL } = require("url");

const DEFAULT_PUBLIC_PATH = "/uploads";

function normalizePublicPath(value = DEFAULT_PUBLIC_PATH) {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_PUBLIC_PATH;
  const normalized = `/${value.trim().replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? DEFAULT_PUBLIC_PATH : normalized;
}

function normalizeBaseUrl(value = "") {
  if (!value) return "";
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("publicBaseUrl must be an absolute http(s) URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("publicBaseUrl must be an http(s) URL without credentials, query, or fragment");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function createConfig(options = {}) {
  return {
    uploadDir: path.resolve(options.uploadDir || path.join(process.cwd(), "public/uploads")),
    publicBaseUrl: normalizeBaseUrl(options.publicBaseUrl ?? process.env.APP_URL ?? ""),
    publicPath: normalizePublicPath(options.publicPath),
  };
}

function publicUrl(config, suffix) {
  return `${config.publicBaseUrl}${config.publicPath}/${suffix}`;
}

function publicFilePath(config, filename) {
  return `${config.publicPath}/${filename}`;
}

function tempPathFor(dir, filename) {
  return path.join(dir, `.${filename}.${crypto.randomBytes(8).toString("hex")}.tmp`);
}

module.exports = { createConfig, publicUrl, publicFilePath, tempPathFor };
