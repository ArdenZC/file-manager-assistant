import os from "node:os";
import path from "node:path";
import type {
  FileRecord,
  Lifecycle,
  Purpose,
  RiskLevel,
  Rule,
  RuleAction,
  RuleCondition,
  RuleConditionGroup,
  SuggestedAction
} from "../types/domain.js";
import { nowIso } from "./id.js";

const careerWords = ["resume", "cv", "cover letter", "portfolio", "interview"];
const financeWords = ["invoice", "receipt", "bill", "tax", "payment", "bank", "paypal"];
const identityWords = ["passport", "visa", "id", "identity", "private", "身份证", "护照", "银行卡"];
const studyWords = ["course", "lecture", "assignment", "report", "paper", "comp", "math", "cs"];
const tempWords = ["temp", "tmp", "copy", "副本", "screenshot", "screen shot"];

export const builtInRules: Rule[] = [
  makeSystemRule("system_identity", "Sensitive identity documents", 100, 95, "OR", [
    condition("name", "contains", "passport"),
    condition("name", "contains", "visa"),
    condition("name", "contains", "身份证"),
    condition("path", "contains", "identity")
  ], {
    purpose: "Identity",
    lifecycle: "Sensitive",
    risk_level: "Sensitive",
    suggested_action: "Review",
    target_template: "20_Areas/Personal/Identity",
    context: "Identity"
  }),
  makeSystemRule("system_career", "Career and resume files", 90, 84, "OR", [
    condition("name", "contains", "resume"),
    condition("name", "contains", "cv"),
    condition("name", "contains", "cover letter"),
    condition("path", "contains", "career")
  ], {
    purpose: "Career",
    lifecycle: "Reference",
    risk_level: "Normal",
    suggested_action: "Move",
    target_template: "20_Areas/Career",
    context: "Career"
  }),
  makeSystemRule("system_finance", "Finance and receipt files", 80, 80, "OR", [
    condition("name", "contains", "invoice"),
    condition("name", "contains", "receipt"),
    condition("name", "contains", "tax"),
    condition("path", "contains", "bank")
  ], {
    purpose: "Finance",
    lifecycle: "Reference",
    risk_level: "Sensitive",
    suggested_action: "Review",
    target_template: "20_Areas/Finance",
    context: "Finance"
  }),
  makeSystemRule("system_study", "Study material and coursework", 70, 70, "OR", [
    condition("name", "contains", "assignment"),
    condition("name", "contains", "lecture"),
    condition("name", "contains", "paper"),
    condition("name", "contains", "comp")
  ], {
    purpose: "Study",
    lifecycle: "Active",
    risk_level: "Normal",
    suggested_action: "Move",
    target_template: "20_Areas/Study",
    context: "Study"
  }),
  makeSystemRule("system_installer", "Installers and setup packages", 60, 68, "OR", [
    condition("file_type", "equals", "Installer"),
    condition("name", "contains", "setup"),
    condition("name", "contains", "installer")
  ], {
    purpose: "Installer",
    lifecycle: "Disposable",
    risk_level: "Normal",
    suggested_action: "Review",
    target_template: "90_Temporary/Installers",
    context: "Installer"
  }),
  makeSystemRule("system_inbox_downloads", "Downloads and desktop inbox", 50, 62, "OR", [
    condition("directory", "contains", "downloads"),
    condition("directory", "contains", "desktop")
  ], {
    purpose: "Temporary",
    lifecycle: "Inbox",
    risk_level: "Normal",
    suggested_action: "Move",
    target_template: "00_Inbox",
    context: "Inbox"
  })
];

export function applyAllRulesToFiles(files: FileRecord[], userRules: Rule[] = []): FileRecord[] {
  const enabledUserRules = userRules.filter((rule) => rule.enabled);
  return markDuplicates(files).map((file) => classifyFile(file, enabledUserRules));
}

