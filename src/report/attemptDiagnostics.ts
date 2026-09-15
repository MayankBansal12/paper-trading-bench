/** Descriptive failure labels from retained host evidence, never a scoring or
 * retry policy. Recovered tool/provider errors are signals, not failed days. */
export function attemptDiagnostics(outcome: string, reason: string | null, observed: any[]) {
  const responses = observed.filter(e => e.type === "inference_response");
  const lastStatus = responses.at(-1)?.status;
  let failureCategory: string | null = null;
  if (!["completed", "unfinished"].includes(outcome)) {
    if (outcome === "interrupted") failureCategory = "interrupted";
    else if (outcome === "budget_cutoff") failureCategory = /timeout|deadline|expired/i.test(reason ?? "") ? "timeout" : "runtime-limit";
    else if (lastStatus >= 400) failureCategory = "provider-http-error";
    else if (outcome === "provider_error") failureCategory = "provider-error";
    else if (outcome === "incomplete_terminal_response" || reason === "Client did not submit a complete decision") failureCategory = "no-submission";
    else if (outcome === "harness_error") failureCategory = "harness-error";
    else failureCategory = "unclassified";
  }
  return {
    failureCategory,
    toolValidationErrors: observed.filter(e => e.type === "tool_result" && e.result?.isError === true).length,
    providerHttpErrors: responses.filter(e => e.status >= 400).map(e => ({ request: e.sequence, status: e.status })),
    gatewayDenials: observed.filter(e => e.type === "gateway_denied").length,
  };
}
