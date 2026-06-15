import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FileRecord, Rule } from "../src/types/domain";
import { classifyFile } from "../src/core/ruleEngine";
import { createOperationPreviews } from "../src/core/operationPlanner";

describe("rule engine classification", () => {
  it("classifies resume files as Career", () => {
    const result = classifyFile(makeFile("resume_2026.pdf"));
    expect(result.purpose).toBe("Career");
    expect(result.suggested_action).toBe("Move");
  });

  it("classifies invoice files as Finance and requires review", () => {
    const result = classifyFile(makeFile("invoice_apple.pdf"));
    expect(result.purpose).toBe("Finance");
    expect(result.risk_level).toBe("Sensitive");
    expect(result.requires_confirmation).toBe(true);
  });

  it("marks passport scans as sensitive identity files", () => {
    const result = classifyFile(makeFile("passport_scan.jpg"));
    expect(result.purpose).toBe("Identity");
    expect(result.lifecycle).toBe("Sensitive");
    expect(result.risk_level).toBe("Sensitive");
  });

  it("marks setup installers as disposable review candidates", () => {
    const result = classifyFile(makeFile("setup.exe"));
    expect(result.purpose).toBe("Installer");
    expect(result.lifecycle).toBe("Disposable");
    expect(result.suggested_action).toBe("Review");
  });

  it("lets user rules override built-in rule outcomes", () => {
    const customRule: Rule = {
      id: "user_resume_project",
      name: "Resume project override",
      source: "user",
      enabled: true,
      priority: 120,
      weight: 95,
      root_operator: "AND",
      groups: [
        {
          id: "group",
          operator: "AND",
          conditions: [{ id: "cond", field: "name", operator: "contains", value: "resume" }]
        }
      ],
      action: {
        purpose: "Project",
        lifecycle: "Active",
        suggested_action: "Move",
        target_template: "10_Projects/ResumeRefresh",
        context: "ResumeRefresh"
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const result = classifyFile(makeFile("resume_2026.pdf"), [customRule]);
    expect(result.purpose).toBe("Project");
    expect(result.context).toBe("ResumeRefresh");
  });

  it("routes close scoring conflicts into confirmation", () => {
    const ruleA = makeRule("A", "Project", 80, 80);
    const ruleB = makeRule("B", "Work", 80, 78);
    const result = classifyFile(makeFile("client_report.pdf"), [ruleA, ruleB]);
    expect(result.requires_confirmation).toBe(true);
    expect(result.classification_reason).toContain("similar rule scores");
  });

  it("does not generate executable operations for sensitive files", () => {
    const sensitive = classifyFile(makeFile("passport_scan.jpg"));
    const previews = createOperationPreviews([sensitive]);
    expect(previews).toHaveLength(0);
  });
});

function makeFile(name: string): FileRecord {
  const filePath = path.join("C:\\Users\\tester\\Downloads", name);
  return {
    id: name,
    name,
    path: filePath,
    directory: path.dirname(filePath),
    extension: path.extname(name).replace(".", ""),
    size: 1024,
    file_type: name.endsWith(".exe") ? "Installer" : name.endsWith(".jpg") ? "Image" : "Document",
    purpose: "Unknown",
    lifecycle: "Reference",
    context: "",
    risk_level: "Unknown",
    hash: null,
    created_at: new Date().toISOString(),
    modified_at: new Date().toISOString(),
    scanned_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    is_hidden: false,
    is_deleted: false,
    is_duplicate: false,
    suggested_action: "Keep",
    suggested_target_path: "",
    suggested_name: name,
    confidence: 0,
    classification_reason: "",
    matched_rules: [],
    requires_confirmation: false
  };
}

function makeRule(name: string, purpose: "Project" | "Work", priority: number, weight: number): Rule {
  return {
    id: name,
    name,
    source: "user",
    enabled: true,
    priority,
    weight,
    root_operator: "AND",
    groups: [
      {
        id: `${name}_group`,
        operator: "AND",
        conditions: [{ id: `${name}_cond`, field: "name", operator: "contains", value: "report" }]
      }
    ],
    action: { purpose, lifecycle: "Active", suggested_action: "Move", target_template: `10_Projects/${name}` },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

