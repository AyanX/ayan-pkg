const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Root folder of your project
const ROOT_DIR = process.cwd();

// Uploads folder
const uploadDir = path.join(ROOT_DIR, "public/uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Storage config
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  },
});

// File filter (only images)
const fileFilter = (_req, file, cb) => {
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed"), false);
  }
};

const createUpload = (fieldName) => {
  const multerUpload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB size cap
    fileFilter,
  }).single(fieldName);

  // Custom wrapper middleware
  return (req, res, next) => {
    multerUpload(req, res, function (err) {
      if (err) {
        req.fileUrl = null; // In case of error, ensure fileUrl is null
        return next(err); // Pass error to next middleware
      }

      if (!req.file) {
        req.fileUrl = null; // No file uploaded
        return next(); // No file uploaded, continue to next middleware
      }

      // Remove trailing slash if exists
      const baseUrl = (process.env.APP_URL || "").replace(/\/$/, "");

      // Attach full public URL to request
      req.fileUrl = `${baseUrl}/uploads/${req.file.filename}`;

      next();
    });
  };
};

const defaultUpload = createUpload("image");

// Usable both ways:
//   app.post("/route", upload)           -> expects the "image" field (default)
//   app.post("/route", upload("avatar")) -> expects the "avatar" field
function upload(fieldOrReq, res, next) {
  if (typeof fieldOrReq === "string") {
    return createUpload(fieldOrReq);
  }
  // Called without a request object (e.g. `upload()`) -> default middleware
  if (typeof fieldOrReq !== "object" || fieldOrReq === null) {
    return defaultUpload;
  }
  // Called directly as middleware by the framework
  return defaultUpload(fieldOrReq, res, next);
}

module.exports = upload;
