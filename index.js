require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { sendWelcome } = require("./mail");
const { port, allowedFrontendOrigins, backendUrl } = require("./config.js");
const {
  Account, router: authRouter, authenticate, requireAdmin, requireOrganizer,
  bootstrapAdmin, publicAccount, roles, resetAccountPassword, sendAccountWelcome,
} = require("./auth.js");

const app = express();

app.use(cors({ origin: allowedFrontendOrigins }));
app.use(express.json());
app.use("/api/auth", authRouter);
app.use("/api/blogs", require("./blogs"));

function validRetreatDate(value) {
  if (!value) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}

const retreatSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    year: { type: Number, required: true, min: 2000, validate: Number.isInteger },
    startDate: { type: String, default: "", validate: [validRetreatDate, "Start date must be a valid YYYY-MM-DD date"] },
    endDate: { type: String, default: "", validate: [validRetreatDate, "End date must be a valid YYYY-MM-DD date"] },
    venue: { type: String, trim: true, maxlength: 300, default: "" },
    registrationVersion: { type: Number, default: 0, select: false },
  },
  { timestamps: true },
);
retreatSchema.pre("validate", function () {
  if (Boolean(this.startDate) !== Boolean(this.endDate)) {
    this.invalidate("endDate", "Provide both start and end dates");
  } else if (this.startDate && this.endDate < this.startDate) {
    this.invalidate("endDate", "End date cannot be before start date");
  }
});
retreatSchema.index({ name: 1, year: 1 }, { unique: true });

const registrationSchema = new mongoose.Schema(
  {
    retreatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Retreat",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    middleName: { type: String, trim: true, default: "" },
    surname: { type: String, required: true, trim: true },
    role: { type: String, enum: ["visitor"], default: "visitor", required: true },
    mobileNumber: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    center: { type: String, required: true, trim: true },
    centerPayment: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

const Retreat = mongoose.model("Retreat", retreatSchema);
const Registration = mongoose.model("Registration", registrationSchema);

async function sendEmail(response, details) {
  if (!details.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) {
    return response.status(400).json({ error: "Recipient must have a valid saved email address" });
  }
  const emailNotification = await sendWelcome(details);
  return emailResponse(response, emailNotification);
}

function emailResponse(response, emailNotification) {
  if (emailNotification.status === "disabled") {
    return response.status(503).json({ error: "Email sending is disabled", emailNotification });
  }
  if (emailNotification.status === "failed") {
    return response.status(502).json({ error: emailNotification.message, emailNotification });
  }
  if (emailNotification.status === "already_attempted") {
    return response.status(409).json({
      error: "Welcome email already attempted for this role, or account role changed",
      emailNotification,
    });
  }
  return response.json({ emailNotification });
}

app.get("/api/retreats/upcoming", async (_request, response) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const retreats = await Retreat.find({
    startDate: { $regex: "^\\d{4}-\\d{2}-\\d{2}$" },
    endDate: { $gte: today },
  }).select("_id name year startDate endDate venue").sort({ startDate: 1, name: 1 });
  response.set("Cache-Control", "no-store");
  response.json(retreats.map((retreat) => ({
    _id: retreat._id, name: retreat.name, year: retreat.year,
    startDate: retreat.startDate, endDate: retreat.endDate, venue: retreat.venue,
  })));
});

app.get("/", (_request, response) => {
  response.send("Backend is running");
});

app.get("/heath", (_request, response) => {
  response.status(200).json({});
});

app.get("/api/profile", authenticate, (request, response) => {
  response.set("Cache-Control", "no-store");
  response.json(publicAccount(request.account));
});

app.get("/api/accounts", authenticate, requireAdmin, async (_request, response) => {
  const accounts = await Account.find().sort({ createdAt: -1 });
  response.json(accounts.map(publicAccount));
});

app.get("/api/accounts/waiting", authenticate, requireAdmin, async (_request, response) => {
  const accounts = await Account.find({ role: "visitor" }).sort({ createdAt: -1 });
  response.json(accounts.map(publicAccount));
});

app.delete("/api/accounts/waiting/:accountId", authenticate, requireAdmin, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.accountId)) {
    return response.status(400).json({ error: "Invalid account ID" });
  }
  const deleted = await Account.findOneAndDelete({
    _id: request.params.accountId,
    role: "visitor",
  });
  if (!deleted) {
    return response.status(404).json({ error: "Pending signup not found; it may already be approved or deleted" });
  }
  response.status(204).end();
});

