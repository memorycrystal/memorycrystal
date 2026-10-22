/** Runtime distillation kill switch. Read it at each function boundary. */
export function isDistillationPaused(): boolean {
  return process.env.CRYSTAL_DISTILLATION_PAUSED === "1";
}
