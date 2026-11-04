const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const mongoose = require("mongoose");

process.env.PORT = "7004";
process.env.FRONTEND_URL = "https://frontend.example.test";
process.env.BACKEND_URL = "https://backend.example.test";
const app = require("./index");
const Retreat = mongoose.model("Retreat");

test("public upcoming retreats use India dates and expose only retreat details", async (t) => {
  const now = new Date("2026-11-03T19:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const rows = [
    { _id: "ended", name: "Ended", startDate: "2026-11-01", endDate: "2026-11-03" },
    { _id: "ongoing", name: "Ongoing", year: 2026, startDate: "2026-11-02", endDate: "2026-11-04", venue: "Akola", registrationVersion: 42 },
    { _id: "future", name: "Future", year: 2026, startDate: "2026-11-05", endDate: "2026-11-07", venue: "Centre" },
    { _id: "undated", name: "Undated", startDate: "", endDate: "" },
  ];
  t.mock.method(Retreat, "find", (filter) => {
    assert.equal(filter.endDate.$gte, "2026-11-04");
    return {
      select(fields) {
        assert.equal(fields, "_id name year startDate endDate venue");
        return this;
      },
      sort(order) {
        assert.deepEqual(order, { startDate: 1, name: 1 });
        return Promise.resolve(rows.filter((row) =>
          new RegExp(filter.startDate.$regex).test(row.startDate) && row.endDate >= filter.endDate.$gte));
      },
    };
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/retreats/upcoming`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.deepEqual(data.map((row) => row._id), ["ongoing", "future"]);
  assert.deepEqual(Object.keys(data[0]).sort(), ["_id", "name", "year", "startDate", "endDate", "venue"].sort());
  assert.equal((await fetch(`${base}/api/retreats`)).status, 401);
  rows.length = 0;
  assert.deepEqual(await (await fetch(`${base}/api/retreats/upcoming`)).json(), []);
});