app.get("/api/organizers", authenticate, requireAdmin, async (_request, response) => {
  const accounts = await Account.find({ role: "organizer" }).sort({ createdAt: -1 });
  response.json(accounts.map(publicAccount));
});

app.patch("/api/accounts/:accountId/password", authenticate, requireAdmin, resetAccountPassword);

app.post("/api/accounts/:accountId/email", authenticate, requireAdmin, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.accountId)) {
    return response.status(400).json({ error: "Invalid account ID" });
  }
  const account = await Account.findById(request.params.accountId);
  if (!account) {
    return response.status(404).json({ error: "Account not found" });
  }
  return emailResponse(response, await sendAccountWelcome(account));
});

app.patch("/api/accounts/:accountId/role", authenticate, requireAdmin, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.accountId)) {
    return response.status(400).json({ error: "Invalid account ID" });
  }
  const role = request.body?.role;
  if (!roles.includes(role)) {
    return response.status(400).json({ error: "Role must be visitor, organizer or admin" });
  }
  if (String(request.account._id) === request.params.accountId.toLowerCase() && role !== "admin") {
    return response.status(400).json({ error: "You cannot remove your own admin role" });
  }
  const account = await Account.findByIdAndUpdate(
    request.params.accountId,
    { $set: { role } },
    { new: true, runValidators: true },
  );
  if (!account) {
    return response.status(404).json({ error: "Account not found" });
  }
  const emailNotification = role === "organizer" ? await sendAccountWelcome(account) : undefined;
  response.json({ ...publicAccount(account), ...(emailNotification ? { emailNotification } : {}) });
});

app.get("/api/users", authenticate, requireOrganizer, async (_request, response) => {
  const registrations = await Registration.find()
    .populate("retreatId", "name year")
    .sort({ createdAt: -1 });
  response.json(registrations);
});

app.post("/api/users/:userId/email", authenticate, requireOrganizer, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.userId)) {
    return response.status(400).json({ error: "Invalid user ID" });
  }
  const registration = await Registration.findById(request.params.userId);
  if (!registration) {
    return response.status(404).json({ error: "User not found" });
  }
  const retreat = await Retreat.findById(registration.retreatId);
  if (!retreat) {
    return response.status(404).json({ error: "Retreat not found" });
  }
  return sendEmail(response, {
    email: registration.email,
    name: [registration.name, registration.middleName, registration.surname].filter(Boolean).join(" "),
    kind: "registration",
    retreat,
  });
});

app.delete("/api/users/:userId", authenticate, requireAdmin, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.userId)) {
    return response.status(400).json({ error: "Invalid user ID" });
  }

  const registration = await Registration.findByIdAndDelete(request.params.userId);
  if (!registration) {
    return response.status(404).json({ error: "User not found" });
  }

  return response.status(204).end();
});

app.get("/api/retreats", authenticate, requireOrganizer, async (_request, response) => {
  const retreats = await Retreat.find().sort({ year: -1, name: 1 });
  response.json(retreats);
});

app.post("/api/retreats", authenticate, requireAdmin, async (request, response) => {
  const { name, year, startDate, endDate, venue } = request.body || {};
  const retreat = await Retreat.create({
    name,
    year,
    startDate,
    endDate,
    venue,
  });
  response.status(201).json(retreat);
});

