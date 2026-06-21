import { describe, expect, it } from "vitest";
import type { RuleConditionGroup } from "../src/types/domain";
import { buildRuleFromBuilderDraft } from "../src/views/rules/ruleBuilder";

describe("rule builder", () => {
  it("serializes root operator and nested condition groups without flattening", () => {
    const groups: RuleConditionGroup[] = [
      {
        id: "group-name-size",
        operator: "AND",
        conditions: [
          { id: "cond-name", field: "name", operator: "contains", value: "invoice" },
          { id: "cond-size", field: "size", operator: "greaterThan", value: "1000000" }
        ]
      },
      {
        id: "group-extension",
        operator: "OR",
        conditions: [
          { id: "cond-pdf", field: "extension", operator: "equals", value: "pdf" },
          { id: "cond-docx", field: "extension", operator: "equals", value: "docx" }
        ]
      }
    ];

    const rule = buildRuleFromBuilderDraft({
      id: "rule-compound",
      name: "Compound user rule",
      rootOperator: "OR",
      groups,
      purpose: "Project",
      lifecycle: "Reference",
      weight: 91,
      now: "2026-06-21T00:00:00.000Z"
    });

    expect(rule.root_operator).toBe("OR");
    expect(rule.groups).toEqual(groups);
    expect(rule.action.purpose).toBe("Project");
    expect(rule.action.lifecycle).toBe("Reference");
    expect(rule.weight).toBe(91);
  });
});
