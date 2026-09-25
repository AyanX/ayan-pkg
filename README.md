# ayan

Image upload middleware + blur placeholder generator for Express.

## Usage

```js
const { upload, uploadMultiple, generateBlurImage, createUploader, createBlurImage } = require("ayan-pkg");

// Default field name is "image"
app.post("/upload", upload, (req, res) => {
  if (req.ayan.error) {
    return res.status(400).json({ error: req.ayan.error });
  }
  res.json({
    fileUrl: req.ayan.fileUrl, // null when no file was sent
    file: req.ayan.file,
  });
});

// Or pass your own field name
app.post("/profile", upload("avatar"), (req, res) => {
  if (req.ayan.error) return res.status(400).json({ error: req.ayan.error });
  res.json({ fileUrl: req.ayan.fileUrl });
});

// Multiple image upload (default field name is "images", default max is 10)
app.post("/gallery", uploadMultiple(), (req, res) => {
  if (req.ayan.error) return res.status(400).json({ error: req.ayan.error });
  res.json({
    fileUrls: req.ayan.fileUrls, // [] when no files were sent
    files: req.ayan.files,
  });
});

// Or customize field name and max file count
app.post("/photos", upload.array("photos", 5), (req, res) => {
  if (req.ayan.error) return res.status(400).json({ error: req.ayan.error });
  res.json({
    fileUrls: req.ayan.fileUrls,
    files: req.ayan.files,
  });
});

// Generate a tiny blurred placeholder for a remote image
const blurUrl = await generateBlurImage("https://example.com/photo.jpg");
```

For explicit production configuration, use the factories. The pre-configured `upload`, `uploadMultiple`, and `generateBlurImage` exports use these same defaults.

```js
const upload = createUploader({
  uploadDir: "/mnt/images",
  publicBaseUrl: "https://cdn.example.com/assets/",
  publicPath: "/media",
  concurrency: 2, // processing concurrency for batch uploads (default: 2)
  maxFiles: 10,   // max file count for array middleware (default: 10)
});

// Use instance with .array()
app.post("/batch-upload", upload.array("images", 5), (req, res) => {
  if (req.ayan.error) return res.status(400).json({ error: req.ayan.error });
  res.json({ fileUrls: req.ayan.fileUrls });
});

const generateBlurImage = createBlurImage({
  uploadDir: "/mnt/images",
  publicBaseUrl: "https://cdn.example.com/assets/",
  publicPath: "/media",
});
```

Files are saved to `public/uploads/` (relative to the app's working directory) and served from `/uploads/`. Set the `APP_URL` env variable to prefix returned URLs with your origin; without it, relative URLs are returned.

- JPEG, PNG, WebP, and AVIF files are accepted, with a 10MB encoded-size limit, 10,000px per-dimension limit, and 40 million decoded-pixel limit.
- Uploads are decoded and re-encoded with Sharp, auto-oriented, stripped of metadata, and assigned a random canonical extension.
- **Everything is scoped to `req.ayan`**: upload results are only ever attached there, and the raw parsing slots Multer writes are cleaned up before your handler runs.
  - Single uploads: `req.ayan.fileUrl` (`string | null`), `req.ayan.file` (`SavedFile | null`).
  - Batch uploads: `req.ayan.fileUrls` (`string[]`), `req.ayan.files` (`SavedFile[]`).
  - No file sent: `req.ayan.fileUrl` is `null` for single uploads, `req.ayan.fileUrls` is `[]` for batch uploads.
- **Safe Error Handling**: The middleware does not throw. When an error occurs (such as invalid format, size limit exceeded, or MIME type mismatch), the error message is attached directly to `req.ayan.error`, and `next()` continues so route handlers can inspect it. When successful, `req.ayan.error` is `null`.
- Multiple uploads (`uploadMultiple` / `upload.array`) process files with bounded concurrency (`concurrency: 2` by default). If any file fails validation or processing, all files from the batch are rolled back and removed from disk.
- `generateBlurImage` downloads a safe remote image, resizes it to 40px wide, blurs it, and saves it as a content-addressed WebP under `<publicPath>/blur/`. It returns `null` for all failures.

### `SavedFile`

Every entry in `req.ayan.file` / `req.ayan.files` has this shape:

```js
{
  fieldname: "image",          // form field the file arrived in
  originalname: "photo.png",   // client-supplied name
  encoding: "7bit",
  mimetype: "image/png",       // canonical type of the file on disk
  size: 24510,                 // bytes after re-encoding
  filename: "6c9f...cd8e.png", // random name on disk
  destination: "/mnt/images",  // absolute upload directory
  path: "/mnt/images/6c9f...cd8e.png",
}
```

