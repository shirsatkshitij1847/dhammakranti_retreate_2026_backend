const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { randomBytes } = require("node:crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");

process.env.JWT_SECRET = randomBytes(32).toString("hex");
process.env.PORT = "3000";
process.env.FRONTEND_URL = "http://localhost:5173";
process.env.BACKEND_URL = "https://backend.example.test";
const app = require("./index");
const { Account } = require("./auth");
const Blog = mongoose.model("Blog");

test("MongoDB blog routes, uploads and author permissions (mocked database)", async (t) => {
  const accounts = ["visitor", "organizer", "organizer", "admin"].map((role) =>
    new Account({ name: role, email: `${randomBytes(4).toString("hex")}@example.com`, role }));
  const tokens = accounts.map((account) => jwt.sign({ tokenVersion: 0 }, process.env.JWT_SECRET, {
    subject: String(account._id), issuer: "triratnaAkola", audience: "retreat-api", expiresIn: "1h",
  }));
  const records = new Map();
  t.mock.method(Account, "findById", async (id) => accounts.find((a) => String(a._id) === id));
  t.mock.method(Blog, "create", async (values) => {
    const doc = new Blog(values);
    await doc.validate();
    records.set(String(doc._id), doc);
    return doc;
  });
  t.mock.method(Blog, "findById", (id) => {
    const doc = records.get(String(id)) || null;
    return {
      then(resolve, reject) { return Promise.resolve(doc).then(resolve, reject); },
      select() { return Promise.resolve(doc); },
    };
  });
  t.mock.method(Blog, "find", () => ({
    sort() { return this; },
    skip(count) { this.offset = count; return this; },
    limit(count) { return Promise.resolve([...records.values()].slice(this.offset, this.offset + count)); },
  }));
  t.mock.method(Blog, "findOneAndUpdate", async (filter, update) => {
    const doc = records.get(String(filter._id));
    if (!doc) return null;
    assert.equal(String(filter.authorId), String(doc.authorId));
    Object.assign(doc, update.$set);
    await doc.validate();
    return doc;
  });
  t.mock.method(Blog, "findOneAndDelete", async (filter) => {
    const doc = records.get(String(filter._id));
    assert.equal(String(filter.authorId), String(doc.authorId));
    records.delete(String(filter._id));
    return doc;
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const base = `http://127.0.0.1:${server.address().port}/api/blogs`;
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  function form({ bytes = image, title = "Retreat story", text = "Text below the image", includeImage = true, textFormat } = {}) {
    const data = new FormData();
    data.set("title", title);
    data.set("text", text);
    if (textFormat !== undefined) data.set("textFormat", textFormat);
    if (includeImage) data.set("image", new Blob([bytes]), "photo.png");
    return data;
  }
  function request(path = "", method = "GET", token, body) {
    return fetch(base + path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {}, body });
  }
  assert.deepEqual(await (await request()).json(), []);
  assert.equal((await request("", "POST", undefined, form())).status, 401);
  assert.equal((await request("", "POST", tokens[0], form())).status, 403);
  for (const data of [
    form({ includeImage: false }), form({ title: " " }),
    form({ bytes: Buffer.from("<svg></svg>") }),
  ]) {
    assert.equal((await request("", "POST", tokens[1], data)).status, 400);
  }
  assert.equal((await request("", "POST", tokens[1], form({
    bytes: Buffer.alloc(5 * 1024 * 1024 + 1),
  }))).status, 413);
  const created = await request("", "POST", tokens[1], form());
  assert.equal(created.status, 201);
  const post = await created.json();
  assert.equal(post.textFormat, "plain");
  assert.equal(post.title, "Retreat story");
  assert.equal(post.authorId, String(accounts[1]._id));
  assert.equal(post.image, undefined);
  assert.equal(post.imageUrl, `${process.env.BACKEND_URL}/api/blogs/${post._id}/image`);
  assert.ok(records.get(post._id).image.length > 0);
  const list = await request();
  assert.equal((await list.json()).length, 1);
  assert.deepEqual(await (await request("?page=2&limit=1")).json(), []);
  for (const query of ["?page=0", "?limit=51", "?page=bad", "?page=1&page=2"]) {
    assert.equal((await request(query)).status, 400);
  }
  assert.equal((await request("/invalid")).status, 400);
  assert.equal((await request(`/${new mongoose.Types.ObjectId()}`)).status, 404);
  assert.equal((await request(`/${post._id}`)).status, 200);
  const photo = await request(`/${post._id}/image`);
  assert.equal(photo.headers.get("content-type"), "image/webp");
  assert.equal(photo.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await sharp(Buffer.from(await photo.arrayBuffer())).metadata()).format, "webp");
  assert.equal((await request(`/${post._id}`, "PATCH", tokens[2], form())).status, 403);
  assert.equal((await request(`/${post._id}`, "DELETE", tokens[2])).status, 403);
  const edit = new FormData();
  edit.set("text", "Updated text");
  edit.set("authorId", String(accounts[2]._id));
  const edited = await request(`/${post._id}`, "PATCH", tokens[1], edit);
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).text, "Updated text");
  assert.equal(String(records.get(post._id).authorId), String(accounts[1]._id));
  const adminEdit = await request(`/${post._id}`, "PATCH", tokens[3], form({ title: "Admin edit" }));
  assert.equal(adminEdit.status, 200);
  const deleted = await request(`/${post._id}`, "DELETE", tokens[3]);
  assert.equal(deleted.status, 204);
  assert.equal(records.size, 0);
  assert.equal((await request(`/${post._id}/image`)).status, 404);

  const rich = await request("", "POST", tokens[1], form({
    textFormat: "html",
    text: '<h2>Heading</h2><p data-spacing="wide" onclick="bad()"><strong>Bold</strong> and <em>italic</em></p><ul><li>One</li></ul><blockquote>Peace</blockquote><script>bad()</script><img src=x onerror=bad()><iframe>bad</iframe>',
  }));
  const formatted = await rich.json();
  assert.equal(rich.status, 201, JSON.stringify(formatted));
  assert.equal(formatted.textFormat, "html");
  assert.ok(formatted.text.includes('<p data-spacing="wide"><strong>Bold</strong>'));
  assert.ok(formatted.text.includes("<em>italic</em>"));
  assert.ok(formatted.text.includes("<ul><li>One</li></ul>"));
  assert.ok(formatted.text.includes("<blockquote>Peace</blockquote>"));
  assert.ok(!/script|onclick|img|iframe/.test(formatted.text));
  const reloaded = await (await request(`/${formatted._id}`)).json();
  assert.equal(reloaded.text, formatted.text);
  const titleOnly = new FormData();
  titleOnly.set("title", "Title only");
  assert.equal((await request(`/${formatted._id}`, "PATCH", tokens[1], titleOnly)).status, 200);
  assert.equal(records.get(formatted._id).text, formatted.text);
  for (const bad of [
    { textFormat: "markdown" },
    { textFormat: "html", text: "<script>bad()</script>" },
    { textFormat: "html", text: "<p>&nbsp;</p>" },
    { textFormat: "html", text: `<p>${"a".repeat(20000)}</p>` },
  ]) {
    assert.equal((await request("", "POST", tokens[1], form(bad))).status, 400);
  }
  const formatOnly = new FormData();
  formatOnly.set("textFormat", "plain");
  assert.equal((await request(`/${formatted._id}`, "PATCH", tokens[1], formatOnly)).status, 400);
  assert.equal((await request(`/${formatted._id}`, "PATCH", tokens[2], form({ textFormat: "html" }))).status, 403);
  const cleaned = await request(`/${formatted._id}`, "PATCH", tokens[1], form({
    includeImage: false, textFormat: "html", text: '<p data-spacing="evil" style="color:red">Clean</p>',
  }));
  assert.equal(cleaned.status, 200);
  assert.equal((await cleaned.json()).text, "<p>Clean</p>");
  const convert = await request(`/${formatted._id}`, "PATCH", tokens[1], form({
    includeImage: false, textFormat: "plain", text: "<strong>Literal text</strong>",
  }));
  assert.equal(convert.status, 200);
  const plain = await convert.json();
  assert.equal(plain.textFormat, "plain");
  assert.equal(plain.text, "<strong>Literal text</strong>");
});