app.patch("/api/retreats/:retreatId", authenticate, requireAdmin, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.retreatId)) {
    return response.status(400).json({ error: "Invalid retreat ID" });
  }
  const fields = {
    name: request.body.name, year: request.body.year,
    startDate: request.body.startDate, endDate: request.body.endDate,
    venue: request.body.venue,
  };
  const validated = new Retreat(fields);
  await validated.validate();
  const retreat = await Retreat.findByIdAndUpdate(request.params.retreatId, {
    $set: {
      name: validated.name, year: validated.year, startDate: validated.startDate,
      endDate: validated.endDate, venue: validated.venue,
    },
  }, { new: true });
  if (!retreat) return response.status(404).json({ error: "Retreat not found" });
  response.json(retreat);
});

app.delete("/api/retreats/:retreatId", authenticate, requireAdmin, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.retreatId)) {
    return response.status(400).json({ error: "Invalid retreat ID" });
  }

  const deleted = await mongoose.connection.transaction(async (session) => {
    const retreat = await Retreat.findByIdAndDelete(request.params.retreatId, { session });
    if (!retreat) return false;
    await Registration.deleteMany({ retreatId: retreat._id }, { session });
    return true;
  });
  if (!deleted) {
    return response.status(404).json({ error: "Retreat not found" });
  }
  return response.status(204).end();
});

app.post("/api/retreats/:retreatId/registrations", authenticate, requireOrganizer, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.retreatId)) {
    return response.status(400).json({ error: "Invalid retreat ID" });
  }

  const result = await mongoose.connection.transaction(async (session) => {
    // Writing the parent serializes registration with concurrent retreat deletion.
    const retreat = await Retreat.findByIdAndUpdate(
      request.params.retreatId,
      { $inc: { registrationVersion: 1 } },
      { session, new: true },
    );
    if (!retreat) return null;
    const [created] = await Registration.create([{
      retreatId: retreat._id,
      name: request.body.name,
      middleName: request.body.middleName,
      surname: request.body.surname,
      role: request.body.role,
      mobileNumber: request.body.mobileNumber,
      email: request.body.email || undefined,
      center: request.body.center,
      centerPayment: request.body.centerPayment,
      address: request.body.address,
    }], { session });
    return created;
  });
  if (!result) {
    return response.status(404).json({ error: "Retreat not found" });
  }

  response.status(201).json(result);
});

app.get(
  "/api/retreats/:retreatId/registrations",
  authenticate,
  requireOrganizer,
  async (request, response) => {
    if (!mongoose.isValidObjectId(request.params.retreatId)) {
      return response.status(400).json({ error: "Invalid retreat ID" });
    }

    const registrations = await Registration.find({
      retreatId: request.params.retreatId,
    }).sort({ createdAt: -1 });
    response.json(registrations);
  },
);

app.use((error, _request, response, next) => {
  if (response.headersSent) {
    return next(error);
  }

  if (error.name === "ValidationError" || error.name === "CastError") {
    return response.status(400).json({ error: error.message });
  }

  if (error.code === 11000) {
    return response.status(409).json({
      error: error.keyPattern?.email ? "Email already registered" : "Retreat already exists",
    });
  }

  if (error.type === "entity.parse.failed") {
    return response.status(400).json({ error: "Invalid JSON body" });
  }

  console.error("Request failed:", error);
  return response.status(500).json({ error: "Internal server error" });
});

async function startServer() {
  const mongoUrl = process.env.MONGO_URL;
  if (!mongoUrl) {
    throw new Error("MONGO_URL is required");
  }

  await mongoose.connect(mongoUrl, { dbName: "triratnaAkola" });
  await Account.init();
  await bootstrapAdmin();
  app.listen(port, () => {
    console.log(`Server listening on port ${port}; public backend URL: ${backendUrl}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exitCode = 1;
    mongoose.disconnect().catch((disconnectError) => {
      console.error("Failed to disconnect MongoDB:", disconnectError);
    });
  });
}

module.exports = app;
