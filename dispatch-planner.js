"use strict";

const PRIORITIES = { urgent: 0, normal: 1 };

function invalid(path, message) {
  throw new Error(path + ": " + message);
}

function object(value, path, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) invalid(path + "." + key, "unknown field");
  }
}

function text(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(path, "must be a non-empty string");
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    invalid(path, "must be a single line without control characters or surrounding whitespace");
  }
}

function records(value, path, fields, validate) {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  const ids = new Set();
  // Validate the whole batch before assigning anything: no partial dispatches.
  value.forEach((record, index) => {
    const location = path + "[" + index + "]";
    object(record, location, fields);
    text(record.id, location + ".id");
    if (ids.has(record.id)) invalid(location + ".id", "duplicate ID " + JSON.stringify(record.id));
    ids.add(record.id);
    validate(record, location);
  });
}

function validateBatch(batch) {
  object(batch, "batch", ["deliveries", "couriers"]);
  records(batch.deliveries, "deliveries", ["id", "address", "priority", "notes"], (delivery, path) => {
    text(delivery.address, path + ".address");
    if (delivery.priority !== "urgent" && delivery.priority !== "normal") {
      invalid(path + ".priority", 'must be "urgent" or "normal"');
    }
    if (Object.hasOwn(delivery, "notes")) text(delivery.notes, path + ".notes");
  });
  records(batch.couriers, "couriers", ["id", "name", "capacity"], (courier, path) => {
    if (!Number.isSafeInteger(courier.capacity) || courier.capacity < 0) {
      invalid(path + ".capacity", "must be a non-negative safe integer (delivery stops)");
    }
    if (Object.hasOwn(courier, "name")) text(courier.name, path + ".name");
  });
}

// Code-unit ordering is case-sensitive and independent of the machine's locale.
function compareIds(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function planDispatch(batch) {
  validateBatch(batch);
  const deliveries = [...batch.deliveries].sort((a, b) =>
    PRIORITIES[a.priority] - PRIORITIES[b.priority] || compareIds(a, b));
  const couriers = [...batch.couriers].sort(compareIds).map((courier) => ({
    ...courier,
    assignedCount: 0,
    remainingCapacity: courier.capacity,
    deliveries: [],
  }));
  const unassigned = [];

  for (const delivery of deliveries) {
    let selected;
    // ID-sorted couriers: retaining the first equal load breaks ties.
    for (const courier of couriers) {
      if (courier.remainingCapacity > 0 &&
          (!selected || courier.assignedCount < selected.assignedCount)) {
        selected = courier;
      }
    }
    if (selected) {
      selected.deliveries.push({ ...delivery });
      selected.assignedCount += 1;
      selected.remainingCapacity -= 1;
    } else {
      unassigned.push({ ...delivery, reason: "capacity_exhausted" });
    }
  }

  return {
    summary: {
      totalDeliveries: deliveries.length,
      assignedDeliveries: deliveries.length - unassigned.length,
      unassignedDeliveries: unassigned.length,
    },
    couriers,
    unassigned,
  };
}

function formatDelivery(delivery) {
  return "  - [" + delivery.priority.toUpperCase() + "] " + delivery.id + ": " + delivery.address +
    (delivery.notes ? " (" + delivery.notes + ")" : "");
}

function formatReport(plan) {
  const { summary } = plan;
  const lines = [
    "E11 Dispatch Desk",
    summary.totalDeliveries + " deliveries | " + summary.assignedDeliveries + " assigned | " +
      summary.unassignedDeliveries + " unassigned",
    "Capacity is measured in delivery stops; listed order is not a route.",
    "",
    "Couriers",
  ];
  if (plan.couriers.length === 0) lines.push("  (none available)");
  for (const courier of plan.couriers) {
    lines.push(courier.id + (courier.name ? " (" + courier.name + ")" : "") + ": " +
      courier.assignedCount + "/" + courier.capacity + " stops used, " + courier.remainingCapacity + " remaining");
    if (courier.deliveries.length === 0) lines.push("  (no deliveries assigned)");
    for (const delivery of courier.deliveries) lines.push(formatDelivery(delivery));
  }
  lines.push("", "Unassigned (" + plan.unassigned.length + ")");
  if (plan.unassigned.length === 0) lines.push("  (none)");
  for (const delivery of plan.unassigned) {
    lines.push(formatDelivery(delivery) + " — no courier capacity available");
  }
  return lines.join("\n");
}

module.exports = { planDispatch, formatReport };
