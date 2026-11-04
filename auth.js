const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { rateLimit } = require("express-rate-limit");
const { sendWelcome, mailEnabled } = require("./mail");

const roles = ["visitor", "organizer", "admin"];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const accountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      match: emailPattern,
    },
    passwordHash: { type: String, required: true, select: false },
    tokenVersion: { type: Number, default: 0 },
    adminWelcomeEmailAttemptedAt: { type: Date },
    organizerWelcomeEmailAttemptedAt: { type: Date },
    role: { type: String, enum: roles, default: "visitor", required: true },
  },
  { timestamps: true },
);

const Account = mongoose.model("Account", accountSchema);
const dummyPasswordHash = bcrypt.hash("unregistered-account", 12);
const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many authentication attempts; try again later" },
});

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validPassword(value) {
  return typeof value === "string" &&
    value.length >= 8 &&
    Buffer.byteLength(value, "utf8") <= 72;
}

function tokenSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("JWT_SECRET must contain at least 32 bytes");
  }
  return secret;
}

function publicAccount(account) {
  return {
    _id: account._id,
    name: account.name,
    email: account.email,
    role: account.role,
  };
}

async function sendAccountWelcome(account) {
  if (account.role === "visitor") {
    return sendWelcome({ email: account.email, name: account.name, kind: "signup" });
  }
  if (!mailEnabled()) return { status: "disabled" };
  const marker = account.role === "admin"
    ? "adminWelcomeEmailAttemptedAt"
    : "organizerWelcomeEmailAttemptedAt";
  // Claim before SMTP so simultaneous login, approval and manual requests cannot resend.
  const claimed = await Account.findOneAndUpdate(
    { _id: account._id, role: account.role, [marker]: { $exists: false } },
    { $set: { [marker]: new Date() } },
    { new: true },
  );
  if (!claimed) return { status: "already_attempted" };
  const result = await sendWelcome({ email: claimed.email, name: claimed.name, kind: claimed.role });
  if (result.status === "failed") {
    return { ...result, message: "The welcome email could not be sent. This role's one-time attempt has been recorded; no further welcome email will be sent for this role." };
  }
  return result;
}

function loginResponse(account) {
  return {
    token: jwt.sign({ tokenVersion: account.tokenVersion }, tokenSecret(), {
      algorithm: "HS256",
      subject: String(account._id),
      issuer: "triratnaAkola",
      audience: "retreat-api",
      expiresIn: "1h",
    }),
    tokenType: "Bearer",
    expiresIn: 3600,
    account: publicAccount(account),
  };
}

async function authenticate(request, response, next) {
  const match = /^Bearer ([^\s]+)$/i.exec(request.get("authorization") || "");
  if (!match) {
    return response.status(401).json({ error: "Login required" });
  }

  const secret = tokenSecret();
  let payload;
  try {
    payload = jwt.verify(match[1], secret, {
      algorithms: ["HS256"],
      issuer: "triratnaAkola",
      audience: "retreat-api",
    });
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError ||
        error instanceof jwt.TokenExpiredError ||
        error instanceof jwt.NotBeforeError) {
      return response.status(401).json({ error: "Invalid or expired token" });
    }
    throw error;
  }

  if (typeof payload !== "object" || !mongoose.isValidObjectId(payload.sub)) {
    return response.status(401).json({ error: "Invalid or expired token" });
  }

  const account = await Account.findById(payload.sub);
  if (!account || (payload.tokenVersion ?? 0) !== account.tokenVersion) {
    return response.status(401).json({ error: "Invalid or expired token" });
  }

  request.account = account;
  next();
}

function requireAdmin(request, response, next) {
  if (request.account.role !== "admin") {
    return response.status(403).json({ error: "Admin access required" });
  }
  next();
}

function requireOrganizer(request, response, next) {
  if (!["organizer", "admin"].includes(request.account.role)) {
    return response.status(403).json({ error: "Organizer or admin access required" });
  }
  next();
}

async function resetAccountPassword(request, response) {
  if (!mongoose.isValidObjectId(request.params.accountId)) {
    return response.status(400).json({ error: "Invalid account ID" });
  }
  const password = request.body?.password;
  if (!validPassword(password)) {
    return response.status(400).json({
      error: "Password must be at least 8 characters and at most 72 UTF-8 bytes",
    });
  }
  const account = await Account.findByIdAndUpdate(
    request.params.accountId,
    {
      $set: { passwordHash: await bcrypt.hash(password, 12) },
      $inc: { tokenVersion: 1 },
    },
    { new: true, runValidators: true },
  );
  if (!account) {
    return response.status(404).json({ error: "Account not found" });
  }
  return response.status(204).end();
}

router.post("/signup", loginLimiter, async (request, response) => {
  const { name, password, role } = request.body || {};
  const email = normalizeEmail(request.body?.email);
  if (typeof name !== "string" || !name.trim() ||
      !emailPattern.test(email) || !validPassword(password)) {
    return response.status(400).json({
      error: "Name, valid email and password (at least 8 characters, at most 72 UTF-8 bytes) are required",
    });
  }
  if (role !== undefined && role !== "visitor") {
    return response.status(403).json({ error: "Signup can only create visitors" });
  }

  const account = await Account.create({
    name,
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: "visitor",
  });
  const emailNotification = await sendAccountWelcome(account);
  response.status(201).json({ ...loginResponse(account), emailNotification });
});

router.post("/login", loginLimiter, async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  const password = request.body?.password;
  if (!emailPattern.test(email) || !validPassword(password)) {
    return response.status(400).json({ error: "Valid email and password are required" });
  }

  const account = await Account.findOne({ email }).select("+passwordHash");
  // Use the same hash work even when the email is not registered.
  const hash = account
    ? account.passwordHash
    : await dummyPasswordHash;
  const matches = await bcrypt.compare(password, hash);
  if (!account || !matches) {
    return response.status(401).json({ error: "Invalid email or password" });
  }

  const emailNotification = account.role === "admin" ? await sendAccountWelcome(account) : undefined;
  response.json({ ...loginResponse(account), ...(emailNotification ? { emailNotification } : {}) });
});

router.get("/me", authenticate, (request, response) => {
  response.json(publicAccount(request.account));
});

async function bootstrapAdmin() {
  tokenSecret();
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;
  if (!email && !password) {
    if (!await Account.exists({ role: "admin" })) {
      throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD to create the first admin");
    }
    return;
  }
  if (!emailPattern.test(email) || !validPassword(password)) {
    throw new Error("ADMIN_EMAIL must be valid and ADMIN_PASSWORD must be at least 8 characters and at most 72 UTF-8 bytes");
  }

  const existing = await Account.findOne({ email });
  if (existing) {
    if (existing.role !== "admin") {
      throw new Error("ADMIN_EMAIL belongs to a non-admin account; choose a different email");
    }
    return;
  }

  await Account.create({
    name: "Admin",
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: "admin",
  });
}

module.exports = {
  Account,
  router,
  authenticate,
  requireAdmin,
  requireOrganizer,
  resetAccountPassword,
  bootstrapAdmin,
  publicAccount,
  sendAccountWelcome,
  roles,
};
