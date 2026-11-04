const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const sharp = require("sharp");
const sanitizeHtml = require("sanitize-html");
const { authenticate, requireOrganizer } = require("./auth.js");
const { backendUrl } = require("./config.js");

const imageLimit = 5 * 1024 * 1024;
const blogSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    text: { type: String, required: true, trim: true, maxlength: 20000 },
    textFormat: { type: String, enum: ["plain", "html"], default: "plain" },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    image: { type: Buffer, required: true, select: false },
  },
  { timestamps: true },
);
const Blog = mongoose.model("Blog", blogSchema);
const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: imageLimit, files: 1, fields: 3, fieldSize: 80000, parts: 4 },
}).single("image");

function details(blog) {
  return {
    _id: blog._id,
    title: blog.title,
    text: blog.text,
    textFormat: blog.textFormat || "plain",
    authorId: blog.authorId,
    imageUrl: `${backendUrl}/api/blogs/${blog._id}/image`,
    createdAt: blog.createdAt,
    updatedAt: blog.updatedAt,
  };
}

router.param("blogId", (request, response, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return response.status(400).json({ error: "Invalid blog ID" });
  }
  next();
});

router.get("/", async (request, response) => {
  const page = request.query.page === undefined ? "1" : request.query.page;
  const limit = request.query.limit === undefined ? "10" : request.query.limit;
  if (typeof page !== "string" || !/^[1-9]\d*$/.test(page) ||
      typeof limit !== "string" || !/^[1-9]\d*$/.test(limit) ||
      !Number.isSafeInteger(Number(page)) || Number(limit) > 50 ||
      !Number.isSafeInteger((Number(page) - 1) * Number(limit))) {
    return response.status(400).json({ error: "Page must be a positive integer; limit must be 1 to 50" });
  }
  const blogs = await Blog.find().sort({ createdAt: -1, _id: -1 })
    .skip((Number(page) - 1) * Number(limit)).limit(Number(limit));
  response.json(blogs.map(details));
});

router.get("/:blogId/image", async (request, response) => {
  const blog = await Blog.findById(request.params.blogId).select("+image");
  if (!blog) return response.status(404).json({ error: "Blog not found" });
  response.set("X-Content-Type-Options", "nosniff");
  response.type("image/webp").send(blog.image);
});

router.get("/:blogId", async (request, response) => {
  const blog = await Blog.findById(request.params.blogId);
  if (!blog) return response.status(404).json({ error: "Blog not found" });
  response.json(details(blog));
});

async function ownedBlog(request, response, next) {
  const blog = await Blog.findById(request.params.blogId);
  if (!blog) return response.status(404).json({ error: "Blog not found" });
  if (request.account.role !== "admin" &&
      String(blog.authorId) !== String(request.account._id)) {
    return response.status(403).json({ error: "You can only manage your own blogs" });
  }
  request.blog = blog;
  next();
}

function parseUpload(request, response, next) {
  upload(request, response, (error) => {
    if (error instanceof multer.MulterError) {
      return response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
        .json({ error: error.code === "LIMIT_FILE_SIZE" ? "Image must not exceed 5 MB" : error.message });
    }
    if (error) return next(error);
    next();
  });
}

async function saveBlog(request, response) {
  const isNew = !request.blog;
  const updates = {};
  for (const [field, max] of [["title", 200], ["text", 20000]]) {
    const value = request.body?.[field];
    if (value !== undefined || isNew) {
      if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
        return response.status(400).json({ error: `${field} is required and must be at most ${max} characters` });
      }
      updates[field] = value.trim();
    }
  }
  const textFormat = request.body?.textFormat;
  if (textFormat !== undefined && !["plain", "html"].includes(textFormat)) {
    return response.status(400).json({ error: "textFormat must be plain or html" });
  }
  if (textFormat !== undefined && updates.text === undefined) {
    return response.status(400).json({ error: "Provide text when changing textFormat" });
  }
  if (updates.text !== undefined) {
    updates.textFormat = textFormat || request.blog?.textFormat || "plain";
    if (updates.textFormat === "html") {
      updates.text = sanitizeHtml(updates.text, {
        allowedTags: ["p", "br", "strong", "b", "em", "i", "h2", "h3", "ul", "ol", "li", "blockquote"],
        allowedAttributes: { p: ["data-spacing"] },
        transformTags: {
          p: (tagName, attributes) => ({
            tagName,
            attribs: ["compact", "normal", "wide"].includes(attributes["data-spacing"])
              ? { "data-spacing": attributes["data-spacing"] } : {},
          }),
        },
      });
      if (!sanitizeHtml(updates.text, { allowedTags: [], allowedAttributes: {} })
        .replace(/&nbsp;|&#160;/g, " ").trim() || updates.text.length > 20000) {
        return response.status(400).json({ error: "Formatted text must contain readable content and be at most 20000 characters" });
      }
    }
  }
  if (isNew && !request.file) {
    return response.status(400).json({ error: "Image is required" });
  }
  if (!isNew && !request.file && Object.keys(updates).length === 0) {
    return response.status(400).json({ error: "Provide title, text or image to update" });
  }
  if (request.file) {
    try {
      const image = sharp(request.file.buffer, { limitInputPixels: 25000000 });
      const metadata = await image.metadata();
      if (!["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages || 1) > 1) {
        return response.status(400).json({ error: "Only non-animated JPEG, PNG and WebP images are supported" });
      }
      updates.image = await image.rotate().webp().toBuffer();
    } catch (error) {
      return response.status(400).json({ error: "Invalid image or image exceeds the 25 megapixel limit" });
    }
    if (updates.image.length > imageLimit) {
      return response.status(413).json({ error: "Processed image must not exceed 5 MB" });
    }
  }
  let blog;
  if (isNew) {
    blog = await Blog.create({ ...updates, authorId: request.account._id });
  } else {
    blog = await Blog.findOneAndUpdate(
      { _id: request.blog._id, authorId: request.blog.authorId },
      { $set: updates },
      { new: true, runValidators: true },
    );
    if (!blog) return response.status(404).json({ error: "Blog not found" });
  }
  response.status(isNew ? 201 : 200).json(details(blog));
}

router.post("/", authenticate, requireOrganizer, parseUpload, saveBlog);
router.patch("/:blogId", authenticate, requireOrganizer, ownedBlog, parseUpload, saveBlog);
router.delete("/:blogId", authenticate, requireOrganizer, ownedBlog, async (request, response) => {
  const blog = await Blog.findOneAndDelete({
    _id: request.blog._id, authorId: request.blog.authorId,
  });
  if (!blog) return response.status(404).json({ error: "Blog not found" });
  response.status(204).end();
});

module.exports = router;
