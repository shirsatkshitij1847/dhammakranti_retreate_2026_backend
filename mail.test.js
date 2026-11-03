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
  assert.ok(message.html.includes("cid:triratna-buddha"));
  assert.ok(message.html.includes('background="cid:triratna-stupa"'));
  assert.ok(message.html.includes("max-width:640px;background:#11251b"));
  assert.ok(message.html.includes('class="email-column email-art"'));
  assert.ok(message.html.includes('class="email-column email-copy"'));
  assert.ok(message.html.includes("rgba(7,22,14,0.90)"));
  assert.ok(message.html.includes("With warm wishes,"));
  assert.ok(message.text.includes("Copyright"));
  assert.ok(createMessage({ name: "Test", kind: "registration" }).text.includes("registering"));
  assert.ok(createMessage({ name: "Admin", kind: "admin" }).text.includes("administrator"));
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
    for (const key of ["MAIL_ENABLED", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"]) {
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
  assert.ok(captured.attachments.every((file) => require("node:fs").existsSync(file.path)));
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
});
