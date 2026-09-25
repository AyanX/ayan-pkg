const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const sharp = require("sharp");
const { createConfig, publicUrl } = require("./config");

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_DIMENSION = 10_000;
const MAX_PIXELS = 40_000_000;
const FORMAT_MIME_TYPES = {
  jpeg: new Set(["image/jpeg", "image/jpg"]),
  png: new Set(["image/png"]),
  webp: new Set(["image/webp"]),
  avif: new Set(["image/avif"]),
};
const FORMATS = new Set(Object.keys(FORMAT_MIME_TYPES));
const MIME_TYPES = new Set(Object.values(FORMAT_MIME_TYPES).flatMap((types) => [...types]));

function uploadError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function getMulterErrorCode(error) {
  if (error.code === "LIMIT_UNEXPECTED_FILE") return "UNEXPECTED_FIELD";
  if (error.code === "LIMIT_FILE_SIZE") return "IMAGE_TOO_LARGE";
  return error.code || "INVALID_IMAGE";
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
  const tempPath = path.join(config.uploadDir, `.${filename}.${crypto.randomBytes(8).toString("hex")}.tmp`);
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
      mimetype: `image/${extension === "jpg" ? "jpeg" : extension}`,
    };
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw uploadError("IMAGE_PROCESSING_FAILED", "Image could not be processed", error);
  }
}

function createUploader(options = {}) {
  const config = createConfig(options);
  const storage = multer.memoryStorage();

  function createMiddleware(fieldName = "image") {
    const multerUpload = multer({
      storage,
      limits: { fileSize: options.maxFileSize || MAX_FILE_SIZE, files: 1 },
      fileFilter: (_req, file, cb) => {
        if (!MIME_TYPES.has(String(file.mimetype).toLowerCase())) return cb(uploadError("INVALID_IMAGE", "Unsupported image content type"));
        return cb(null, true);
      },
    }).single(fieldName || "image");

    return (req, res, next) => {
      req.fileUrl = null;
      multerUpload(req, res, async (err) => {
        if (err) {
          return next(uploadError(getMulterErrorCode(err), err.message, err));
        }
        if (!req.file) return next();

        try {
          const original = req.file;
          const saved = await validateAndSave(original, config, options);
          req.file = {
            fieldname: original.fieldname,
            originalname: original.originalname,
            encoding: original.encoding,
            mimetype: saved.mimetype,
            size: saved.size,
            filename: saved.filename,
            destination: config.uploadDir,
            path: saved.path,
          };
          req.fileUrl = publicUrl(config, saved.filename);
          return next();
        } catch (error) {
          req.file = undefined;
          req.fileUrl = null;
          return next(error);
        }
      });
    };
  }

  const defaultMiddleware = createMiddleware("image");
  return function configuredUpload(fieldOrReq, res, next) {
    if (typeof fieldOrReq === "string") return createMiddleware(fieldOrReq);
    if (!fieldOrReq || typeof fieldOrReq !== "object") return defaultMiddleware;
    return defaultMiddleware(fieldOrReq, res, next);
  };
}

const upload = createUploader();

module.exports = upload;
module.exports.createUploader = createUploader;
