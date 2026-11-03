require("dotenv").config({ quiet: true });

function origin(name, value = process.env[name]) {
  if (!value) throw new Error(`${name} is required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) origin`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) origin without a path, credentials, query or fragment`);
  }
  return url.origin;
}

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}

const frontendUrl = origin("FRONTEND_URL");
const additionalOrigins = process.env.CORS_ADDITIONAL_ORIGINS?.trim();
const allowedFrontendOrigins = [...new Set([
  frontendUrl,
  ...(additionalOrigins
    ? additionalOrigins.split(",").map((value) => origin("CORS_ADDITIONAL_ORIGINS", value.trim()))
    : []),
])];

module.exports = {
  port,
  frontendUrl,
  allowedFrontendOrigins,
  backendUrl: origin("BACKEND_URL"),
};