export function classifyFile(file: FileRecord, userRules: Rule[] = []): FileRecord {
  const builtin = classifyBuiltIn(file);
  const candidates = [...builtInRules, ...userRules]
    .filter((rule) => rule.enabled)
    .map((rule) => scoreRule(rule, file))
    .filter((result) => result.matches)
    .sort((a, b) => b.score - a.score || b.rule.priority - a.rule.priority);

  const top = candidates[0];
  const runnerUp = candidates[1];
  const hasConflict = Boolean(top && runnerUp && top.score - runnerUp.score <= 10);
  const action = top ? mergeAction(builtin, top.rule.action) : builtin;
  const matchedRules = candidates.map((candidate) => candidate.rule.name);
  const confidence = top ? Math.min(0.98, Math.max(0.35, top.score / 100)) : builtin.confidence;
  const riskLevel: RiskLevel = action.risk_level ?? builtin.risk_level ?? "Unknown";
  const requiresConfirmation =
    riskLevel === "Sensitive" ||
    hasConflict ||
    confidence < 0.65 ||
    action.suggested_action === "Review" ||
    action.suggested_action === "DeleteCandidate";

  return {
    ...file,
    purpose: action.purpose ?? file.purpose,
    lifecycle: action.lifecycle ?? file.lifecycle,
    context: action.context ?? file.context,
    risk_level: riskLevel,
    suggested_action: safeAction(action.suggested_action ?? file.suggested_action, riskLevel),
    suggested_target_path: buildTargetPath(file, action.target_template),
    suggested_name: buildSuggestedName(file, action.rename_template),
    confidence,
    classification_reason: buildReason(file, matchedRules, hasConflict, action),
    matched_rules: matchedRules,
    requires_confirmation: requiresConfirmation,
    last_seen_at: nowIso()
  };
}

function classifyBuiltIn(file: FileRecord): RuleAction & { confidence: number } {
  const haystack = `${file.name} ${file.path}`.toLowerCase();
  const ageDays = daysSince(file.modified_at);

  if (identityWords.some((word) => haystack.includes(word))) {
    return {
      purpose: "Identity",
      lifecycle: "Sensitive",
      risk_level: "Sensitive",
      suggested_action: "Review",
      target_template: "20_Areas/Personal/Identity",
      context: "Identity",
      confidence: 0.92
    };
  }

  if (careerWords.some((word) => haystack.includes(word))) {
    return {
      purpose: "Career",
      lifecycle: "Reference",
      risk_level: "Normal",
      suggested_action: "Move",
      target_template: "20_Areas/Career",
      context: "Career",
      confidence: 0.84
    };
  }

  if (financeWords.some((word) => haystack.includes(word))) {
    return {
      purpose: "Finance",
      lifecycle: "Reference",
      risk_level: "Sensitive",
      suggested_action: "Review",
      target_template: "20_Areas/Finance",
      context: "Finance",
      confidence: 0.78
    };
  }

  if (studyWords.some((word) => haystack.includes(word))) {
    return {
      purpose: "Study",
      lifecycle: ageDays <= 30 ? "Active" : "Archive",
      risk_level: "Normal",
      suggested_action: "Move",
      target_template: ageDays <= 30 ? "20_Areas/Study" : "40_Archive/{year}/Study",
      context: extractStudyContext(file.name),
      confidence: 0.72
    };
  }

  if (file.file_type === "Installer") {
    return {
      purpose: "Installer",
      lifecycle: "Disposable",
      risk_level: "Normal",
      suggested_action: "Review",
      target_template: "90_Temporary/Installers",
      context: "Installer",
      confidence: 0.68
    };
  }

  if (tempWords.some((word) => haystack.includes(word)) || isInboxDirectory(file.directory)) {
    return {
      purpose: file.file_type === "Image" ? "Media" : "Temporary",
      lifecycle: "Inbox",
      risk_level: "Normal",
      suggested_action: file.file_type === "Image" ? "Rename" : "Move",
      target_template: "00_Inbox",
      rename_template: file.file_type === "Image" ? "{basename}_{date}" : undefined,
      context: "Inbox",
      confidence: 0.62
    };
  }

  return {
    purpose: "Unknown",
    lifecycle: ageDays <= 14 ? "Active" : "Reference",
    risk_level: "Unknown",
    suggested_action: "Keep",
    target_template: "",
    context: "",
    confidence: 0.45
  };
}

function scoreRule(rule: Rule, file: FileRecord): { rule: Rule; matches: boolean; score: number } {
  const groupResults = rule.groups.map((group) => evaluateGroup(group, file));
  const matches =
    rule.root_operator === "AND" ? groupResults.every(Boolean) : groupResults.some(Boolean);
  return { rule, matches, score: matches ? rule.weight + rule.priority * 0.1 : 0 };
}

function evaluateGroup(group: RuleConditionGroup, file: FileRecord): boolean {
  const results = group.conditions.map((conditionItem) => evaluateCondition(conditionItem, file));
  return group.operator === "AND" ? results.every(Boolean) : results.some(Boolean);
}

