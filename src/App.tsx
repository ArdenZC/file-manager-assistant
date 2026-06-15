import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Files,
  FolderSearch,
  Languages,
  LayoutDashboard,
  ListChecks,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  SlidersHorizontal
} from "lucide-react";
import type {
  AppSnapshot,
  FileQuery,
  FileRecord,
  OperationPreview,
  Rule
} from "./types/domain";
import { formatBytes, formatDate, percent } from "./utils/format";
import { type Language, makeTranslator } from "./i18n";

type View = "dashboard" | "files" | "rules" | "preview" | "operations" | "settings";

const demoFiles = createDemoFiles();
const demoSnapshot: AppSnapshot = {
  stats: {
    totalFiles: demoFiles.length,
    totalSize: demoFiles.reduce((sum, file) => sum + file.size, 0),
    duplicateFiles: demoFiles.filter((file) => file.is_duplicate).length,
    largeFiles: 0,
    sensitiveFiles: demoFiles.filter((file) => file.risk_level === "Sensitive").length,
    needsConfirmation: demoFiles.filter((file) => file.requires_confirmation).length,
    byType: Object.fromEntries(
      Object.entries(
        demoFiles.reduce<Record<string, number>>((acc, file) => {
          acc[file.file_type] = (acc[file.file_type] ?? 0) + 1;
          return acc;
        }, {})
      )
    ),
    byLifecycle: demoFiles.reduce<Record<string, number>>((acc, file) => {
      acc[file.lifecycle] = (acc[file.lifecycle] ?? 0) + 1;
      return acc;
    }, {}),
    lastScannedAt: null
  },
  files: demoFiles,
  rules: createDemoRules(),
  operations: [],
  scanRoots: []
};

