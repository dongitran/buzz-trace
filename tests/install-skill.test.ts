import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runInstallSkill, findPackageRoot, main } from "../src/cli.js";

describe("install-skill", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "buzz-trace-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should discover the package root containing package.json", () => {
    const root = findPackageRoot();
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "skills", "buzz-trace", "SKILL.md"))).toBe(true);

    // Test with explicit nested path
    const nestedPath = path.join(root, "dist", "cli.js");
    const discovered = findPackageRoot(nestedPath);
    expect(discovered).toBe(root);
  });

  it("should preview actions in --dry-run mode without creating directories", () => {
    const targetDir = path.join(tmpDir, "skills", "buzz-trace");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = runInstallSkill({
      target: targetDir,
      dryRun: true,
    });

    expect(code).toBe(0);
    expect(fs.existsSync(targetDir)).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[dry-run]"));
    logSpy.mockRestore();
  });

  it("should successfully install skill to a designated target directory", () => {
    const targetDir = path.join(tmpDir, "custom-skills", "buzz-trace");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = runInstallSkill({
      target: targetDir,
    });

    expect(code).toBe(0);
    expect(fs.existsSync(targetDir)).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "SKILL.md"))).toBe(true);

    const content = fs.readFileSync(path.join(targetDir, "SKILL.md"), "utf-8");
    expect(content).toContain("name: buzz-trace");

    logSpy.mockRestore();
  });

  it("should automatically append 'buzz-trace' if target does not end with it", () => {
    const targetBase = path.join(tmpDir, "custom-skills");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = runInstallSkill({
      target: targetBase,
    });

    expect(code).toBe(0);
    const expectedDir = path.join(targetBase, "buzz-trace");
    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.existsSync(path.join(expectedDir, "SKILL.md"))).toBe(true);

    logSpy.mockRestore();
  });

  it("should skip existing target unless --force is provided", () => {
    const targetDir = path.join(tmpDir, "skills", "buzz-trace");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "SKILL.md"), "OLD CONTENT");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Without force: keeps existing
    let code = runInstallSkill({ target: targetDir, force: false });
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(targetDir, "SKILL.md"), "utf-8")).toBe("OLD CONTENT");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[exists]"));

    // With force: replaces
    code = runInstallSkill({ target: targetDir, force: true });
    expect(code).toBe(0);
    const replaced = fs.readFileSync(path.join(targetDir, "SKILL.md"), "utf-8");
    expect(replaced).toContain("name: buzz-trace");

    logSpy.mockRestore();
  });

  it("should detect up-to-date symlink and report [up-to-date]", () => {
    const targetDir = path.join(tmpDir, "uptodate-skills", "buzz-trace");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // First install
    let code = runInstallSkill({ target: targetDir });
    expect(code).toBe(0);

    // Second install without --force
    code = runInstallSkill({ target: targetDir, force: false });
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[up-to-date]"));

    logSpy.mockRestore();
  });

  it("should handle and replace dangling symlinks with --force", () => {
    const targetDir = path.join(tmpDir, "dangling-symlink", "buzz-trace");
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    // Create dangling symlink pointing to nonexistent path
    fs.symlinkSync(path.join(tmpDir, "nonexistent-target"), targetDir, "junction");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = runInstallSkill({ target: targetDir, force: true });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(targetDir, "SKILL.md"))).toBe(true);

    logSpy.mockRestore();
  });

  it("should return error if source SKILL.md does not exist", () => {
    const fakeRoot = path.join(tmpDir, "empty-package");
    fs.mkdirSync(fakeRoot, { recursive: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = runInstallSkill({
      packageRoot: fakeRoot,
    });

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Skill definition not found"));
    errSpy.mockRestore();
  });

  it("should fall back to recursive copy if symlink creation fails (e.g. Windows without dev mode)", () => {
    const targetDir = path.join(tmpDir, "fallback-skills", "buzz-trace");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    let symlinkAttempted = false;
    const code = runInstallSkill({
      target: targetDir,
      symlinkFn: () => {
        symlinkAttempted = true;
        const err = new Error("operation not permitted, symlink") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      },
    });

    expect(code).toBe(0);
    expect(symlinkAttempted).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "SKILL.md"))).toBe(true);

    const stat = fs.lstatSync(targetDir);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Copied"));

    logSpy.mockRestore();
  });

  it("should target both ~/.claude and ~/.agents skills directories by default with parent dir auto-creation", () => {
    const fakeHome = path.join(tmpDir, "fake-home");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = runInstallSkill({ homedir: fakeHome });
    expect(code).toBe(0);

    const claudeSkill = path.join(fakeHome, ".claude", "skills", "buzz-trace", "SKILL.md");
    const agentsSkill = path.join(fakeHome, ".agents", "skills", "buzz-trace", "SKILL.md");

    expect(fs.existsSync(claudeSkill)).toBe(true);
    expect(fs.existsSync(agentsSkill)).toBe(true);

    logSpy.mockRestore();
  });

  it("should ensure 'skills' is included in package.json files array for npm packaging", () => {
    const root = findPackageRoot();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    expect(pkg.files).toContain("skills");
  });

  it("should execute install-skill command via CLI main() entry point", async () => {
    const targetDir = path.join(tmpDir, "cli-target", "buzz-trace");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["install-skill", "--target", targetDir]);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(targetDir, "SKILL.md"))).toBe(true);

    logSpy.mockRestore();
  });
});
