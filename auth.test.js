const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

process.env.JWT_SECRET = randomBytes(32).toString("hex");
process.env.PORT = "3000";
process.env.FRONTEND_URL = "https://frontend.example.test";
process.env.BACKEND_URL = "https://backend.example.test";
process.env.MAIL_ENABLED = "false";

const app = require("./index");
const { Account, bootstrapAdmin } = require("./auth");
const Registration = mongoose.model("Registration");
const Retreat = mongoose.model("Retreat");

test("authentication, permissions and existing APIs (mocked MongoDB)", async (t) => {
  const accounts = new Map();
  const registrations = new Map();
  const retreat = {
    _id: new mongoose.Types.ObjectId(), name: "Retreat", year: 2026,
    startDate: "2026-11-03", endDate: "2026-11-07", venue: "Akola Retreat Centre",
  };
  const retreats = new Map([[String(retreat._id), retreat]]);
  const session = {};
  let failCascade = false;
  let failMail = false;
  let transactionActive = false;
  const sentMail = [];
  const mailSettings = ["MAIL_ENABLED", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"];
  const savedMailSettings = Object.fromEntries(mailSettings.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    MAIL_ENABLED: "true", SMTP_HOST: "smtp.example.test", SMTP_PORT: "587",
    SMTP_USER: "mock", SMTP_PASS: "mock-only", MAIL_FROM: "test@example.com",
  });
  t.after(() => {
    for (const key of mailSettings) {
      if (savedMailSettings[key] === undefined) delete process.env[key];
      else process.env[key] = savedMailSettings[key];
    }
  });
  t.mock.method(nodemailer, "createTransport", () => ({
    async sendMail(mail) {
      assert.equal(transactionActive, false);
      assert.ok([...accounts.values(), ...registrations.values()].some((row) => row.email === mail.to));
      sentMail.push(mail);
      if (failMail) throw Object.assign(new Error("Mock SMTP unavailable"), { code: "ETIMEDOUT" });
      return { accepted: [mail.to] };
    },
  }));
  t.mock.method(mongoose.connection, "transaction", async (callback) => {
    const savedRetreats = new Map(retreats);
    const savedRegistrations = new Map(registrations);
    transactionActive = true;
    try {
      return await callback(session);
    } catch (error) {
      retreats.clear();
      registrations.clear();
      for (const [id, row] of savedRetreats) retreats.set(id, row);
      for (const [id, row] of savedRegistrations) registrations.set(id, row);
      throw error;
    } finally {
      transactionActive = false;
    }
  });
  const password = "test-password-2026";
  const oldEmail = process.env.ADMIN_EMAIL;
  const oldPassword = process.env.ADMIN_PASSWORD;
  let createdRetreats = 0;
  let registrationReads = 0;
  let registrationDeletes = 0;

  t.mock.method(Account, "create", async (values) => {
    const account = new Account(values);
    await account.validate();
    if ([...accounts.values()].some((row) => row.email === account.email)) {
      throw Object.assign(new Error("Duplicate email"), {
        code: 11000, keyPattern: { email: 1 },
      });
    }
    accounts.set(String(account._id), account);
    return account;
  });
  t.mock.method(Account, "findById", async (id) => accounts.get(String(id)) || null);
  t.mock.method(Account, "findOneAndDelete", async ({ _id, role }) => {
    const account = accounts.get(String(_id));
    if (!account || account.role !== role) return null;
    accounts.delete(String(_id));
    return account;
  });
  t.mock.method(Account, "findOneAndUpdate", async (filter, update, options) => {
    assert.deepEqual(filter.welcomeEmailAttemptedAt, { $exists: false });
    assert.equal(options.new, true);
    const account = accounts.get(String(filter._id));
    if (!account || account.welcomeEmailAttemptedAt) return null;
    Object.assign(account, update.$set);
    return account;
  });
  t.mock.method(Account, "findOne", ({ email }) => {
    const account = [...accounts.values()].find((row) => row.email === email) || null;
    return {
      then(resolve, reject) { return Promise.resolve(account).then(resolve, reject); },
      select(selection) {
        assert.equal(selection, "+passwordHash");
        return Promise.resolve(account);
      },
    };
  });
  t.mock.method(Account, "exists", async ({ role }) =>
    [...accounts.values()].some((row) => row.role === role));
  t.mock.method(Account, "find", (filter = {}) => ({
    sort() {
      return Promise.resolve([...accounts.values()].filter((row) =>
        !filter.role || row.role === filter.role));
    },
  }));
  t.mock.method(Account, "findByIdAndUpdate", async (id, update, options) => {
    assert.equal(options.runValidators, true);
    const account = accounts.get(id);
    if (!account) return null;
    Object.assign(account, update.$set);
    if (update.$inc?.tokenVersion) {
      account.tokenVersion += update.$inc.tokenVersion;
    }
    await account.validate();
    return account;
  });
  t.mock.method(Retreat, "findByIdAndUpdate", async (id, update, options) => {
    if (!options.session) {
      const row = retreats.get(String(id));
      if (!row) return null;
      Object.assign(row, update.$set);
      return row;
    }
    assert.equal(options.session, session);
    assert.deepEqual(update, { $inc: { registrationVersion: 1 } });
    return retreats.get(String(id)) || null;
  });
  t.mock.method(Retreat, "findByIdAndDelete", async (id, options) => {
    assert.equal(options.session, session);
    const row = retreats.get(String(id));
    retreats.delete(String(id));
    return row || null;
  });
  t.mock.method(Registration, "deleteMany", async (filter, options) => {
    assert.equal(options.session, session);
    for (const [id, row] of registrations) {
      if (String(row.retreatId) === String(filter.retreatId)) registrations.delete(id);
    }
    if (failCascade) throw new Error("Simulated cascade failure");
  });
  t.mock.method(Retreat, "find", () => ({
    sort() { return Promise.resolve([retreat]); },
  }));
  t.mock.method(Retreat, "create", async (body) => {
    await new Retreat(body).validate();
    createdRetreats++;
    return { ...retreat, ...body };
  });
  t.mock.method(Registration, "create", async ([values], options) => {
    assert.equal(options.session, session);
    const registration = new Registration(values);
    await registration.validate();
    registrations.set(String(registration._id), registration);
    return [registration];
  });
  t.mock.method(Registration, "find", () => {
    registrationReads++;
    return {
      populate() { return this; },
      sort() { return Promise.resolve([...registrations.values()]); },
    };
  });
  t.mock.method(Registration, "findByIdAndDelete", async (id) => {
    registrationDeletes++;
    const registration = registrations.get(id);
    registrations.delete(id);
    return registration || null;
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    if (oldEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = oldEmail;
    if (oldPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = oldPassword;
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = "GET", token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function login(email) {
    const response = await request("/api/auth/login", {
      method: "POST", body: { email, password },
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.expiresIn, 3600);
    assert.equal(JSON.stringify(data).includes("passwordHash"), false);
    return data.token;
  }

  await t.test("bootstrap validates secrets and creates only an admin with hashed password", async () => {
    process.env.ADMIN_EMAIL = "";
    process.env.ADMIN_PASSWORD = "";
    await assert.rejects(bootstrapAdmin(), /first admin/);
    const secret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "short";
    await assert.rejects(bootstrapAdmin(), /JWT_SECRET/);
    process.env.JWT_SECRET = secret;
    process.env.ADMIN_EMAIL = " ADMIN@example.com ";
    process.env.ADMIN_PASSWORD = password;
    await bootstrapAdmin();
    const admin = [...accounts.values()][0];
    assert.equal(admin.email, "admin@example.com");
    assert.equal(admin.role, "admin");
    assert.notEqual(admin.passwordHash, password);
    assert.equal(await bcrypt.compare(password, admin.passwordHash), true);
    const hash = admin.passwordHash;
    await bootstrapAdmin();
    assert.equal(accounts.size, 1);
    assert.equal(admin.passwordHash, hash);
  });

  let visitor;
  let visitorToken;
  let adminToken;
  await t.test("signup returns a visitor token and never exposes a password hash", async () => {
    const response = await request("/api/auth/signup", {
      method: "POST",
      body: { name: "Visitor", email: " VISITOR@example.com ", password },
    });
    assert.equal(response.status, 201);
    const data = await response.json();
    visitor = data.account;
    assert.equal(data.emailNotification.status, "sent");
    assert.equal(sentMail.length, 1);
    assert.equal(sentMail[0].to, visitor.email);
    assert.ok(sentMail[0].text.includes("admin approval"));
    visitorToken = data.token;
    assert.equal(visitor.role, "visitor");
    assert.equal(visitor.email, "visitor@example.com");
    assert.equal(JSON.stringify(data).includes("passwordHash"), false);
    assert.equal(await bcrypt.compare(password, accounts.get(visitor._id).passwordHash), true);
    const me = await request("/api/auth/me", { token: visitorToken });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), visitor);
  });

  await t.test("profile returns only the logged-in account and requires a valid token", async () => {
    assert.equal((await request("/api/profile")).status, 401);
    assert.equal((await request("/api/profile", { token: "invalid-token" })).status, 401);
    const response = await request("/api/profile?accountId=690000000000000000000010", {
      token: visitorToken,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), visitor);
  });

  await t.test("signup rejects elevated roles, duplicates, malformed input and weak passwords", async () => {
    for (const role of ["admin", "organizer"]) {
      const response = await request("/api/auth/signup", {
        method: "POST", body: { name: "Other", email: "other@example.com", password, role },
      });
      assert.equal(response.status, 403);
    }
    const duplicate = await request("/api/auth/signup", {
      method: "POST", body: { name: "Other", email: visitor.email, password },
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, "Email already registered");
    for (const body of [
      {},
      { name: "Other", email: "not-an-email", password },
      { name: "Other", email: "other@example.com", password: "short" },
      { name: "Other", email: "other@example.com", password: "x".repeat(73) },
    ]) {
      const response = await request("/api/auth/signup", { method: "POST", body });
      assert.equal(response.status, 400);
    }
    assert.equal(accounts.size, 2);
  });

  await t.test("login handles correct, wrong and unknown credentials", async () => {
    adminToken = await login("admin@example.com");
    assert.equal(sentMail.filter((mail) => mail.to === "admin@example.com").length, 1);
    for (const body of [
      { email: visitor.email, password: "wrong-password-2026" },
      { email: "unknown@example.com", password },
    ]) {
      const response = await request("/api/auth/login", { method: "POST", body });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, "Invalid email or password");
    }
    process.env.ADMIN_EMAIL = visitor.email;
    await assert.rejects(bootstrapAdmin(), /non-admin/);
  });

  await t.test("concurrent later admin logins do not repeat the welcome email", async () => {
    const before = sentMail.length;
    await Promise.all([login("admin@example.com"), login("admin@example.com")]);
    assert.equal(sentMail.length, before);
    const admin = [...accounts.values()].find((row) => row.role === "admin");
    assert.ok(admin.welcomeEmailAttemptedAt instanceof Date);
  });

  const protectedRoutes = [
    ["/api/retreats", "GET"],
    [`/api/retreats/${retreat._id}/registrations`, "POST"],
    ["/api/users", "GET"],
    ["/api/users/690000000000000000000002", "DELETE"],
    ["/api/retreats", "POST"],
    [`/api/retreats/${retreat._id}`, "PATCH"],
    [`/api/retreats/${retreat._id}`, "DELETE"],
    [`/api/retreats/${retreat._id}/registrations`, "GET"],
    ["/api/accounts", "GET"],
    ["/api/accounts/waiting", "GET"],
    ["/api/organizers", "GET"],
    [`/api/accounts/${visitor?._id}/role`, "PATCH"],
    [`/api/accounts/${visitor?._id}/password`, "PATCH"],
  ];
  await t.test("protected APIs reject anonymous and visitor access before querying registrations", async () => {
    for (const [path, method] of protectedRoutes) {
      assert.equal((await request(path, { method })).status, 401);
      assert.equal((await request(path, { method, token: visitorToken, body: method === "GET" ? undefined : {} })).status, 403);
    }
    assert.equal(registrationReads, 0);
    assert.equal(registrationDeletes, 0);
    assert.equal(createdRetreats, 0);
  });

  await t.test("tampered, expired and deleted-account tokens are rejected", async () => {
    const claims = {
      issuer: "triratnaAkola", audience: "retreat-api", subject: visitor._id,
    };
    const tokens = [
      visitorToken + "tampered",
      jwt.sign({}, process.env.JWT_SECRET, { ...claims, expiresIn: -1 }),
      jwt.sign({}, process.env.JWT_SECRET, {
        ...claims, subject: String(new mongoose.Types.ObjectId()), expiresIn: "1h",
      }),
    ];
    for (const token of tokens) {
      assert.equal((await request("/api/users", { token })).status, 401);
    }
  });

  await t.test("new visitors can log in but stay in the admin waiting list without gaining access", async () => {
    const token = await login(visitor.email);
    const me = await request("/api/auth/me", { token });
    assert.equal((await me.json()).role, "visitor");
    const waiting = await request("/api/accounts/waiting", { token: adminToken });
    assert.equal(waiting.status, 200);
    assert.deepEqual(await waiting.json(), [visitor]);
    assert.equal((await request("/api/retreats", { token })).status, 403);
    assert.equal((await request("/api/users", { token })).status, 403);
    assert.equal(accounts.size, 2);
  });

  let participantId;
  await t.test("registration stays saved on mail failure and cannot assign account privileges", async (t) => {
    const fields = {
      name: "Sample", middleName: " Middle ", surname: "Participant",
      mobileNumber: "9000000000", center: "Akola", centerPayment: "500", address: "Akola",
      email: "participant@example.com",
    };
    const path = `/api/retreats/${retreat._id}/registrations`;
    failMail = true;
    t.mock.method(console, "error", () => {});
    const response = await request(path, { method: "POST", token: adminToken, body: fields });
    failMail = false;
    assert.equal(response.status, 201);
    const data = await response.json();
    participantId = data._id;
    assert.equal(data.emailNotification.status, "failed");
    assert.ok(registrations.has(participantId));
    assert.equal(sentMail.at(-1).to, fields.email);
    assert.ok(sentMail.at(-1).text.includes("Sample Middle Participant"));
    assert.ok(sentMail.at(-1).text.includes("Retreat: Retreat"));
    assert.ok(sentMail.at(-1).text.includes("3 November 2026"));
    assert.ok(sentMail.at(-1).text.includes("7 November 2026"));
    assert.ok(sentMail.at(-1).text.includes("Akola Retreat Centre"));
    const success = await request(path, { method: "POST", token: adminToken, body: fields });
    const successData = await success.json();
    assert.equal(success.status, 201);
    assert.equal(successData.emailNotification.status, "sent");
    registrations.delete(successData._id);
    const count = sentMail.length;
    const noEmail = await request(path, { method: "POST", token: adminToken, body: { ...fields, email: "" } });
    const noEmailData = await noEmail.json();
    assert.equal(noEmail.status, 201);
    assert.equal(noEmailData.emailNotification.status, "skipped");
    assert.equal(sentMail.length, count);
    registrations.delete(noEmailData._id);
    assert.equal(data.role, "visitor");
    assert.equal(data.middleName, "Middle");
    const elevated = await request(path, { method: "POST", token: adminToken, body: { ...fields, role: "admin" } });
    assert.equal(elevated.status, 400);
    assert.equal(accounts.size, 2);
  });

  await t.test("admins can save retreat dates and venue; invalid dates and other roles are rejected", async () => {
    const path = `/api/retreats/${retreat._id}`;
    const fields = {
      name: retreat.name, year: retreat.year, startDate: "2026-11-03",
      endDate: "2026-11-07", venue: "Akola Retreat Centre",
    };
    assert.equal((await request(path, { method: "PATCH", body: fields })).status, 401);
    assert.equal((await request(path, { method: "PATCH", token: visitorToken, body: fields })).status, 403);
    for (const invalid of [
      { startDate: "2026-02-30" }, { endDate: "2026-11-01" },
      { startDate: "" }, { venue: "a".repeat(301) },
    ]) {
      assert.equal((await request(path, { method: "PATCH", token: adminToken, body: { ...fields, ...invalid } })).status, 400);
    }
    const saved = await request(path, { method: "PATCH", token: adminToken, body: fields });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).venue, fields.venue);
    assert.equal((await request(`/api/retreats/${new mongoose.Types.ObjectId()}`, {
      method: "PATCH", token: adminToken, body: fields,
    })).status, 404);
  });

  await t.test("admin can list, create retreats and manage organizer roles; live roles override old tokens", async () => {
    for (const path of ["/api/users", `/api/retreats/${retreat._id}/registrations`]) {
      const response = await request(path, { token: adminToken });
      assert.equal(response.status, 200);
      assert.equal((await response.json())[0]._id, participantId);
    }
    const created = await request("/api/retreats", {
      method: "POST", token: adminToken, body: { name: "Winter", year: 2027 },
    });
    assert.equal(created.status, 201);
    assert.equal(createdRetreats, 1);
    const path = `/api/accounts/${visitor._id}/role`;
    for (const role of ["organizer", "admin", "visitor"]) {
      const changed = await request(path, { method: "PATCH", token: adminToken, body: { role } });
      assert.equal(changed.status, 200);
      assert.equal((await changed.json()).role, role);
      const profile = await request("/api/profile", { token: visitorToken });
      assert.equal(profile.status, 200);
      assert.deepEqual(await profile.json(), { ...visitor, role });
      const protectedResponse = await request("/api/users", { token: visitorToken });
      assert.equal(protectedResponse.status, role === "visitor" ? 403 : 200);
      for (const listPath of ["/api/retreats", `/api/retreats/${retreat._id}/registrations`]) {
        assert.equal((await request(listPath, { token: visitorToken })).status, role === "visitor" ? 403 : 200);
      }
      if (role === "organizer") {
        for (const [adminPath, method] of [
          ["/api/accounts", "GET"],
          ["/api/accounts/waiting", "GET"],
          ["/api/organizers", "GET"],
          [path, "PATCH"],
          [`/api/accounts/${visitor._id}/password`, "PATCH"],
          ["/api/retreats", "POST"],
          [`/api/retreats/${retreat._id}`, "DELETE"],
          [`/api/users/${participantId}`, "DELETE"],
        ]) {
          assert.equal((await request(adminPath, {
            method, token: visitorToken, body: method === "GET" ? undefined : { role: "admin" },
          })).status, 403);
        }
        const registration = await request(`/api/retreats/${retreat._id}/registrations`, {
          method: "POST", token: visitorToken,
          body: {
            name: "Organizer entry", surname: "Participant", mobileNumber: "9000000000",
            center: "Akola", centerPayment: "500", address: "Akola",
          },
        });
        assert.equal(registration.status, 201);
        const createdRegistration = await registration.json();
        assert.equal(createdRegistration.role, "visitor");
        const deleted = await request(`/api/users/${createdRegistration._id}`, {
          method: "DELETE", token: adminToken,
        });
        assert.equal(deleted.status, 204);
      }
      const organizers = await request("/api/organizers", { token: adminToken });
      assert.equal((await organizers.json()).length, role === "organizer" ? 1 : 0);
      const waiting = await request("/api/accounts/waiting", { token: adminToken });
      assert.equal(waiting.status, 200);
      const waitingAccounts = await waiting.json();
      assert.equal(waitingAccounts.length, role === "visitor" ? 1 : 0);
      if (role === "visitor") assert.equal(waitingAccounts[0]._id, visitor._id);
    }
    const admin = [...accounts.values()].find((row) => row.role === "admin");
    const self = await request(`/api/accounts/${admin._id}/role`, {
      method: "PATCH", token: adminToken, body: { role: "visitor" },
    });
    assert.equal(self.status, 400);
    const invalid = await request(path, { method: "PATCH", token: adminToken, body: { role: "owner" } });
    assert.equal(invalid.status, 400);
    const all = await request("/api/accounts", { token: adminToken });
    assert.equal(all.status, 200);
    assert.equal(JSON.stringify(await all.json()).includes("passwordHash"), false);
  });

  await t.test("admin deletion removes only a registration, not its account", async () => {
    const response = await request(`/api/users/${participantId}`, { method: "DELETE", token: adminToken });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(accounts.size, 2);
    assert.equal(registrations.size, 0);
    assert.equal((await request(`/api/users/${participantId}`, { method: "DELETE", token: adminToken })).status, 404);
  });

  await t.test("retreat deletion cascades atomically and leaves unrelated records and accounts intact", async () => {
    const other = { _id: new mongoose.Types.ObjectId(), name: "Other", year: 2027 };
    retreats.set(String(other._id), other);
    const targetRegistration = { _id: "target", retreatId: retreat._id };
    const otherRegistration = { _id: "other", retreatId: other._id };
    registrations.set("target", targetRegistration);
    registrations.set("other", otherRegistration);
    const path = `/api/retreats/${retreat._id}`;
    assert.equal((await request("/api/retreats/invalid", { method: "DELETE", token: adminToken })).status, 400);
    failCascade = true;
    const log = t.mock.method(console, "error", () => {});
    try {
      const failed = await request(path, { method: "DELETE", token: adminToken });
      assert.equal(failed.status, 500);
      assert.equal(retreats.has(String(retreat._id)), true);
      assert.equal(registrations.has("target"), true);
      assert.equal(log.mock.callCount(), 1);
    } finally {
      failCascade = false;
      log.mock.restore();
    }
    const deleted = await request(path, { method: "DELETE", token: adminToken });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), "");
    assert.equal(retreats.has(String(retreat._id)), false);
    assert.equal(registrations.has("target"), false);
    assert.equal(retreats.has(String(other._id)), true);
    assert.equal(registrations.has("other"), true);
    assert.equal(accounts.size, 2);
    assert.equal((await request(path, { method: "DELETE", token: adminToken })).status, 404);
    const registration = await request(path + "/registrations", {
      method: "POST", token: adminToken, body: {},
    });
    assert.equal(registration.status, 404);
    assert.equal(registrations.size, 1);
  });

  await t.test("public health, protected retreat listing and Authorization preflight work", async () => {
    const health = await request("/heath");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {});
    assert.equal((await request("/api/retreats")).status, 401);
    assert.equal((await request("/api/retreats", { token: adminToken })).status, 200);
    const preflight = await fetch(base + `/api/accounts/${visitor._id}/role`, {
      method: "OPTIONS",
      headers: {
        Origin: process.env.FRONTEND_URL,
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), process.env.FRONTEND_URL);
    assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/);
  });

  await t.test("only admins reset passwords, old credentials and tokens stop working", async () => {
    const path = `/api/accounts/${visitor._id}/password`;
    const oldHash = accounts.get(visitor._id).passwordHash;
    for (const password of [undefined, null, "", "short", "x".repeat(73), 123456789012]) {
      const response = await request(path, { method: "PATCH", token: adminToken, body: { password } });
      assert.equal(response.status, 400);
    }
    assert.equal(accounts.get(visitor._id).passwordHash, oldHash);
    assert.equal((await request("/api/accounts/invalid/password", {
      method: "PATCH", token: adminToken, body: { password },
    })).status, 400);
    assert.equal((await request(`/api/accounts/${new mongoose.Types.ObjectId()}/password`, {
      method: "PATCH", token: adminToken, body: { password },
    })).status, 404);
    const newPassword = "short123";
    const reset = await request(path, {
      method: "PATCH", token: adminToken, body: { password: newPassword, role: "admin" },
    });
    assert.equal(reset.status, 204);
    assert.equal(await reset.text(), "");
    const account = accounts.get(visitor._id);
    assert.equal(account.role, "visitor");
    assert.notEqual(account.passwordHash, newPassword);
    assert.equal(await bcrypt.compare(newPassword, account.passwordHash), true);
    assert.equal((await request("/api/auth/me", { token: visitorToken })).status, 401);
    const oldLogin = await request("/api/auth/login", {
      method: "POST", body: { email: visitor.email, password },
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await request("/api/auth/login", {
      method: "POST", body: { email: visitor.email, password: newPassword },
    });
    assert.equal(newLogin.status, 200);
    const data = await newLogin.json();
    assert.equal(JSON.stringify(data).includes("passwordHash"), false);
    assert.equal((await request("/api/auth/me", { token: data.token })).status, 200);
    assert.equal((await request("/api/accounts", { token: adminToken })).status, 200);
  });

  await t.test("authentication attempts are rate limited with JSON errors", async () => {
    let response;
    for (let attempt = 0; attempt < 21; attempt++) {
      response = await request("/api/auth/login", { method: "POST", body: {} });
      if (response.status === 429) break;
    }
    assert.equal(response.status, 429);
    assert.match((await response.json()).error, /Too many/);
  });

  await t.test("only admins delete pending signup accounts, invalidating tokens without deleting participants", async () => {
    const pending = await Account.create({
      name: "Pending Signup", email: "pending@example.test",
      passwordHash: "test-only-hash", role: "visitor",
    });
    const path = `/api/accounts/waiting/${pending._id}`;
    const pendingToken = jwt.sign({ tokenVersion: pending.tokenVersion }, process.env.JWT_SECRET, {
      algorithm: "HS256", subject: String(pending._id), issuer: "triratnaAkola",
      audience: "retreat-api", expiresIn: "1h",
    });
    const participantCount = registrations.size;
    assert.equal((await request(path, { method: "DELETE" })).status, 401);
    assert.equal((await request(path, { method: "DELETE", token: pendingToken })).status, 403);
    const originalRole = accounts.get(visitor._id).role;
    accounts.get(visitor._id).role = "organizer";
    const organizerToken = jwt.sign({ tokenVersion: accounts.get(visitor._id).tokenVersion }, process.env.JWT_SECRET, {
      subject: visitor._id, issuer: "triratnaAkola", audience: "retreat-api", expiresIn: "1h",
    });
    assert.equal((await request(path, { method: "DELETE", token: organizerToken })).status, 403);
    assert.equal((await request(`/api/accounts/waiting/${visitor._id}`, { method: "DELETE", token: adminToken })).status, 404);
    accounts.get(visitor._id).role = originalRole;
    const admin = [...accounts.values()].find((row) => row.role === "admin");
    assert.equal((await request(`/api/accounts/waiting/${admin._id}`, { method: "DELETE", token: adminToken })).status, 404);
    assert.equal((await request("/api/accounts/waiting/invalid", { method: "DELETE", token: adminToken })).status, 400);
    assert.equal((await request(`/api/accounts/waiting/${new mongoose.Types.ObjectId()}`, { method: "DELETE", token: adminToken })).status, 404);
    const deleted = await request(path, { method: "DELETE", token: adminToken });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), "");
    assert.equal(accounts.has(String(pending._id)), false);
    assert.equal((await request("/api/profile", { token: pendingToken })).status, 401);
    assert.equal(registrations.size, participantCount);
    assert.equal((await request(path, { method: "DELETE", token: adminToken })).status, 404);
    const waiting = await request("/api/accounts/waiting", { token: adminToken });
    assert.ok(!(await waiting.json()).some((row) => row._id === String(pending._id)));
  });
});
