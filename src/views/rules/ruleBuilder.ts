import type { Lifecycle, Purpose, Rule, RuleCondition, RuleConditionGroup, RuleOperator } from "../../types/domain";
import { localId } from "../../utils/viewHelpers";

export const RULE_FIELD_OPTIONS = [
  "name",
  "extension",
  "file_type",
  "path",
  "directory",
  "size",
  "modified_at",
  "risk_level"
] as const satisfies readonly RuleCondition["field"][];
export const RULE_OPERATOR_OPTIONS = [
  "contains",
  "equals",
  "startsWith",
  "endsWith",
  "greaterThan",
  "lessThan",
  "olderThanDays",
  "newerThanDays"
] as const satisfies readonly RuleCondition["operator"][];
export const RULE_PURPOSE_OPTIONS = ["Temporary", "Career", "Finance", "Study", "Project", "Personal", "Media", "Unknown"] as const satisfies readonly Purpose[];
export const RULE_LIFECYCLE_OPTIONS = ["Inbox", "Active", "Reference", "Archive", "Disposable", "Sensitive"] as const satisfies readonly Lifecycle[];
export const RULE_LOGIC_OPTIONS = ["AND", "OR"] as const satisfies readonly RuleOperator[];
export interface RuleBuilderDraft {
  id?: string;
  name: string;
  rootOperator: RuleOperator;
  groups: RuleConditionGroup[];
  purpose: Purpose;
  lifecycle: Lifecycle;
  weight: number;
  now: string;
}

export function buildRuleFromBuilderDraft(draft: RuleBuilderDraft): Rule {
  return {
    id: draft.id ?? localId("rule"),
    name: draft.name,
    source: "user",
    enabled: true,
    priority: 75,
    weight: draft.weight,
    root_operator: draft.rootOperator,
    groups: draft.groups.map((group) => ({
      ...group,
      conditions: group.conditions.map((condition) => ({ ...condition }))
    })),
    action: {
      purpose: draft.purpose,
      lifecycle: draft.lifecycle,
      suggested_action: "Move",
      target_template: "00_Inbox/Screenshots",
      context: "Screenshots"
    },
    created_at: draft.now,
    updated_at: draft.now
  };
}

export function createRuleCondition(overrides: Partial<RuleCondition> = {}): RuleCondition {
  return {
    id: localId("cond"),
    field: "name",
    operator: "contains",
    value: "screenshot",
    ...overrides
  };
}

export function createRuleGroup(conditionOverrides: Partial<RuleCondition> = {}): RuleConditionGroup {
  return {
    id: localId("group"),
    operator: "AND",
    conditions: [createRuleCondition(conditionOverrides)]
  };
}

