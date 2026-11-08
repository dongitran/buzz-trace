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

  it("describes the contract names and the honest edges, and no longer a source other than Phoenix's server", () => {
    const content = fs.readFileSync(skillPath, "utf8");
    for (const name of ["nostr.posted_event_id", "event_id <hex>", "`steer`", "candidates", "ambiguous", "steered messages are not recorded"]) {
      expect(content, name).toContain(name);
    }
    expect(content).not.toMatch(/--messages|--db|sqlite|phoenix\.db/i);
  });
});

describe("what the docs and the code say about sources", () => {
  const root = findPackageRoot();
  const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

  it("README says the same contract names as src/contract.ts, and mentions no removed source", () => {
    const readme = read("README.md");
    const contract = read("src/contract.ts");
    for (const name of ["nostr.posted_event_id", "steer.priority", "nostr.sender_name"]) {
      expect(contract).toContain(name);
      expect(readme).toContain(name);
    }
    expect(readme).not.toMatch(/--messages|--db|sqlite|phoenix\.db|PHOENIX_DB_PATH/i);
  });

  it("no source file reads a database or a relay: Phoenix's server is the only source", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of walk("src").filter((f) => f.endsWith(".ts"))) {
      const code = read(file);
      expect(code, file).not.toMatch(/node:sqlite|DatabaseSync|better-sqlite|WebSocket|nostr-tools|buzz messages thread/);
    }
  });

  it("the package declares no dependency on a database driver or a Nostr client", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["gpt-tokenizer"]);
  });
});
