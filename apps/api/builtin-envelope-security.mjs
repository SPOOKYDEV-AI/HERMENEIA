import {
  createHpkeP256OriginalEnvelopeProtector,
  createHpkeP256TranslationEnvelopeProtector,
} from "../../.build/packages/envelope-crypto/src/index.js";

export function createBuiltinEnvelopeSecurity() {
  return {
    envelopeProtector:
      createHpkeP256OriginalEnvelopeProtector(),
    translationEnvelopeProtector:
      createHpkeP256TranslationEnvelopeProtector(),
  };
}