export function App() {
  const [language, setLanguage] = useState<Language>("zh");
  const t = useMemo(() => makeTranslator(language), [language]);
  const [view, setView] = useState<View>("dashboard");
  const [snapshot, setSnapshot] = useState<AppSnapshot>(demoSnapshot);
  const [query, setQuery] = useState<FileQuery>({ fileType: "All", purpose: "All", riskLevel: "All" });
  const [selectedFileId, setSelectedFileId] = useState<string>(demoFiles[0]?.id ?? "");
  const [selectedOperationIds, setSelectedOperationIds] = useState<Set<string>>(new Set());
  const [isScanning, setIsScanning] = useState(false);
  const [status, setStatus] = useState("");

  const hasNativeApi = typeof window.fileManager !== "undefined";

  useEffect(() => {
    if (!hasNativeApi) return;
    window.fileManager.getSnapshot().then((next) => {
      if (next.files.length) {
        setSnapshot(next);
        setSelectedFileId(next.files[0]?.id ?? "");
      }
    });
  }, [hasNativeApi]);

  const filteredFiles = useMemo(() => filterFiles(snapshot.files, query), [snapshot.files, query]);
  const selectedFile = snapshot.files.find((file) => file.id === selectedFileId) ?? filteredFiles[0];
  const previews = useMemo(() => createOperationPreviews(snapshot.files), [snapshot.files]);

  async function handleScan() {
    setIsScanning(true);
    try {
      if (hasNativeApi) {
        await window.fileManager.scanDefaults();
        const next = await window.fileManager.getSnapshot();
        setSnapshot(next);
        setSelectedFileId(next.files[0]?.id ?? "");
        setStatus(`${t("success")}: ${next.files.length}`);
      } else {
        setSnapshot(demoSnapshot);
        setStatus(t("demoMode"));
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsScanning(false);
    }
  }

  async function saveRule(rule: Rule) {
    if (hasNativeApi) {
      await window.fileManager.saveRule(rule);
      const next = await window.fileManager.reapplyRules();
      setSnapshot(next);
    } else {
      setSnapshot((current) => ({ ...current, rules: [...current.rules, rule] }));
    }
  }

  async function executeSelected() {
    const operations = previews.filter((preview) => selectedOperationIds.has(preview.id));
    if (!operations.length) return;
    if (hasNativeApi) {
      await window.fileManager.executeOperations({ operations });
      const next = await window.fileManager.getSnapshot();
      setSnapshot(next);
    }
    setSelectedOperationIds(new Set());
  }

  const nav = [
    { id: "dashboard" as const, label: t("dashboard"), icon: LayoutDashboard },
    { id: "files" as const, label: t("files"), icon: Files },
    { id: "rules" as const, label: t("rules"), icon: SlidersHorizontal },
    { id: "preview" as const, label: t("preview"), icon: ListChecks },
    { id: "operations" as const, label: t("operations"), icon: Archive },
    { id: "settings" as const, label: t("settings"), icon: Settings }
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><FolderSearch size={22} /></div>
          <div>
            <div className="brand-title">{t("appName")}</div>
            <div className="brand-subtitle">{t("appSubtitle")}</div>
          </div>
        </div>
        <nav className="nav-list">
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              aria-label={item.label}
              onClick={() => setView(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="privacy-panel">
          <Shield size={18} />
          <div>
            <strong>{t("localOnly")}</strong>
            <span>{t("scanRoots")}</span>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{nav.find((item) => item.id === view)?.label}</h1>
            <p>{snapshot.stats.lastScannedAt ? `${t("lastScan")}: ${formatDate(snapshot.stats.lastScannedAt)}` : t("demoMode")}</p>
          </div>
          <div className="topbar-actions">
            <button className="ghost-button" onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>
              <Languages size={17} /> {language === "zh" ? "EN" : "中文"}
            </button>
            <button className="primary-button" onClick={handleScan} disabled={isScanning}>
              <RefreshCw size={17} className={isScanning ? "spin" : ""} />
              {isScanning ? t("scanning") : t("scan")}
            </button>
          </div>
        </header>

        {status && <div className="status-line">{status}</div>}

        {view === "dashboard" && (
          <Dashboard snapshot={snapshot} t={t} selectedFile={selectedFile} setView={setView} />
        )}
        {view === "files" && (
          <FilesView
            files={filteredFiles}
            selectedFile={selectedFile}
            query={query}
            setQuery={setQuery}
            setSelectedFileId={setSelectedFileId}
            t={t}
          />
        )}
        {view === "rules" && <RulesView rules={snapshot.rules} onSave={saveRule} t={t} />}
        {view === "preview" && (
          <PreviewView
            previews={previews}
            selectedIds={selectedOperationIds}
            setSelectedIds={setSelectedOperationIds}
            executeSelected={executeSelected}
            t={t}
          />
        )}
        {view === "operations" && <OperationsView snapshot={snapshot} t={t} />}
        {view === "settings" && <SettingsView language={language} setLanguage={setLanguage} t={t} />}
      </main>
    </div>
  );
}

function Dashboard({
  snapshot,
  selectedFile,
  setView,
  t
}: {
  snapshot: AppSnapshot;
  selectedFile?: FileRecord;
  setView: (view: View) => void;
  t: ReturnType<typeof makeTranslator>;
}) {
  const metrics = [
    { label: t("totalFiles"), value: snapshot.stats.totalFiles.toLocaleString(), icon: Files },
    { label: t("totalSize"), value: formatBytes(snapshot.stats.totalSize), icon: Archive },
    { label: t("duplicates"), value: snapshot.stats.duplicateFiles.toString(), icon: AlertTriangle },
    { label: t("sensitive"), value: snapshot.stats.sensitiveFiles.toString(), icon: Shield },
    { label: t("needsReview"), value: snapshot.stats.needsConfirmation.toString(), icon: ListChecks }
  ];
  return (
    <div className="grid dashboard-grid">
      <section className="panel metrics-panel">
        {metrics.map((metric) => (
          <div className="metric" key={metric.label}>
            <metric.icon size={18} />
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </section>
      <section className="panel strategy-panel">
        <div className="section-heading">
          <h2>{t("strategy")}</h2>
          <button className="text-button" onClick={() => setView("rules")}>{t("customRules")}</button>
        </div>
        <div className="strategy-cards">
          <div className="strategy-card selected">
            <CheckCircle2 size={18} />
            <strong>{t("builtInRules")}</strong>
            <span>{t("builtInDesc")}</span>
          </div>
          <div className="strategy-card">
            <Plus size={18} />
            <strong>{t("customRules")}</strong>
            <span>{t("customDesc")}</span>
          </div>
        </div>
      </section>
      <ChartPanel title={t("lifecycle")} data={snapshot.stats.byLifecycle} />
      <ChartPanel title={t("typeMix")} data={snapshot.stats.byType} />
      <Inspector file={selectedFile} t={t} />
    </div>
  );
}

function FilesView({
  files,
  selectedFile,
  query,
  setQuery,
  setSelectedFileId,
  t
}: {
  files: FileRecord[];
  selectedFile?: FileRecord;
  query: FileQuery;
  setQuery: (query: FileQuery) => void;
  setSelectedFileId: (id: string) => void;
  t: ReturnType<typeof makeTranslator>;
}) {
  return (
    <div className="split-view">
      <section className="panel table-panel">
        <div className="toolbar">
          <input
            className="search-input"
            placeholder={t("search")}
            value={query.search ?? ""}
            onChange={(event) => setQuery({ ...query, search: event.target.value })}
          />
          <select value={query.fileType ?? "All"} onChange={(event) => setQuery({ ...query, fileType: event.target.value as FileQuery["fileType"] })}>
            {["All", "Document", "Image", "Video", "Code", "Installer", "ArchivePackage", "Other"].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <label className="check-control">
            <input
              type="checkbox"
              checked={Boolean(query.onlyNeedsConfirmation)}
              onChange={(event) => setQuery({ ...query, onlyNeedsConfirmation: event.target.checked })}
            />
            {t("needsReview")}
          </label>
        </div>
        <FileTable files={files} onSelect={setSelectedFileId} selectedId={selectedFile?.id} t={t} />
      </section>
      <Inspector file={selectedFile} t={t} />
    </div>
  );
}

function FileTable({
  files,
  selectedId,
  onSelect,
  t
}: {
  files: FileRecord[];
  selectedId?: string;
  onSelect: (id: string) => void;
  t: ReturnType<typeof makeTranslator>;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t("files")}</th>
            <th>{t("purpose")}</th>
            <th>{t("lifecycle")}</th>
            <th>{t("risk")}</th>
            <th>{t("action")}</th>
            <th>{t("confidence")}</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.id} className={selectedId === file.id ? "selected-row" : ""} onClick={() => onSelect(file.id)}>
              <td>
                <strong>{file.name}</strong>
                <span>{formatBytes(file.size)} · {file.file_type}</span>
              </td>
              <td>{file.purpose}</td>
              <td><span className="token">{file.lifecycle}</span></td>
              <td><RiskBadge risk={file.risk_level} /></td>
              <td>{file.suggested_action}</td>
              <td>{percent(file.confidence)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RulesView({
  rules,
  onSave,
  t
}: {
  rules: Rule[];
  onSave: (rule: Rule) => Promise<void>;
  t: ReturnType<typeof makeTranslator>;
}) {
  const [name, setName] = useState("Screenshots to Inbox");
  const [field, setField] = useState("name");
  const [operator, setOperator] = useState("contains");
  const [value, setValue] = useState("screenshot");
  const [purpose, setPurpose] = useState("Temporary");
  const [lifecycle, setLifecycle] = useState("Inbox");
  const [weight, setWeight] = useState(76);

  async function submit() {
    const now = nowIso();
    await onSave({
      id: localId("rule"),
      name,
      source: "user",
      enabled: true,
      priority: 75,
      weight,
      root_operator: "AND",
      groups: [
        {
          id: localId("group"),
          operator: "AND",
          conditions: [
            {
              id: localId("cond"),
              field: field as Rule["groups"][number]["conditions"][number]["field"],
              operator: operator as Rule["groups"][number]["conditions"][number]["operator"],
              value
            }
          ]
        }
      ],
      action: {
        purpose: purpose as Rule["action"]["purpose"],
        lifecycle: lifecycle as Rule["action"]["lifecycle"],
        suggested_action: "Move",
        target_template: "00_Inbox/Screenshots",
        context: "Screenshots"
      },
      created_at: now,
      updated_at: now
    });
  }

  return (
    <div className="split-view">
      <section className="panel rule-builder">
        <h2>{t("ruleBuilder")}</h2>
        <div className="form-grid">
          <label>{t("ruleName")}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>{t("field")}<select value={field} onChange={(event) => setField(event.target.value)}>
            {["name", "extension", "file_type", "path", "directory", "size", "modified_at", "risk_level"].map((item) => <option key={item}>{item}</option>)}
          </select></label>
          <label>{t("operator")}<select value={operator} onChange={(event) => setOperator(event.target.value)}>
            {["contains", "equals", "startsWith", "endsWith", "greaterThan", "lessThan", "olderThanDays", "newerThanDays"].map((item) => <option key={item}>{item}</option>)}
          </select></label>
          <label>{t("value")}<input value={value} onChange={(event) => setValue(event.target.value)} /></label>
          <label>{t("purpose")}<select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
            {["Temporary", "Career", "Finance", "Study", "Project", "Personal", "Media", "Unknown"].map((item) => <option key={item}>{item}</option>)}
          </select></label>
          <label>{t("lifecycle")}<select value={lifecycle} onChange={(event) => setLifecycle(event.target.value)}>
            {["Inbox", "Active", "Reference", "Archive", "Disposable", "Sensitive"].map((item) => <option key={item}>{item}</option>)}
          </select></label>
          <label>{t("weight")}<input type="number" value={weight} onChange={(event) => setWeight(Number(event.target.value))} /></label>
        </div>
        <button className="primary-button" onClick={submit}><Plus size={17} />{t("saveRule")}</button>
      </section>
      <section className="panel rules-list">
        {rules.map((rule) => (
          <div className="rule-row" key={rule.id}>
            <div>
              <strong>{rule.name}</strong>
              <span>{rule.source} · weight {rule.weight} · priority {rule.priority}</span>
            </div>
            <span className={`source ${rule.source}`}>{rule.source}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function PreviewView({
  previews,
  selectedIds,
  setSelectedIds,
  executeSelected,
  t
}: {
  previews: OperationPreview[];
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  executeSelected: () => Promise<void>;
  t: ReturnType<typeof makeTranslator>;
}) {
  function toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  return (
    <section className="panel table-panel">
      <div className="section-heading">
        <div>
          <h2>{t("preview")}</h2>
          <p>{t("previewBeforeExecute")}</p>
        </div>
        <button className="primary-button" onClick={executeSelected} disabled={!selectedIds.size}>
          <Play size={17} /> {t("executeSelected")}
        </button>
      </div>
      {!previews.length ? <div className="empty">{t("noOperations")}</div> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th></th><th>{t("action")}</th><th>{t("sourcePath")}</th><th>{t("targetPath")}</th><th>{t("risk")}</th><th>{t("confidence")}</th></tr></thead>
            <tbody>
              {previews.map((preview) => (
                <tr key={preview.id}>
                  <td><input type="checkbox" checked={selectedIds.has(preview.id)} onChange={() => toggle(preview.id)} /></td>
                  <td>{preview.operation_type}</td>
                  <td className="path-cell">{preview.source_path}</td>
                  <td className="path-cell">{preview.target_path}</td>
                  <td><RiskBadge risk={preview.risk_level} /></td>
                  <td>{percent(preview.confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function OperationsView({ snapshot, t }: { snapshot: AppSnapshot; t: ReturnType<typeof makeTranslator> }) {
  return (
    <section className="panel rules-list">
      {snapshot.operations.map((operation) => (
        <div className="rule-row" key={operation.id}>
          <div>
            <strong>{operation.operation_type} · {operation.status}</strong>
            <span>{operation.source_path} → {operation.target_path}</span>
            {operation.error_message && <span>{operation.error_message}</span>}
          </div>
          <span className={`source ${operation.status}`}>{t(operation.status)}</span>
        </div>
      ))}
    </section>
  );
}

function SettingsView({
  language,
  setLanguage,
  t
}: {
  language: Language;
  setLanguage: (language: Language) => void;
  t: ReturnType<typeof makeTranslator>;
}) {
  return (
    <section className="panel settings-panel">
      <h2>{t("settings")}</h2>
      <label className="setting-row">
        <span>{t("language")}</span>
        <select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <div className="setting-row">
        <span>{t("localOnly")}</span>
        <strong>{t("scanRoots")}</strong>
      </div>
    </section>
  );
}

function ChartPanel({ title, data }: { title: string; data: Record<string, number> }) {
  const max = Math.max(1, ...Object.values(data));
  return (
    <section className="panel chart-panel">
      <h2>{title}</h2>
      {Object.entries(data).map(([key, value]) => (
        <div className="bar-row" key={key}>
          <span>{key}</span>
          <div><i style={{ width: `${(value / max) * 100}%` }} /></div>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function Inspector({ file, t }: { file?: FileRecord; t: ReturnType<typeof makeTranslator> }) {
  if (!file) return null;
  return (
    <aside className="panel inspector">
      <div className="section-heading">
        <h2>{t("reason")}</h2>
        <RiskBadge risk={file.risk_level} />
      </div>
      <h3>{file.name}</h3>
      <div className="inspector-grid">
        <span>{t("purpose")}</span><strong>{file.purpose}</strong>
        <span>{t("lifecycle")}</span><strong>{file.lifecycle}</strong>
        <span>{t("confidence")}</span><strong>{percent(file.confidence)}</strong>
        <span>{t("action")}</span><strong>{file.suggested_action}</strong>
      </div>
      <div className="explain-box">
        <strong>{t("matchedRules")}</strong>
        <p>{file.matched_rules.join(", ") || "-"}</p>
        <strong>{t("reason")}</strong>
        <p>{file.classification_reason}</p>
      </div>
      <div className="path-list">
        <span>{t("sourcePath")}</span>
        <code>{file.path}</code>
        <span>{t("targetPath")}</span>
        <code>{file.suggested_target_path || "-"}</code>
      </div>
    </aside>
  );
}

function RiskBadge({ risk }: { risk: string }) {
  return <span className={`risk ${risk.toLowerCase()}`}>{risk}</span>;
}

function filterFiles(files: FileRecord[], query: FileQuery): FileRecord[] {
  const search = query.search?.toLowerCase().trim();
  return files.filter((file) => {
    if (search && !`${file.name} ${file.path} ${file.context}`.toLowerCase().includes(search)) return false;
    if (query.fileType && query.fileType !== "All" && file.file_type !== query.fileType) return false;
    if (query.onlyNeedsConfirmation && !file.requires_confirmation) return false;
    return true;
  });
}

function createOperationPreviews(files: FileRecord[]): OperationPreview[] {
  return files
    .filter((file) => ["Move", "Rename", "MoveAndRename", "Archive"].includes(file.suggested_action))
    .filter((file) => file.risk_level !== "Sensitive")
    .map((file) => {
      const isRename = file.suggested_name && file.suggested_name !== file.name;
      const isMove = Boolean(file.suggested_target_path);
      const newName = file.suggested_name || file.name;
      const targetPath = file.suggested_target_path
        ? `${file.suggested_target_path.replace(/[\\/]+$/, "")}/${newName}`
        : `${file.directory.replace(/[\\/]+$/, "")}/${newName}`;
      const operationType: OperationPreview["operation_type"] =
        isMove && isRename ? "move_rename" : isMove ? "move" : "rename";
      return {
        id: localId("op"),
        fileId: file.id,
        operation_type: operationType,
        source_path: file.path,
        target_path: targetPath,
        old_name: file.name,
        new_name: newName,
        status: "pending" as const,
        risk_level: file.risk_level,
        confidence: file.confidence,
        requires_confirmation: file.requires_confirmation,
        reason: file.classification_reason
      };
    })
    .filter((preview) => preview.source_path !== preview.target_path);
}

function createDemoFiles(): FileRecord[] {
  const now = new Date().toISOString();
  const files: Array<Partial<FileRecord> & Pick<FileRecord, "name" | "file_type" | "purpose" | "lifecycle" | "risk_level" | "suggested_action" | "confidence" | "classification_reason">> = [
    {
      name: "resume_2026.pdf",
      file_type: "Document",
      purpose: "Career",
      lifecycle: "Reference",
      risk_level: "Normal",
      suggested_action: "Move",
      confidence: 0.84,
      classification_reason: "Matched Career and resume files"
    },
    {
      name: "invoice_apple.pdf",
      file_type: "Document",
      purpose: "Finance",
      lifecycle: "Reference",
      risk_level: "Sensitive",
      suggested_action: "Review",
      confidence: 0.78,
      classification_reason: "Matched Finance and receipt files; sensitive files require manual confirmation"
    },
    {
      name: "passport_scan.jpg",
      file_type: "Image",
      purpose: "Identity",
      lifecycle: "Sensitive",
      risk_level: "Sensitive",
      suggested_action: "Review",
      confidence: 0.92,
      classification_reason: "Matched Sensitive identity documents; sensitive files require manual confirmation"
    },
    {
      name: "setup.exe",
      file_type: "Installer",
      purpose: "Installer",
      lifecycle: "Disposable",
      risk_level: "Normal",
      suggested_action: "Review",
      confidence: 0.68,
      classification_reason: "Matched Installers and setup packages"
    },
    {
      name: "UNSW_COMP9900_Final_Report.pdf",
      file_type: "Document",
      purpose: "Study",
      lifecycle: "Archive",
      risk_level: "Normal",
      suggested_action: "Move",
      confidence: 0.72,
      classification_reason: "Matched Study material and coursework"
    },
    {
      name: "Screenshot 2026-06-15 at 10.22.01.png",
      file_type: "Image",
      purpose: "Media",
      lifecycle: "Inbox",
      risk_level: "Normal",
      suggested_action: "Rename",
      confidence: 0.62,
      classification_reason: "Matched Downloads and desktop inbox"
    }
  ];

  return files.map((file, index) => {
    const directory = "C:/Users/example/Downloads";
    const path = `${directory}/${file.name}`;
    const extension = file.name.split(".").pop() ?? "";
    return {
      id: `demo_${index}`,
      name: file.name,
      path,
      directory,
      extension,
      size: (index + 1) * 2_400_000,
      file_type: file.file_type,
      purpose: file.purpose,
      lifecycle: file.lifecycle,
      context: file.context ?? file.purpose,
      risk_level: file.risk_level,
      hash: null,
      created_at: now,
      modified_at: new Date(Date.now() - index * 8 * 86_400_000).toISOString(),
      scanned_at: now,
      last_seen_at: now,
      is_hidden: false,
      is_deleted: false,
      is_duplicate: false,
      suggested_action: file.suggested_action,
      suggested_target_path:
        file.suggested_action === "Move" ? `C:/Users/example/FileAssistant/${file.purpose}` : "",
      suggested_name:
        file.suggested_action === "Rename" ? "screenshot_20260615_001.png" : file.name,
      confidence: file.confidence,
      classification_reason: file.classification_reason,
      matched_rules: [file.classification_reason.replace("; sensitive files require manual confirmation", "")],
      requires_confirmation: file.risk_level === "Sensitive" || file.suggested_action === "Review"
    };
  });
}

function createDemoRules(): Rule[] {
  const now = new Date().toISOString();
  return [
    demoRule("system_career", "Career and resume files", "system", 90, 84),
    demoRule("system_finance", "Finance and receipt files", "system", 80, 80),
    demoRule("system_identity", "Sensitive identity documents", "system", 100, 95),
    {
      ...demoRule("user_screenshots", "Screenshots to Inbox", "user", 75, 76),
      action: {
        purpose: "Temporary" as const,
        lifecycle: "Inbox" as const,
        suggested_action: "Move" as const,
        target_template: "00_Inbox/Screenshots",
        context: "Screenshots"
      }
    }
  ].map((rule) => ({ ...rule, created_at: now, updated_at: now }));
}

function demoRule(
  id: string,
  name: string,
  source: Rule["source"],
  priority: number,
  weight: number
): Rule {
  const now = new Date().toISOString();
  return {
    id,
    name,
    source,
    enabled: true,
    priority,
    weight,
    root_operator: "AND",
    groups: [
      {
        id: `${id}_group`,
        operator: "AND",
        conditions: [{ id: `${id}_cond`, field: "name", operator: "contains", value: name.split(" ")[0] }]
      }
    ],
    action: { suggested_action: "Move", target_template: "00_Inbox" },
    created_at: now,
    updated_at: now
  };
}

function localId(prefix: string): string {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}
