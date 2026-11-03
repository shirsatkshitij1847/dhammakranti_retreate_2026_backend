const test = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");
const { createMessage, sendWelcome } = require("./mail");

test("welcome mail templates and delivery use local embedded images, safely", async (t) => {
  const message = createMessage({ name: '<img src=x onerror="bad">', kind: "signup" });
  assert.ok(message.html.includes("&lt;img"));
  assert.ok(!message.html.includes('<img src=x'));
  assert.ok(message.html.includes("admin approval"));
  assert.ok(message.html.includes("https://www.youtube.com/@triratnayouthakola7304"));
  assert.ok(message.html.includes('href="https://dhammakranti.triratnaakolayouth.com"'));
  assert.ok(message.html.includes("Stay connected with Dhammakranti"));
  assert.ok(message.text.includes("https://dhammakranti.triratnaakolayouth.com"));
  assert.ok(message.html.includes("cid:triratna-buddha"));
  assert.ok(message.html.includes('background="cid:triratna-stupa"'));
  assert.ok(message.html.includes("max-width:720px;background:#11251b"));
  assert.ok(message.html.includes('class="email-column email-art"'));
  assert.ok(message.html.includes('class="email-column email-copy"'));
  assert.ok(message.html.includes('width="240" alt="Buddha"'));
  assert.ok(message.html.includes("font-family:Georgia,'Times New Roman',serif;font-size:32px"));
  assert.ok(message.html.includes(".email-art img{margin:0 auto!important;width:260px!important;max-width:100%!important}"));
  assert.ok(message.html.includes("rgba(7,22,14,0.90)"));
  assert.ok(message.html.includes("With warm wishes,"));
  assert.ok(message.text.includes("Copyright"));
  assert.ok(createMessage({ name: "Test", kind: "registration" }).text.includes("registering"));
  assert.ok(createMessage({ name: "Admin", kind: "admin" }).text.includes("administrator"));
  const organizerMessage = createMessage({ name: "Organizer", kind: "organizer" });
  assert.ok(organizerMessage.text.includes("organization team"));
  assert.ok(organizerMessage.html.includes("Your account is approved"));
  assert.ok(!organizerMessage.text.includes("sent for admin approval"));
  const retreatMessage = createMessage({
    name: "Participant", kind: "registration",
    retreat: { name: "Peace & <Friendship>", year: 2026, startDate: "2026-11-03", endDate: "2026-11-07", venue: 'Akola <Hall> & Centre' },
  });
  assert.ok(retreatMessage.html.includes("Peace &amp; &lt;Friendship&gt;"));
  assert.ok(retreatMessage.html.includes("Akola &lt;Hall&gt; &amp; Centre"));
  assert.ok(retreatMessage.text.includes("3 November 2026"));
  assert.ok(retreatMessage.text.includes("7 November 2026"));
  assert.ok(retreatMessage.text.includes("Your presence will bring warmth"));
  assert.ok(!message.html.includes("Your retreat details"));
  assert.ok(createMessage({ name: "Participant", kind: "registration" }).text.includes("To be confirmed by the organizer"));

  const saved = { ...process.env };
  t.after(() => {
    for (const key of ["MAIL_ENABLED", "EMAIL", "APP_PASS", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.MAIL_ENABLED = "false";
  assert.equal((await sendWelcome({ email: "test@example.com", name: "Test" })).status, "disabled");
  process.env.MAIL_ENABLED = "true";
  Object.assign(process.env, {
    SMTP_HOST: "smtp.example.test", SMTP_PORT: "587", SMTP_USER: "test",
    SMTP_PASS: "mock-password", MAIL_FROM: "test@example.com",
  });
  let captured;
  t.mock.method(nodemailer, "createTransport", (options) => {
    assert.equal(options.requireTLS, true);
    return { async sendMail(mail) { captured = mail; return { accepted: ["test@example.com"] }; } };
  });
  assert.equal((await sendWelcome({ email: "test@example.com", name: "Test", kind: "signup" })).status, "sent");
  assert.equal(captured.attachments.length, 3);
  assert.equal(captured.attachments[1].filename, "buddha-blended.png");
  assert.ok(captured.attachments.every((file) => require("node:fs").existsSync(file.path)));
  const artwork = await require("sharp")(captured.attachments[1].path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(artwork.info.width, 600);
  assert.equal(artwork.info.height, 800);
  const alpha = (x, y) => artwork.data[(y * artwork.info.width + x) * 4 + 3];
  assert.equal(alpha(0, 400), 0);
  assert.equal(alpha(599, 400), 0);
  assert.equal(alpha(300, 0), 0);
  assert.equal(alpha(300, 799), 0);
  assert.ok(alpha(300, 50) > 0 && alpha(300, 50) < 255);
  assert.equal(alpha(300, 400), 255);
  assert.equal((await sendWelcome({ name: "No email", kind: "registration" })).status, "skipped");
  t.mock.method(nodemailer, "createTransport", () => ({
    async sendMail() { throw Object.assign(new Error("test"), { code: "ETIMEDOUT" }); },
  }));
  t.mock.method(console, "error", () => {});
  assert.equal((await sendWelcome({ email: "test@example.com", name: "Test" })).status, "failed");
  t.mock.method(nodemailer, "createTransport", () => ({
    async sendMail() { return { accepted: [], rejected: ["test@example.com"] }; },
  }));
  assert.equal((await sendWelcome({ email: "test@example.com", name: "Test" })).status, "failed");
  process.env.SMTP_PORT = "invalid";
  assert.equal((await sendWelcome({ email: "test@example.com", name: "Test" })).status, "failed");

  for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"]) delete process.env[key];
  process.env.EMAIL = "sender@gmail.com";
  process.env.APP_PASS = "mock-app-password";
  t.mock.method(nodemailer, "createTransport", (options) => {
    assert.equal(options.host, "smtp.gmail.com");
    assert.equal(options.port, 587);
    assert.equal(options.secure, false);
    assert.equal(options.requireTLS, true);
    assert.deepEqual(options.auth, { user: "sender@gmail.com", pass: "mock-app-password" });
    return { async sendMail(mail) { captured = mail; return { accepted: [mail.to] }; } };
  });
  assert.equal((await sendWelcome({ email: "test@example.com", name: "Team", kind: "organizer" })).status, "sent");
  assert.equal(captured.from, "sender@gmail.com");
  assert.equal(captured.to, "test@example.com");
  assert.ok(captured.text.includes("organization team"));
  delete process.env.APP_PASS;
  assert.equal((await sendWelcome({ email: "test@example.com", name: "Test" })).status, "failed");

  process.env.APP_PASS = "mock-app-password";
  Object.assign(process.env, {
    SMTP_HOST: "smtp.example.test", SMTP_PORT: "465", SMTP_USER: "smtp-user",
    SMTP_PASS: "mock-smtp-password", MAIL_FROM: "custom@example.test",
  });
  t.mock.method(nodemailer, "createTransport", (options) => {
    assert.equal(options.host, "smtp.example.test");
    assert.equal(options.port, 465);
    assert.equal(options.secure, true);
    assert.equal(options.requireTLS, false);
    assert.deepEqual(options.auth, { user: "smtp-user", pass: "mock-smtp-password" });
    return { async sendMail(mail) { captured = mail; return { accepted: [mail.to] }; } };
  });
  assert.equal((await sendWelcome({ email: "test@example.com", name: "Test", kind: "signup" })).status, "sent");
  assert.equal(captured.from, "custom@example.test");
});
