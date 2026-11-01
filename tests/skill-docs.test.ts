import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { findPackageRoot } from "../src/cli.js";

describe("buzz-trace SKILL.md", () => {
  const root = findPackageRoot();
  const skillPath = path.join(root, "skills", "buzz-trace", "SKILL.md");

  it("should exist in skills/buzz-trace/SKILL.md", () => {
    expect(fs.existsSync(skillPath)).toBe(true);
  });

  it("should have valid Agent Skills YAML frontmatter", () => {
    const content = fs.readFileSync(skillPath, "utf-8");
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();

    const fm = frontmatterMatch![1];
    const nameMatch = fm.match(/name:\s*([^\n]+)/);
    const descMatch = fm.match(/description:\s*([^\n]+)/);

    expect(nameMatch).not.toBeNull();
    expect(descMatch).not.toBeNull();

    const name = nameMatch![1].trim();
    const description = descMatch![1].trim();

    // Spec: name uses only lowercase letters, digits, and hyphens
    expect(name).toBe("buzz-trace");
    expect(name).toMatch(/^[a-z0-9-]+$/);

    // Spec: description starts with "Use when..."
    expect(description).toMatch(/^Use when\b/);

    // Spec: description max 1024 characters
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it("should include core principles, quick reference, recipes, and traps", () => {
    const content = fs.readFileSync(skillPath, "utf-8");
    expect(content).toContain("## Core Principles");
    expect(content).toContain("## Quick Reference");
    expect(content).toContain("## Recipes for AI Agents");
    expect(content).toContain("## Rationalization Table & Traps");
    expect(content).toContain("--compact --json");
    expect(content).toContain("buzz-trace install-skill");
  });
});
