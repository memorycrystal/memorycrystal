import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatDuration } from "../../../apps/web/app/(dashboard)/organic/_shared";

const repoRoot = join(__dirname, "..", "..", "..");
const readRepoFile = (relativePath: string) =>
  readFileSync(join(repoRoot, relativePath), "utf8");

describe("batch3 frontend regressions", () => {
  it("formats zero or missing durations as sub-second output", () => {
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(null)).toBe("<1s");
  });

  it("lists the Skills nav item between Traces and Settings", () => {
    const layoutSource = readRepoFile("apps/web/app/(dashboard)/layout.tsx");
    const tracesIndex = layoutSource.indexOf('{ label: "Traces", href: "/organic/traces"');
    const skillsIndex = layoutSource.indexOf('{ label: "Skills", href: "/organic/skills"');
    const settingsIndex = layoutSource.indexOf('{ label: "Settings", href: "/organic/settings"');

    expect(tracesIndex).toBeGreaterThan(-1);
    expect(skillsIndex).toBeGreaterThan(tracesIndex);
    expect(settingsIndex).toBeGreaterThan(skillsIndex);
  });
});
