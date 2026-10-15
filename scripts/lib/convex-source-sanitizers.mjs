function removeRouteCallByHandler(content, handler) {
  const escapedHandler = handler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const routeCall = new RegExp(
    String.raw`^route\(\{(?:(?!^route\().)*?\bhandler:\s*${escapedHandler}\b(?:(?!^route\().)*?\}\);\n`,
    "gms",
  );
  return content.replace(routeCall, "");
}

export function stripPrivateHttpRoutes(content) {
  let rewritten = content
    .replace(
      /^import \{ polarWebhook \} from "\.\/crystal\/polarWebhook";\n/m,
      "",
    )
    .replace(
      /^import \{ telemetryPushHandler \} from "\.\/cloud\/telemetryHttp";\n/m,
      "",
    )
    .replace(
      /^import \{ mcpPrivateMemoryImport \} from "\.\/crystal\/privateMemoryImport";\n/m,
      "",
    );

  for (const handler of [
    "polarWebhook",
    "telemetryPushHandler",
    "mcpPrivateMemoryImport",
  ]) {
    rewritten = removeRouteCallByHandler(rewritten, handler);
  }
  return rewritten;
}

export function stripHostedControlPlaneCrons(content) {
  const hadEssentialOnlyGate = content.includes(
    'if (process.env.CRYSTAL_ESSENTIAL_JOBS_ONLY !== "1") {',
  );
  const rewritten = content
    .replace(
      /\n[ \t]*\/\/ ============ Cloud Control Plane[\s\S]*?(?=\n[ \t]*\/\/ (?:============ Tenant-Local|M8 — Embedding dual-write reconcile:))/,
      "\n",
    )
    .replace(
      /\n[ \t]*\/\/ US-006 — Admin-settings staging TTL sweep:[\s\S]*?internal\.crystal\.adminSettings\.mutations\.pruneStaleStagingRows,[\s\S]*?\n[ \t]*\);\n/,
      "\n",
    );
  if (!hadEssentialOnlyGate) return rewritten;

  const nextPublicCronAnchor = /\n[ \t]*\/\/ (?:============ Tenant-Local|M8 — Embedding dual-write reconcile:)[^\n]*/g;
  const anchorCount = [...rewritten.matchAll(nextPublicCronAnchor)].length;
  if (anchorCount !== 1) {
    throw new Error(`public-mirror cron rewrite drift: expected one post-control-plane boundary, found ${anchorCount}`);
  }
  return rewritten.replace(nextPublicCronAnchor, (anchor) => `\n  }${anchor}`);
}
