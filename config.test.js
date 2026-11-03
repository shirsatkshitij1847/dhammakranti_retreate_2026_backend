const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const express = require("express");
const cors = require("cors");

test("URL configuration validates environment and normalizes origins", async () => {
  function run(overrides) {
    return spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(require('./config')))"], {
      cwd: __dirname,
      env: {
        ...process.env,
        PORT: "4000",
        FRONTEND_URL: "https://frontend.example.test/",
        BACKEND_URL: "https://backend.example.test/",
        CORS_ADDITIONAL_ORIGINS: "",
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
    allowedFrontendOrigins: ["https://frontend.example.test"],
    backendUrl: "https://backend.example.test",
  });
  const production = run({
    PORT: "7004",
    FRONTEND_URL: "https://dhammakranti.triratnaakolayouth.com",
    BACKEND_URL: "https://dhammakrantiretreat.triratnaakolayouth.com",
    CORS_ADDITIONAL_ORIGINS: "http://localhost:5173/, http://127.0.0.1:5173,http://localhost:5173",
  });
  assert.equal(production.status, 0, production.stderr);
  assert.deepEqual(JSON.parse(production.stdout), {
    port: 7004,
    frontendUrl: "https://dhammakranti.triratnaakolayouth.com",
    allowedFrontendOrigins: [
      "https://dhammakranti.triratnaakolayouth.com",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
    backendUrl: "https://dhammakrantiretreat.triratnaakolayouth.com",
  });
  for (const overrides of [
    { PORT: "0" }, { PORT: "abc" }, { PORT: "65536" },
    { FRONTEND_URL: "" }, { BACKEND_URL: "not-a-url" },
    { FRONTEND_URL: "http://localhost:5173/#registration" },
    { BACKEND_URL: "https://example.test/api" },
    { BACKEND_URL: "https://user:password@example.test" },
    { BACKEND_URL: "ftp://example.test" },
    { CORS_ADDITIONAL_ORIGINS: "*" },
    { CORS_ADDITIONAL_ORIGINS: "http://localhost:5173/path" },
    { CORS_ADDITIONAL_ORIGINS: "http://localhost:5173," },
  ]) {
    assert.notEqual(run(overrides).status, 0);
  }

  const { allowedFrontendOrigins } = JSON.parse(production.stdout);
  const app = express();
  app.use(cors({ origin: allowedFrontendOrigins }));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/auth/login`;
    for (const origin of [...allowedFrontendOrigins, "https://untrusted.example.test"]) {
      for (const method of ["POST", "PATCH", "DELETE"]) {
        const response = await fetch(url, {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "authorization,content-type",
          },
        });
        assert.equal(response.status, 204);
        assert.equal(response.headers.get("access-control-allow-origin"),
          allowedFrontendOrigins.includes(origin) ? origin : null);
        assert.ok(response.headers.get("access-control-allow-methods").split(",").includes(method));
        assert.equal(response.headers.get("access-control-allow-headers"), "authorization,content-type");
      }
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
