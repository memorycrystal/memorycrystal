/**
 * Organic Memory runtime flags.
 *
 * Prospective traces and the auto policy tuner are opt-in. Both ran on the
 * live recall/tick path with no measured quality gain (0/7,295 traces
 * validated; tuner scores a circular proxy, not recall@k/MRR). Default-off
 * removes an extra embed + vectorSearch + action from every normal-budget
 * recall and stops nightly weight churn.
 *
 * Re-enable only after a gold-set eval shows a win:
 *   CRYSTAL_TRACES_ENABLED=1
 *   CRYSTAL_POLICY_TUNER_ENABLED=1
 *
 * CRYSTAL_TRACES_DISABLED=1 remains a hard off even if ENABLED is also set.
 */

export function organicTracesEnabled(): boolean {
  if (process.env.CRYSTAL_TRACES_DISABLED === "1") return false;
  return process.env.CRYSTAL_TRACES_ENABLED === "1";
}

export function organicPolicyTunerEnabled(): boolean {
  return process.env.CRYSTAL_POLICY_TUNER_ENABLED === "1";
}
