"use strict";

// Input must already be accepted by savedBatchReportCodec.decode. This module
// counts only; it neither validates nor reads, renders, or edits saved data.
function emptySummary() {
  return { total: 0, succeeded: 0, failed: 0, failureStages: { read: 0, decode: 0, format: 0 } };
}

function summarizeReport(report) {
  const summary = emptySummary();
  summary.total = report.total;
  summary.succeeded = report.succeeded;
  summary.failed = report.failed;
  // Count recorded occurrences, not unique paths; ignore extra fields on success.
  for (const result of report.results) {
    if (!result.ok) summary.failureStages[result.error.stage] += 1;
  }
  return summary;
}

function combineSummaries(summaries) {
  const combined = emptySummary();
  for (const summary of summaries) {
    for (const field of ["total", "succeeded", "failed"]) {
      combined[field] += summary[field];
    }
    for (const stage of Object.keys(combined.failureStages)) {
      combined.failureStages[stage] += summary.failureStages[stage];
    }
  }
  return combined;
}

module.exports = { summarizeReport, combineSummaries };
