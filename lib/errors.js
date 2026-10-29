"use strict";

class ManifestError extends Error {
  constructor(code, message, exitCode = 3) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

module.exports = { ManifestError };
