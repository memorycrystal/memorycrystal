/** Bound teardown and report children that require force or never acknowledge exit. */
export function waitForChildExit(child, termMs = 5000, killMs = 2000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let forced = false;
    let settled = false;
    let escalate;
    let giveUp;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(escalate);
      clearTimeout(giveUp);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish(forced ? new Error("child ignored SIGTERM; required SIGKILL") : undefined);
    child.once("exit", onExit);
    escalate = setTimeout(() => {
      forced = true;
      try { child.kill("SIGKILL"); }
      catch (error) { finish(error); }
    }, termMs);
    giveUp = setTimeout(() => finish(new Error("child did not exit after SIGTERM and SIGKILL")), termMs + killMs);
    try { child.kill("SIGTERM"); }
    catch (error) { finish(error); }
  });
}
