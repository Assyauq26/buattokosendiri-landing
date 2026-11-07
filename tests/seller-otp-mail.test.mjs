import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sellerOtpMessage } from "../server/seller-otp-mail.mjs";

test("seller sign-in OTP uses the fixed sender and both formats", () => {
  const message = sellerOtpMessage("seller@example.test", "012345");
  assert.equal(message.from, "Buattokosendiri <otp@buattokosendiri.web.id>");
  assert.match(message.text, /012345/);
  assert.match(message.html, /012345/);
  assert.throws(() => sellerOtpMessage("seller@example.test", "<script>"));
});
