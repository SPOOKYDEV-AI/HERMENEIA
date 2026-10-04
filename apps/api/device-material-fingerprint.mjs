import { createHash } from "node:crypto";

export function createDeviceMaterialFingerprinter() {
  return {
    fingerprint(publicMaterialRef) {
      if (typeof publicMaterialRef !== "string") {
        throw new TypeError("publicMaterialRef must be a string");
      }
      return `sha256:${createHash("sha256")
        .update(publicMaterialRef, "utf8")
        .digest("hex")}`;
    },
  };
}
