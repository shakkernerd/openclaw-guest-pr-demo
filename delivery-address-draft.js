"use strict";

// Classic-script codec shared by the real file-import and export paths.
// Values, not the original JSON spelling, are the interchange contract.
const addressDraftCodec = (() => {
  function validate(values) {
    if (!Array.isArray(values)) {
      throw new TypeError("draft must be an array of strings");
    }
    for (let index = 0; index < values.length; index += 1) {
      if (typeof values[index] !== "string") {
        throw new TypeError("draft[" + index + "] must be a string");
      }
      if (values[index].includes("\r")) {
        throw new RangeError("draft[" + index + "] contains CR; textareas cannot preserve CR");
      }
    }
  }

  return Object.freeze({
    decode(bytes) {
      let text;
      try {
        // Consume only a leading encoding BOM; FEFF inside strings stays data.
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      } catch {
        throw new TypeError("file must contain valid UTF-8");
      }
      let values;
      try {
        values = JSON.parse(text);
      } catch {
        throw new SyntaxError("file must contain valid JSON");
      }
      validate(values);
      return Object.freeze(values);
    },
    encode(values) {
      validate(values);
      return JSON.stringify(values, null, 2);
    },
  });
})();
