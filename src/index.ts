// Supported package entrypoint: CLI bootstrap and local diagnostic report API.
// The export map and docs/library-exports.md define the consumer contract.
export { main, type MainDeps } from "./cli.js";
export {
  askToSendReports,
  createReportRunContext,
  noteCapsuleFromThisRun,
  pendingReports,
  renderReportCommandResult,
  reportsDir,
  runReportCommand,
  writeErrorReport,
  type ErrorReport,
  type ReportCommandDeps,
  type ReportCommandResult,
  type ReportCommandRun,
  type ReportFinalizationDeps,
  type ReportInvocationMode,
  type ReportRunContext,
} from "./errorReport.js";
