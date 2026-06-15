import fs from "node:fs/promises";
import path from "node:path";
import initSqlJs, { type Database as SqlDatabase, type SqlJsStatic } from "sql.js";
import type {
  AppSnapshot,
  DashboardStats,
  FileQuery,
  FileRecord,
  OperationLog,
  Rule,
  ScanRoot
} from "../types/domain.js";
import { builtInRules } from "./ruleEngine.js";

export class Database {
  private constructor(
    private readonly sql: SqlJsStatic,
    private readonly db: SqlDatabase,
    private readonly dbPath: string
  ) {}

  static async open(userDataPath: string): Promise<Database> {
    await fs.mkdir(userDataPath, { recursive: true });
    const sql = await initSqlJs();
    const dbPath = path.join(userDataPath, "file-manager-assistant.sqlite");
    let db: SqlDatabase;
    try {
      const buffer = await fs.readFile(dbPath);
      db = new sql.Database(buffer);
    } catch {
      db = new sql.Database();
    }
    const database = new Database(sql, db, dbPath);
    database.migrate();
    database.ensureSystemRules();
    await database.persist();
    return database;
  }

  getSnapshot(): AppSnapshot {
    const files = this.getAllFiles();
    return {
      stats: buildStats(files),
      files,
      rules: this.getRules(),
      operations: this.getOperationLogs(),
      scanRoots: this.getScanRoots()
    };
  }

