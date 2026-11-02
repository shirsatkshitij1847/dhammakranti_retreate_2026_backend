const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

test("URL configuration validates environment and normalizes origins", () => {
  function run(overrides) {
    return spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(require('./config')))"], {
      cwd: __dirname,
      env: {
        ...process.env,
        PORT: "4000",
        FRONTEND_URL: "https://frontend.example.test/",
        BACKEND_URL: "https://backend.example.test/",
        ...overrides,
      },
      encoding: "utf8",
    });
  }
  const valid = run({});
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), {
    port: 4000,
    frontendUrl: "https://frontend.example.test",
    backendUrl: "https://backend.example.test",
  });
  for (const overrides of [
    { PORT: "0" }, { PORT: "abc" }, { PORT: "65536" },
    { FRONTEND_URL: "" }, { BACKEND_URL: "not-a-url" },
    { FRONTEND_URL: "http://localhost:5173/#registration" },
    { BACKEND_URL: "https://example.test/api" },
    { BACKEND_URL: "https://user:password@example.test" },
    { BACKEND_URL: "ftp://example.test" },
  ]) {
    assert.notEqual(run(overrides).status, 0);
  }
});
