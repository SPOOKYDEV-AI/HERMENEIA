import { createHash } from "node:crypto";

export function sha256CredentialReference(token) {
  return createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}