  upsertFiles(files: FileRecord[]) {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO files (
        id, name, path, directory, extension, size, file_type, purpose, lifecycle, context,
        risk_level, hash, created_at, modified_at, scanned_at, last_seen_at, is_hidden,
        is_deleted, is_duplicate, suggested_action, suggested_target_path, suggested_name,
        confidence, classification_reason, matched_rules, requires_confirmation
      ) VALUES (
        $id, $name, $path, $directory, $extension, $size, $file_type, $purpose, $lifecycle, $context,
        $risk_level, $hash, $created_at, $modified_at, $scanned_at, $last_seen_at, $is_hidden,
        $is_deleted, $is_duplicate, $suggested_action, $suggested_target_path, $suggested_name,
        $confidence, $classification_reason, $matched_rules, $requires_confirmation
      )
    `);
    this.db.run("BEGIN TRANSACTION");
    for (const file of files) {
      insert.run(serializeFile(file));
    }
    insert.free();
    this.db.run("COMMIT");
    void this.persist();
  }

  getAllFiles(): FileRecord[] {
    return this.selectFiles("SELECT * FROM files WHERE is_deleted = 0 ORDER BY modified_at DESC");
  }

  queryFiles(query: FileQuery): FileRecord[] {
    const files = this.getAllFiles();
    const search = query.search?.trim().toLowerCase();
    const filtered = files.filter((file) => {
      if (search && !`${file.name} ${file.path} ${file.context}`.toLowerCase().includes(search)) {
        return false;
      }
      if (query.fileType && query.fileType !== "All" && file.file_type !== query.fileType) return false;
      if (query.purpose && query.purpose !== "All" && file.purpose !== query.purpose) return false;
      if (query.lifecycle && query.lifecycle !== "All" && file.lifecycle !== query.lifecycle) return false;
      if (query.riskLevel && query.riskLevel !== "All" && file.risk_level !== query.riskLevel) return false;
      if (query.sourceDirectory && !file.directory.includes(query.sourceDirectory)) return false;
      if (query.onlyActionable && file.suggested_action === "Keep") return false;
      if (query.onlyNeedsConfirmation && !file.requires_confirmation) return false;
      return true;
    });

    const sortBy = query.sortBy ?? "modified_at";
    const direction = query.sortDirection === "asc" ? 1 : -1;
    return filtered.sort((a, b) => {
      const left = a[sortBy];
      const right = b[sortBy];
      if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
      return String(left).localeCompare(String(right)) * direction;
    });
  }

  getRules(): Rule[] {
    const rows = this.execRows("SELECT * FROM rules ORDER BY source ASC, priority DESC, updated_at DESC");
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      source: row.source as Rule["source"],
      enabled: Boolean(row.enabled),
      priority: Number(row.priority),
      weight: Number(row.weight),
      root_operator: row.root_operator as Rule["root_operator"],
      groups: JSON.parse(String(row.condition_json)),
      action: JSON.parse(String(row.action_json)),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    }));
  }

  saveRule(rule: Rule) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO rules (
        id, name, source, enabled, priority, weight, root_operator, condition_json, action_json, created_at, updated_at
      ) VALUES (
        $id, $name, $source, $enabled, $priority, $weight, $root_operator, $condition_json, $action_json, $created_at, $updated_at
      )
    `);
    stmt.run({
      $id: rule.id,
      $name: rule.name,
      $source: rule.source,
      $enabled: rule.enabled ? 1 : 0,
      $priority: rule.priority,
      $weight: rule.weight,
      $root_operator: rule.root_operator,
      $condition_json: JSON.stringify(rule.groups),
      $action_json: JSON.stringify(rule.action),
      $created_at: rule.created_at,
      $updated_at: rule.updated_at
    });
    stmt.free();
    void this.persist();
  }

  deleteRule(id: string) {
    this.db.run("DELETE FROM rules WHERE id = $id AND source != 'system'", { $id: id });
    void this.persist();
  }

  upsertScanRoots(roots: ScanRoot[]) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO scan_roots (id, path, platform, enabled, last_scanned_at, created_at)
      VALUES ($id, $path, $platform, $enabled, $last_scanned_at, $created_at)
    `);
    for (const root of roots) {
      stmt.run({
        $id: root.id,
        $path: root.path,
        $platform: root.platform,
        $enabled: root.enabled ? 1 : 0,
        $last_scanned_at: root.last_scanned_at,
        $created_at: root.created_at
      });
    }
    stmt.free();
    void this.persist();
  }

  getScanRoots(): ScanRoot[] {
    return this.execRows("SELECT * FROM scan_roots ORDER BY path").map((row) => ({
      id: String(row.id),
      path: String(row.path),
      platform: String(row.platform),
      enabled: Boolean(row.enabled),
      last_scanned_at: row.last_scanned_at ? String(row.last_scanned_at) : null,
      created_at: String(row.created_at)
    }));
  }

  addOperationLogs(logs: OperationLog[]) {
    const stmt = this.db.prepare(`
      INSERT INTO operation_logs (
        id, operation_type, source_path, target_path, old_name, new_name, status, error_message, created_at, can_undo
      ) VALUES (
        $id, $operation_type, $source_path, $target_path, $old_name, $new_name, $status, $error_message, $created_at, $can_undo
      )
    `);
    for (const log of logs) {
      stmt.run({
        $id: log.id,
        $operation_type: log.operation_type,
        $source_path: log.source_path,
        $target_path: log.target_path,
        $old_name: log.old_name,
        $new_name: log.new_name,
        $status: log.status,
        $error_message: log.error_message,
        $created_at: log.created_at,
        $can_undo: log.can_undo ? 1 : 0
      });
    }
    stmt.free();
    void this.persist();
  }

  getOperationLogs(): OperationLog[] {
    return this.execRows("SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT 200").map((row) => ({
      id: String(row.id),
      operation_type: String(row.operation_type),
      source_path: String(row.source_path),
      target_path: String(row.target_path),
      old_name: String(row.old_name),
      new_name: String(row.new_name),
      status: row.status as OperationLog["status"],
      error_message: row.error_message ? String(row.error_message) : null,
      created_at: String(row.created_at),
      can_undo: Boolean(row.can_undo)
    }));
  }

  private selectFiles(sql: string): FileRecord[] {
    return this.execRows(sql).map(deserializeFile);
  }

  private execRows(sql: string): Array<Record<string, unknown>> {
    const result = this.db.exec(sql);
    if (!result.length) return [];
    const table = result[0];
    return table.values.map((values) =>
      Object.fromEntries(table.columns.map((column, index) => [column, values[index]]))
    );
  }

  private migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        directory TEXT NOT NULL,
        extension TEXT NOT NULL,
        size INTEGER NOT NULL,
        file_type TEXT NOT NULL,
        purpose TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        context TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        hash TEXT,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL,
        scanned_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        is_hidden INTEGER NOT NULL,
        is_deleted INTEGER NOT NULL,
        is_duplicate INTEGER NOT NULL,
        suggested_action TEXT NOT NULL,
        suggested_target_path TEXT NOT NULL,
        suggested_name TEXT NOT NULL,
        confidence REAL NOT NULL,
        classification_reason TEXT NOT NULL,
        matched_rules TEXT NOT NULL,
        requires_confirmation INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scan_roots (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        platform TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        last_scanned_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        weight INTEGER NOT NULL,
        root_operator TEXT NOT NULL,
        condition_json TEXT NOT NULL,
        action_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operation_logs (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL,
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        old_name TEXT NOT NULL,
        new_name TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        can_undo INTEGER NOT NULL
      );
    `);
  }

  private ensureSystemRules() {
    for (const rule of builtInRules) {
      this.saveRule(rule);
    }
  }

  private async persist() {
    const data = this.db.export();
    await fs.writeFile(this.dbPath, data);
  }
}

