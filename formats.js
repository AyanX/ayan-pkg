const FORMAT_MIME_TYPES = {
  jpeg: new Set(["image/jpeg", "image/jpg"]),
  png: new Set(["image/png"]),
  webp: new Set(["image/webp"]),
  avif: new Set(["image/avif"]),
};

const FORMATS = new Set(Object.keys(FORMAT_MIME_TYPES));
const ALLOWED_MIME_TYPES = new Set(Object.values(FORMAT_MIME_TYPES).flatMap((types) => [...types]));
const MAX_PIXELS = 40_000_000;
const MAX_DIMENSION = 10_000;

module.exports = { FORMAT_MIME_TYPES, FORMATS, ALLOWED_MIME_TYPES, MAX_PIXELS, MAX_DIMENSION };
