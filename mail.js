const nodemailer = require("nodemailer");
const path = require("node:path");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function createMessage({ name, kind, retreat }) {
  const registration = kind === "registration";
  const heading = registration ? "Your retreat journey begins" : "Welcome to our community";
  const message = registration
    ? "Thank you for registering and choosing to share this retreat with us. In the midst of everyday life, taking time to pause, breathe, and turn towards the Dhamma is a meaningful gift to yourself. Your presence will bring warmth to our circle of friendship, and we look forward to welcoming you."
    : kind === "admin"
      ? "Thank you for your first visit as an administrator. Your care helps our community grow through friendship, wisdom, and compassion."
      : "Thank you for visiting Triratna Akola and creating your account. Your request has been sent for admin approval. Please log in again after your account is approved.";
  const closing = "May your journey be filled with peace, kindness, and meaningful connection.";
  const year = new Date().getFullYear();
  const formatDate = (value) => new Intl.DateTimeFormat("en-IN", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
  const details = registration ? [
    ["Retreat", retreat?.name || "Your selected retreat"],
    ...(retreat?.year ? [["Year", String(retreat.year)]] : []),
    ["Dates", retreat?.startDate && retreat?.endDate
      ? `${formatDate(retreat.startDate)} – ${formatDate(retreat.endDate)}`
      : "To be confirmed by the organizer"],
    ["Venue", retreat?.venue || "To be confirmed by the organizer"],
  ] : [];
  const detailsText = details.length ? `\n\nYour retreat details\n${details.map(([label, value]) => `${label}: ${value}`).join("\n")}\n\nPlease keep these details for your visit. If you have any questions, contact your retreat organizer.` : "";
  const detailsHtml = details.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;border-top:1px solid #536044;border-bottom:1px solid #536044"><tr><td style="padding:14px 0">
  <p style="margin:0 0 10px;color:#f0dfb4;font-size:13px;font-weight:bold">Your retreat details</p>
  ${details.map(([label, value]) => `<p style="margin:0 0 8px;color:#e4e9e1;font-size:13px;line-height:1.7"><strong style="color:#ddc58c">${label}</strong><br>${escapeHtml(value)}</p>`).join("")}
  </td></tr></table><p style="margin:0 0 18px;font-size:13px;line-height:1.8;color:#c5cfbf">Please keep these details for your visit. If you have any questions, contact your retreat organizer.</p>` : "";
  const text = `Namo Buddhaya, ${name}!\n\n${heading}\n\n${message}${detailsText}\n\n${closing}\n\nWith warm wishes,\nTriratna Akola\n\nTriratna Youth Akola on YouTube\nhttps://www.youtube.com/@triratnayouthakola7304\n\nThis email relates to your account or retreat registration with Triratna Akola.\nCopyright ${year} Triratna Bauddha Mahasangh, Akola. All rights reserved.`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <style>@media only screen and (max-width:600px){.email-content{padding:24px!important}.email-outer{padding:20px 10px!important}.email-column{display:block!important;width:100%!important;box-sizing:border-box!important}.email-art{padding:0 0 24px!important;text-align:center!important}.email-art img{margin:0 auto!important}.email-copy{padding:0!important}}</style></head>
  <body style="margin:0;padding:0;background:#08150f;color:#e4e9e1;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#08150f"><tr>
  <td class="email-outer" align="center" style="padding:48px 16px">
  <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#11251b;border-top:3px solid #b39450">
  <tr><td class="email-content" style="padding:28px 32px;background:#102219">
  <table role="presentation" cellspacing="0" cellpadding="0"><tr>
  <td width="44" valign="middle"><img src="cid:triratna-logo" width="36" alt="Triratna logo" style="display:block;border:0;height:auto"></td>
  <td valign="middle" style="padding-left:10px"><p style="margin:0;color:#f0dfb4;font-size:18px;font-weight:bold;line-height:1.4">Triratna Akola</p><p style="margin:3px 0 0;color:#b5c3b4;font-size:10px;letter-spacing:1px;line-height:1.5">FRIENDSHIP · WISDOM · COMPASSION</p></td>
  </tr></table></td></tr>
  <tr><td background="cid:triratna-stupa" style="background-color:#11251b;background-image:url('cid:triratna-stupa');background-position:center;background-size:cover">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#11251b;background-color:rgba(7,22,14,0.90)"><tr><td class="email-content" style="padding:36px 32px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
  <td class="email-column email-art" width="180" valign="middle" style="padding-right:28px"><img src="cid:triratna-buddha" width="152" alt="Buddha" style="display:block;width:152px;max-width:100%;height:auto;border:0"></td>
  <td class="email-column email-copy" valign="top" style="overflow-wrap:anywhere">
  <h1 style="margin:0 0 20px;color:#f0dfb4;font-size:22px;font-weight:600;line-height:1.4">${heading}</h1>
  <p style="margin:0 0 14px;font-size:14px;line-height:1.8;color:#e4e9e1">Namo Buddhaya, ${escapeHtml(name)}!</p>
  <p style="margin:0 0 18px;font-size:14px;line-height:1.8;color:#e4e9e1">${message}</p>
  ${detailsHtml}
  <p style="margin:0;font-size:13px;line-height:1.8;color:#c5cfbf">${closing}</p>
  <p style="margin:22px 0 0;font-size:14px;line-height:1.8;color:#e4e9e1">With warm wishes,<br><strong style="color:#f0dfb4">Triratna Akola</strong></p>
  </td></tr></table></td></tr></table></td></tr>
  <tr><td class="email-content" style="padding:24px 32px 28px;background:#102219">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #3c4b38"><tr><td style="padding-top:20px">
  <a href="https://www.youtube.com/@triratnayouthakola7304" style="font-size:12px;line-height:1.8;color:#ddc58c;text-decoration:underline">Triratna Youth Akola on YouTube</a>
  <p style="margin:14px 0;font-size:11px;line-height:1.8;color:#b5c3b4">This email relates to your account or retreat registration with Triratna Akola.</p>
  <p style="margin:0;font-size:11px;line-height:1.8;color:#b5c3b4">Triratna Bauddha Mahasangh, Akola<br>Copyright &copy; ${year}. All rights reserved.</p>
  </td></tr></table></td></tr></table>
  </td></tr></table></body></html>`;
  return { subject: registration ? "Thank you for your retreat registration · Triratna Akola" : "Welcome to Triratna Akola", text, html };
}

function mailEnabled() {
  return process.env.MAIL_ENABLED === "true";
}

async function sendWelcome({ email, name, kind, retreat }) {
  if (!email) return { status: "skipped" };
  if (!mailEnabled()) return { status: "disabled" };
  try {
    const port = Number(process.env.SMTP_PORT || 587);
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.MAIL_FROM ||
        !Number.isInteger(port) || port < 1 || port > 65535) {
      throw Object.assign(new Error("Missing mail settings"), { code: "MAIL_CONFIGURATION" });
    }
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    const assets = path.join(__dirname, "mail-assets");
    const message = createMessage({ name, kind, retreat });
    const result = await transport.sendMail({
      from: process.env.MAIL_FROM,
      to: email,
      ...message,
      attachments: [
        { filename: "logo.png", path: path.join(assets, "logo.png"), cid: "triratna-logo" },
        { filename: "buddha2.jpg", path: path.join(assets, "buddha2.jpg"), cid: "triratna-buddha" },
        { filename: "stupa.png", path: path.join(assets, "stupa.png"), cid: "triratna-stupa" },
      ],
    });
    if (!result.accepted?.length) throw Object.assign(new Error("Recipient rejected"), { code: "MAIL_REJECTED" });
    return { status: "sent" };
  } catch (error) {
    console.error("Welcome email delivery failed:", error.code || "MAIL_FAILURE");
    return { status: "failed", message: "Your details were saved, but the welcome email could not be sent. Please contact the organizer; do not submit again." };
  }
}

module.exports = { createMessage, mailEnabled, sendWelcome };
