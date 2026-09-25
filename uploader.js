const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const sharp = require("sharp");
const { createConfig, publicUrl, tempPathFor } = require("./config");
const { FORMAT_MIME_TYPES, FORMATS, ALLOWED_MIME_TYPES, MAX_PIXELS, MAX_DIMENSION } = require("./formats");

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 10;
const DEFAULT_CONCURRENCY = 2;

function uploadError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function getMulterErrorCode(error) {
  if (error.code === "LIMIT_UNEXPECTED_FILE") return "UNEXPECTED_FIELD";
  if (error.code === "LIMIT_FILE_SIZE") return "IMAGE_TOO_LARGE";
  if (error.code === "LIMIT_FILE_COUNT") return "TOO_MANY_FILES";
  return error.code || "INVALID_IMAGE";
}

function filterAllowedMimeType(_req, file, cb) {
  if (ALLOWED_MIME_TYPES.has(String(file.mimetype).toLowerCase())) return cb(null, true);
  return cb(uploadError("INVALID_IMAGE", "Unsupported image content type"));
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        const value = await fn(items[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

const MULTER_SLOT_KEYS = ["file", "files"];

function canInterceptSlot(descriptor) {
  return !descriptor || descriptor.configurable;
}

function captureMulterUpload(req) {
  const captured = { file: undefined, files: undefined, descriptors: {} };

  for (const key of MULTER_SLOT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(req, key);
    captured.descriptors[key] = descriptor;
    if (!canInterceptSlot(descriptor)) continue;
    Object.defineProperty(req, key, {
      configurable: true,
      get: () => captured[key],
      set: (value) => { captured[key] = value; },
    });
  }

  return captured;
}

function releaseMulterUpload(req, captured) {
  for (const key of MULTER_SLOT_KEYS) {
    const descriptor = captured.descriptors[key];
    if (!canInterceptSlot(descriptor)) continue;
    if (descriptor) Object.defineProperty(req, key, descriptor);
    else delete req[key];
  }
}

function initAyan(req, defaults) {
  req.ayan = Object.assign(req.ayan || {}, defaults);
}

function runUpload(req, res, next, multerUpload, processUpload) {
  const captured = captureMulterUpload(req);

  try {
    multerUpload(req, res, (err) => {
      const source = captured.file ?? captured.files;
      releaseMulterUpload(req, captured);

      if (err) {
        req.ayan.error = uploadError(getMulterErrorCode(err), err.message, err).message;
        return next();
      }

      Promise.resolve(source)
        .then(processUpload)
        .catch((error) => { req.ayan.error = error.message; })
        .finally(() => next());
    });
  } catch (error) {
    releaseMulterUpload(req, captured);
    req.ayan.error = error.message;
    next();
  }
}

function buildSavedFile(original, saved, config) {
  return {
    fieldname: original.fieldname,
    originalname: original.originalname,
    encoding: original.encoding,
    mimetype: saved.mimetype,
    size: saved.size,
    filename: saved.filename,
    destination: config.uploadDir,
    path: saved.path,
  };
}

function getOutputSettings(format, options) {
  switch (format) {
    case "jpeg": return { method: "jpeg", options: { quality: options.jpegQuality || 90 } };
    case "png": return { method: "png", options: { compressionLevel: options.pngCompressionLevel ?? 9 } };
    case "webp": return { method: "webp", options: { quality: options.webpQuality || 85 } };
    case "avif": return { method: "avif", options: { quality: options.avifQuality || 50 } };
    default: throw uploadError("INVALID_IMAGE", "Unsupported image format");
  }
}

async function validateAndSave(file, config, options) {
  const maxPixels = options.maxPixels || MAX_PIXELS;
  const maxDimension = options.maxDimension || MAX_DIMENSION;
  let metadata;
  try {
    metadata = await sharp(file.buffer, { limitInputPixels: maxPixels }).metadata();
  } catch (error) {
    throw uploadError("INVALID_IMAGE", "Uploaded file is not a valid image", error);
  }

  const format = metadata.format;
  const mimetype = String(file.mimetype).toLowerCase();
  if (!FORMATS.has(format)) throw uploadError("INVALID_IMAGE", "Unsupported image format");
  if (!FORMAT_MIME_TYPES[format].has(mimetype)) throw uploadError("INVALID_IMAGE", "Image content does not match its declared content type");
  if ((metadata.pages || 1) > 1) throw uploadError("INVALID_IMAGE", "Animated or multi-page images are not supported");
  if (!metadata.width || !metadata.height || metadata.width > maxDimension || metadata.height > maxDimension || metadata.width * metadata.height > maxPixels) {
    throw uploadError("IMAGE_DIMENSIONS_EXCEEDED", "Image dimensions exceed the allowed limit");
  }

  const extension = format === "jpeg" ? "jpg" : format;
  const filename = `${crypto.randomBytes(24).toString("hex")}.${extension}`;
  const finalPath = path.join(config.uploadDir, filename);
  const tempPath = tempPathFor(config.uploadDir, filename);
  const output = getOutputSettings(format, options);
  const pipeline = sharp(file.buffer, { limitInputPixels: maxPixels }).rotate()[output.method](output.options);

  try {
    await fs.promises.mkdir(config.uploadDir, { recursive: true });
    await pipeline.toFile(tempPath);
    await fs.promises.rename(tempPath, finalPath);
    const stat = await fs.promises.stat(finalPath);
    return {
      filename,
      path: finalPath,
      size: stat.size,
      mimetype: `image/${format}`,
    };
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw uploadError("IMAGE_PROCESSING_FAILED", "Image could not be processed", error);
  }
}

function createUploader(options = {}) {
  const config = createConfig(options);
  const storage = multer.memoryStorage();

  function createMulterOptions(maxFiles) {
    return {
      storage,
      limits: { fileSize: options.maxFileSize || MAX_FILE_SIZE, files: maxFiles },
      fileFilter: filterAllowedMimeType,
    };
  }

  function createMiddleware(fieldName = "image") {
    const multerUpload = multer(createMulterOptions(1)).single(fieldName || "image");

    return (req, res, next) => {
      initAyan(req, { error: null, file: null, fileUrl: null });

      runUpload(req, res, next, multerUpload, async (original) => {
        if (!original) return;

        const saved = await validateAndSave(original, config, options);
        req.ayan.file = buildSavedFile(original, saved, config);
        req.ayan.fileUrl = publicUrl(config, saved.filename);
      });
    };
  }

  function createArrayMiddleware(fieldName = "images", maxCount = options.maxFiles || MAX_FILES) {
    const concurrency = Math.max(1, options.concurrency || DEFAULT_CONCURRENCY);
    const multerUpload = multer(createMulterOptions(maxCount)).array(fieldName || "images", maxCount);

    return (req, res, next) => {
      initAyan(req, { error: null, files: [], fileUrls: [] });

      runUpload(req, res, next, multerUpload, async (incoming) => {
        const originals = incoming || [];
        if (!originals.length) return;

        const settled = await mapConcurrent(originals, concurrency, (file) => validateAndSave(file, config, options));
        const failed = settled.find((result) => result.status === "rejected");
        if (failed) {
          await Promise.all(
            settled
              .filter((result) => result.status === "fulfilled")
              .map((result) => fs.promises.rm(result.value.path, { force: true }).catch(() => {})),
          );
          req.ayan.error = failed.reason?.message || "Image processing failed";
          return;
        }

        req.ayan.files = originals.map((original, i) => buildSavedFile(original, settled[i].value, config));
        req.ayan.fileUrls = req.ayan.files.map((file) => publicUrl(config, file.filename));
      });
    };
  }

  const defaultMiddleware = createMiddleware("image");
  const configuredUpload = function configuredUpload(fieldOrReq, res, next) {
    if (typeof fieldOrReq === "string") return createMiddleware(fieldOrReq);
    if (!fieldOrReq || typeof fieldOrReq !== "object") return defaultMiddleware;
    return defaultMiddleware(fieldOrReq, res, next);
  };
  configuredUpload.array = createArrayMiddleware;
  return configuredUpload;
}

const upload = createUploader();

module.exports = upload;
module.exports.createUploader = createUploader;