function serializeFile(file: FileRecord): Record<string, unknown> {
  return {
    $id: file.id,
    $name: file.name,
    $path: file.path,
    $directory: file.directory,
    $extension: file.extension,
    $size: file.size,
    $file_type: file.file_type,
    $purpose: file.purpose,
    $lifecycle: file.lifecycle,
    $context: file.context,
    $risk_level: file.risk_level,
    $hash: file.hash,
    $created_at: file.created_at,
    $modified_at: file.modified_at,
    $scanned_at: file.scanned_at,
    $last_seen_at: file.last_seen_at,
    $is_hidden: file.is_hidden ? 1 : 0,
    $is_deleted: file.is_deleted ? 1 : 0,
    $is_duplicate: file.is_duplicate ? 1 : 0,
    $suggested_action: file.suggested_action,
    $suggested_target_path: file.suggested_target_path,
    $suggested_name: file.suggested_name,
    $confidence: file.confidence,
    $classification_reason: file.classification_reason,
    $matched_rules: JSON.stringify(file.matched_rules),
    $requires_confirmation: file.requires_confirmation ? 1 : 0
  };
}

function deserializeFile(row: Record<string, unknown>): FileRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    directory: String(row.directory),
    extension: String(row.extension),
    size: Number(row.size),
    file_type: row.file_type as FileRecord["file_type"],
    purpose: row.purpose as FileRecord["purpose"],
    lifecycle: row.lifecycle as FileRecord["lifecycle"],
    context: String(row.context),
    risk_level: row.risk_level as FileRecord["risk_level"],
    hash: row.hash ? String(row.hash) : null,
    created_at: String(row.created_at),
    modified_at: String(row.modified_at),
    scanned_at: String(row.scanned_at),
    last_seen_at: String(row.last_seen_at),
    is_hidden: Boolean(row.is_hidden),
    is_deleted: Boolean(row.is_deleted),
    is_duplicate: Boolean(row.is_duplicate),
    suggested_action: row.suggested_action as FileRecord["suggested_action"],
    suggested_target_path: String(row.suggested_target_path),
    suggested_name: String(row.suggested_name),
    confidence: Number(row.confidence),
    classification_reason: String(row.classification_reason),
    matched_rules: JSON.parse(String(row.matched_rules || "[]")),
    requires_confirmation: Boolean(row.requires_confirmation)
  };
}

function buildStats(files: FileRecord[]): DashboardStats {
  const stats: DashboardStats = {
    totalFiles: files.length,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    duplicateFiles: files.filter((file) => file.is_duplicate).length,
    largeFiles: files.filter((file) => file.size > 1024 * 1024 * 1024).length,
    sensitiveFiles: files.filter((file) => file.risk_level === "Sensitive").length,
    needsConfirmation: files.filter((file) => file.requires_confirmation).length,
    byType: {},
    byLifecycle: {},
    lastScannedAt: files[0]?.scanned_at ?? null
  };
  for (const file of files) {
    stats.byType[file.file_type] = (stats.byType[file.file_type] ?? 0) + 1;
    stats.byLifecycle[file.lifecycle] = (stats.byLifecycle[file.lifecycle] ?? 0) + 1;
  }
  return stats;
}