function evaluateCondition(conditionItem: RuleCondition, file: FileRecord): boolean {
  const raw = String(getConditionValue(conditionItem.field, file) ?? "").toLowerCase();
  const expected = String(conditionItem.value).toLowerCase();

  switch (conditionItem.operator) {
    case "contains":
      return raw.includes(expected);
    case "equals":
    case "is":
      return raw === expected;
    case "startsWith":
      return raw.startsWith(expected);
    case "endsWith":
      return raw.endsWith(expected);
    case "greaterThan":
      return Number(raw) > Number(conditionItem.value);
    case "lessThan":
      return Number(raw) < Number(conditionItem.value);
    case "olderThanDays":
      return daysSince(String(getConditionValue("modified_at", file))) > Number(conditionItem.value);
    case "newerThanDays":
      return daysSince(String(getConditionValue("modified_at", file))) < Number(conditionItem.value);
    default:
      return false;
  }
}

function getConditionValue(field: RuleCondition["field"], file: FileRecord): unknown {
  if (field === "directory") return file.directory;
  if (field === "extension") return file.extension;
  if (field === "file_type") return file.file_type;
  if (field === "is_duplicate") return file.is_duplicate;
  if (field === "modified_at") return file.modified_at;
  if (field === "name") return file.name;
  if (field === "path") return file.path;
  if (field === "risk_level") return file.risk_level;
  if (field === "size") return file.size;
  return "";
}

function mergeAction(base: RuleAction, override: RuleAction): RuleAction & { confidence: number } {
  return { ...base, ...override, confidence: "confidence" in base ? base.confidence as number : 0.5 };
}

function buildReason(
  file: FileRecord,
  matchedRules: string[],
  hasConflict: boolean,
  action: RuleAction
): string {
  const reasonParts = matchedRules.length
    ? [`Matched ${matchedRules.slice(0, 3).join(", ")}`]
    : ["No strong rule matched"];
  if (hasConflict) reasonParts.push("similar rule scores require review");
  if (action.risk_level === "Sensitive") reasonParts.push("sensitive files require manual confirmation");
  if (file.is_duplicate) reasonParts.push("duplicate content group detected");
  return reasonParts.join("; ");
}

function safeAction(action: SuggestedAction, riskLevel: RiskLevel): SuggestedAction {
  if (riskLevel === "Sensitive" && action !== "Keep") return "Review";
  if (action === "DeleteCandidate") return "Review";
  return action;
}

function buildTargetPath(file: FileRecord, template?: string): string {
  if (!template) return "";
  const year = new Date(file.modified_at).getFullYear().toString();
  const resolved = template.replace("{year}", year).replace("{type}", file.file_type);
  return path.join(os.homedir(), "FileAssistant", resolved);
}

function buildSuggestedName(file: FileRecord, template?: string): string {
  if (!template) return file.name;
  const parsed = path.parse(file.name);
  const date = new Date(file.modified_at).toISOString().slice(0, 10).replaceAll("-", "");
  return `${template
    .replace("{basename}", cleanName(parsed.name))
    .replace("{date}", date)
    .replace("{extension}", file.extension)}${parsed.ext}`;
}

function cleanName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "_")
    .replace(/^_+|_+$/g, "");
}

function markDuplicates(files: FileRecord[]): FileRecord[] {
  const bySize = new Map<number, FileRecord[]>();
  for (const file of files) {
    const bucket = bySize.get(file.size) ?? [];
    bucket.push(file);
    bySize.set(file.size, bucket);
  }

  return files.map((file) => {
    const bucket = bySize.get(file.size) ?? [];
    return { ...file, is_duplicate: file.size > 0 && bucket.length > 1 };
  });
}

function isInboxDirectory(directory: string): boolean {
  const normalized = directory.toLowerCase();
  return normalized.includes("downloads") || normalized.includes("desktop");
}

function extractStudyContext(name: string): string {
  const course = name.match(/\b[A-Z]{2,5}\d{3,5}\b/i);
  return course ? course[0].toUpperCase() : "Study";
}

function daysSince(dateIso: string): number {
  const timestamp = new Date(dateIso).getTime();
  if (Number.isNaN(timestamp)) return 0;
  return Math.floor((Date.now() - timestamp) / 86_400_000);
}

function makeSystemRule(
  id: string,
  name: string,
  priority: number,
  weight: number,
  groupOperator: "AND" | "OR",
  conditions: RuleCondition[],
  action: RuleAction
): Rule {
  const now = nowIso();
  return {
    id,
    name,
    source: "system",
    enabled: true,
    priority,
    weight,
    root_operator: "OR",
    groups: [{ id: `${id}_group`, operator: groupOperator, conditions }],
    action,
    created_at: now,
    updated_at: now
  };
}

function condition(
  field: RuleCondition["field"],
  operator: RuleCondition["operator"],
  value: RuleCondition["value"]
): RuleCondition {
  return { id: `${field}_${operator}_${String(value)}`, field, operator, value };
}
