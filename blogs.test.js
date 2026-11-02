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
  function form({ bytes = image, title = "Retreat story", text = "Text below the image", includeImage = true } = {}) {
    const data = new FormData();
    data.set("title", title);
    data.set("text", text);
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
});
