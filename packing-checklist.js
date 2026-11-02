"use strict";

const PACKING_CHECKS = [
  {
    id: "count",
    instruction: "Check that the item count matches the order.",
  },
  {
    id: "packing",
    instruction: "Pack the items securely with suitable cushioning, then seal the parcel.",
  },
  {
    id: "address",
    instruction: "Check that the delivery address is complete and matches the order.",
  },
];

/**
 * Reports caller-recorded completion of the packing guide, not physical verification.
 * Accepts an array of known string IDs; invalid input throws TypeError.
 * Returns fresh pending records in guide order without mutating completedChecks.
 */
function packingChecklistStatus(completedChecks = []) {
  if (!Array.isArray(completedChecks)) {
    throw new TypeError("completedChecks must be an array.");
  }

  const completed = new Set();
  for (const id of completedChecks) {
    if (typeof id !== "string") {
      throw new TypeError("completedChecks entries must be strings.");
    }
    if (!PACKING_CHECKS.some((check) => check.id === id)) {
      throw new TypeError("Unknown check ID; expected count, packing, or address.");
    }
    completed.add(id);
  }

  const pending = PACKING_CHECKS
    .filter((check) => !completed.has(check.id))
    .map((check) => ({ ...check }));

  return { complete: pending.length === 0, pending };
}

module.exports = { packingChecklistStatus };
