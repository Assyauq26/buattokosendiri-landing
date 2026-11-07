export const SELLER_OTP_FROM = "Buattokosendiri <otp@buattokosendiri.web.id>";

export function sellerOtpMessage(to, code) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw new Error("invalid_otp");
  const instructions = "Berlaku 10 menit. Jangan bagikan kode ini. Abaikan jika Anda tidak meminta kode.";
  return {
    from: SELLER_OTP_FROM,
    to: [to],
    subject: "Kode masuk Buattokosendiri",
    text: `Kode masuk Anda: ${code}\n${instructions}`,
    html: `<main style="max-width:440px;margin:auto;padding:24px;background:#fff;color:#171717;font:16px system-ui"><h1>Buattokosendiri</h1><p>Kode masuk Anda</p><p style="font-size:32px;font-weight:bold;letter-spacing:.15em">${code}</p><p>${instructions}</p></main>`,
  };
}
