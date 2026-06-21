import { memo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { Plus, Trash2 } from "lucide-react";
import type { Lifecycle, Purpose, Rule, RuleCondition, RuleConditionGroup, RuleOperator } from "../../types/domain";
import type { Translator } from "../../types/ui";
import { nowIso } from "../../utils/viewHelpers";
import { shouldVirtualizeList } from "../../utils/virtualization";
import { cn, glassButton, glassButtonPrimary, inputSurface, selectSurface, virtualList, virtualRow as virtualRowClass, virtualSpacer } from "../../utils/tw";
import { compactRowSurface, formGrid, itemMotion, listMotion, pageSurface, panelSurface, quietText, segmented, segmentButton, sourceBadge, toggleSwitch, SectionTitle } from "../shared/ui";
import {
  RULE_FIELD_OPTIONS,
  RULE_LIFECYCLE_OPTIONS,
  RULE_LOGIC_OPTIONS,
  RULE_OPERATOR_OPTIONS,
  RULE_PURPOSE_OPTIONS,
  buildRuleFromBuilderDraft,
  createRuleCondition,
  createRuleGroup
} from "./ruleBuilder";

const RULE_ROW_HEIGHT = 68;

export function RulesView({
  rules,
  onSave,
  onToggleRuleEnabled,
  onDeleteRule,
  t
}: {
  rules: Rule[];
  onSave: (rule: Rule) => Promise<void>;
  onToggleRuleEnabled?: (rule: Rule, enabled: boolean) => Promise<void> | void;
  onDeleteRule?: (rule: Rule) => Promise<void> | void;
  t: Translator;
}) {
  const [name, setName] = useState("Screenshots to Inbox");
  const [rootOperator, setRootOperator] = useState<RuleOperator>("AND");
  const [groups, setGroups] = useState<RuleConditionGroup[]>(() => [createRuleGroup()]);
  const [purpose, setPurpose] = useState<Purpose>("Temporary");
  const [lifecycle, setLifecycle] = useState<Lifecycle>("Inbox");
  const [weight, setWeight] = useState(76);

  function updateGroupOperator(groupId: string, nextOperator: RuleOperator) {
    setGroups((current) =>
      current.map((group) => (group.id === groupId ? { ...group, operator: nextOperator } : group))
    );
  }

  function updateCondition(groupId: string, conditionId: string, patch: Partial<RuleCondition>) {
    setGroups((current) =>
      current.map((group) =>
        group.id === groupId
          ? {
              ...group,
              conditions: group.conditions.map((condition) =>
                condition.id === conditionId ? { ...condition, ...patch } : condition
              )
            }
          : group
      )
    );
  }

  function addCondition(groupId: string) {
    setGroups((current) =>
      current.map((group) =>
        group.id === groupId
          ? { ...group, conditions: [...group.conditions, createRuleCondition({ value: "" })] }
          : group
      )
    );
  }

  function removeCondition(groupId: string, conditionId: string) {
    setGroups((current) =>
      current.map((group) =>
        group.id === groupId && group.conditions.length > 1
          ? { ...group, conditions: group.conditions.filter((condition) => condition.id !== conditionId) }
          : group
      )
    );
  }

  function addGroup() {
    setGroups((current) => [...current, createRuleGroup({ value: "" })]);
  }

  function removeGroup(groupId: string) {
    setGroups((current) =>
      current.length > 1 ? current.filter((group) => group.id !== groupId) : current
    );
  }

  async function submit() {
    const now = nowIso();
    await onSave(buildRuleFromBuilderDraft({
      name,
      rootOperator,
      groups,
      purpose,
      lifecycle,
      weight,
      now
    }));
  }

  return (
    <div className={cn(pageSurface, "grid grid-cols-[minmax(360px,0.9fr)_minmax(0,1.1fr)] gap-4 overflow-hidden")}>
      <section className={panelSurface}>
        <SectionTitle title={t("ruleBuilder")} body={t("customDesc")} />
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--line)] bg-white/25 p-3 text-sm dark:bg-white/5">
          <span>{t("whenFile")}</span>
          <strong className="rounded-full bg-blue-500/10 px-2 py-1 text-blue-600 dark:text-blue-300">{groups.length} {t("ruleGroups")}</strong>
          <strong className="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-600 dark:text-emerald-300">{rootOperator}</strong>
          <span>{t("thenSendTo")}</span>
          <strong className="rounded-full bg-violet-500/10 px-2 py-1 text-violet-600 dark:text-violet-300">{purpose}</strong>
        </div>
        <div className={formGrid}>
          <label>{t("ruleName")}<input className={inputSurface} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <div className="grid gap-1.5 text-sm font-medium text-[var(--muted)]">
            <span>{t("rootOperator")}</span>
            <div className={segmented} role="group" aria-label={t("rootOperator")}>
              {RULE_LOGIC_OPTIONS.map((item) => (
                <button key={item} type="button" className={segmentButton(rootOperator === item)} onClick={() => setRootOperator(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
          <label>{t("purpose")}<select className={selectSurface} value={purpose} onChange={(event) => setPurpose(event.target.value as Purpose)}>{RULE_PURPOSE_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>{t("lifecycle")}<select className={selectSurface} value={lifecycle} onChange={(event) => setLifecycle(event.target.value as Lifecycle)}>{RULE_LIFECYCLE_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>{t("weight")}<input className={inputSurface} type="number" value={weight} onChange={(event) => setWeight(Number(event.target.value))} /></label>
        </div>
        <div className="mt-4 grid gap-3">
          {groups.map((group, groupIndex) => (
            <div key={group.id} className="rounded-2xl border border-[var(--line)] bg-white/25 p-3 shadow-sm dark:bg-white/5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <strong className="block text-sm">{t("ruleGroup")} {groupIndex + 1}</strong>
                  <span className={quietText}>{group.conditions.length} {t("conditions")}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={quietText}>{t("groupOperator")}</span>
                  <div className={segmented} role="group" aria-label={`${t("ruleGroup")} ${groupIndex + 1} ${t("groupOperator")}`}>
                    {RULE_LOGIC_OPTIONS.map((item) => (
                      <button key={item} type="button" className={segmentButton(group.operator === item)} onClick={() => updateGroupOperator(group.id, item)}>
                        {item}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] text-[var(--muted)] transition hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--line)] disabled:hover:bg-transparent disabled:hover:text-[var(--muted)] dark:hover:text-red-300"
                    disabled={groups.length <= 1}
                    aria-label={t("deleteGroup")}
                    title={t("deleteGroup")}
                    onClick={() => removeGroup(group.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <div className="grid gap-2">
                {group.conditions.map((condition) => (
                  <div key={condition.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-2">
                    <select
                      className={selectSurface}
                      value={condition.field}
                      aria-label={t("field")}
                      onChange={(event) => updateCondition(group.id, condition.id, { field: event.target.value as RuleCondition["field"] })}
                    >
                      {RULE_FIELD_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                    <select
                      className={selectSurface}
                      value={condition.operator}
                      aria-label={t("operator")}
                      onChange={(event) => updateCondition(group.id, condition.id, { operator: event.target.value as RuleCondition["operator"] })}
                    >
                      {RULE_OPERATOR_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                    <input
                      className={inputSurface}
                      value={String(condition.value)}
                      aria-label={t("value")}
                      onChange={(event) => updateCondition(group.id, condition.id, { value: event.target.value })}
                    />
                    <button
                      type="button"
                      className="grid h-10 w-10 place-items-center rounded-lg border border-[var(--line)] text-[var(--muted)] transition hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--line)] disabled:hover:bg-transparent disabled:hover:text-[var(--muted)] dark:hover:text-red-300"
                      disabled={group.conditions.length <= 1}
                      aria-label={t("deleteCondition")}
                      title={t("deleteCondition")}
                      onClick={() => removeCondition(group.id, condition.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className={cn(glassButton, "mt-3")} onClick={() => addCondition(group.id)}>
                <Plus size={15} />
                {t("addCondition")}
              </button>
            </div>
          ))}
          <button type="button" className={glassButton} onClick={addGroup}>
            <Plus size={15} />
            {t("addGroup")}
          </button>
        </div>
        <button className={cn(glassButtonPrimary, "mt-4")} onClick={submit}>
          <Plus size={17} />
          {t("saveRule")}
        </button>
      </section>

      <section className={cn(panelSurface, "overflow-hidden")}>
        <SectionTitle title={t("strategy")} body={t("ruleLayerDesc")} />
        <VirtualRuleList
          rules={rules}
          onToggleRuleEnabled={onToggleRuleEnabled}
          onDeleteRule={onDeleteRule}
          t={t}
        />
      </section>
    </div>
  );
}

function VirtualRuleList({
  rules,
  onToggleRuleEnabled,
  onDeleteRule,
  t
}: {
  rules: Rule[];
  onToggleRuleEnabled?: (rule: Rule, enabled: boolean) => Promise<void> | void;
  onDeleteRule?: (rule: Rule) => Promise<void> | void;
  t: Translator;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = shouldVirtualizeList(rules.length);
  const rowVirtualizer = useVirtualizer({
    count: rules.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => RULE_ROW_HEIGHT,
    overscan: 8
  });

  if (!shouldVirtualize) {
    return (
      <motion.div className="grid gap-2" variants={listMotion} initial="hidden" animate="show">
        {rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            onToggleEnabled={onToggleRuleEnabled}
            onDeleteRule={onDeleteRule}
            t={t}
          />
        ))}
      </motion.div>
    );
  }

  return (
    <div ref={parentRef} className={cn("h-[calc(100vh-260px)]", virtualList)}>
      <div className={virtualSpacer} style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const rule = rules[virtualRow.index];
          return (
            <div
              className={virtualRowClass}
              key={rule.id}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <RuleRow
                rule={rule}
                onToggleEnabled={onToggleRuleEnabled}
                onDeleteRule={onDeleteRule}
                t={t}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RuleRow = memo(function RuleRow({
  rule,
  onToggleEnabled,
  onDeleteRule,
  t
}: {
  rule: Rule;
  onToggleEnabled?: (rule: Rule, enabled: boolean) => Promise<void> | void;
  onDeleteRule?: (rule: Rule) => Promise<void> | void;
  t: Translator;
}) {
  const canToggle = rule.source === "user" && Boolean(onToggleEnabled);
  const canDelete = rule.source === "user" && Boolean(onDeleteRule);
  const toggleLabel = canToggle
    ? rule.enabled
      ? t("disableRule")
      : t("enableRule")
    : t("systemRuleLocked");
  const deleteLabel = canDelete ? t("deleteRule") : t("systemRuleCannotDelete");

  return (
    <motion.div className={cn(compactRowSurface, "grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3")} layout variants={itemMotion}>
      <div>
        <strong className="block truncate text-sm">{rule.name}</strong>
        <span className="block text-xs text-[var(--muted)]">{rule.source} / weight {rule.weight} / priority {rule.priority}</span>
      </div>
      <span className={sourceBadge(rule.source)}>{rule.source}</span>
      <button
        type="button"
        className={toggleSwitch(rule.enabled)}
        disabled={!canToggle}
        aria-pressed={rule.enabled}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={(event) => {
          event.stopPropagation();
          if (!canToggle) return;
          void onToggleEnabled?.(rule, !rule.enabled);
        }}
      >
        <i />
      </button>
      <button
        type="button"
        className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] text-[var(--muted)] transition hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--line)] disabled:hover:bg-transparent disabled:hover:text-[var(--muted)] dark:hover:text-red-300"
        disabled={!canDelete}
        aria-label={deleteLabel}
        title={deleteLabel}
        onClick={(event) => {
          event.stopPropagation();
          if (!canDelete || !window.confirm(t("confirmDeleteRule"))) return;
          void onDeleteRule?.(rule);
        }}
      >
        <Trash2 size={15} />
      </button>
    </motion.div>
  );
});

