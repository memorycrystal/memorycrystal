import { replaceRequired } from "./public-scrub.mjs";

/** Remove excluded modules from Convex's generated API declarations. */
export function stripGeneratedApiModules(content, moduleNames) {
  for (const moduleName of moduleNames) {
    const escapedModule = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    content = replaceRequired(
      content,
      new RegExp(String.raw`^import type \* as \w+ from ["']\.\./${escapedModule}\.js["'];\r?\n`, "gm"),
      "",
      `generated API import for ${moduleName}`,
      1,
    );
    content = replaceRequired(
      content,
      new RegExp(String.raw`^[\t ]*["']${escapedModule}["']: typeof \w+;\r?\n`, "gm"),
      "",
      `generated API entry for ${moduleName}`,
      1,
    );
  }
  return content;
}
