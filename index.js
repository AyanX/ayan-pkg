const upload = require("./uploader");
const generateBlurImage = require("./blur");

module.exports = {
  upload,
  generateBlurImage,
  createUploader: upload.createUploader,
  createBlurImage: generateBlurImage.createBlurImage,
};
