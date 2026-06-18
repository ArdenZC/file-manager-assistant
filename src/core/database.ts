import fs from "node:fs/promises";
import path from "node:path";
import BetterSqlite3, { type Database as SqliteDatabase } from "better-sqlite3";
import type {
  AppSnapshot,
  DashboardStats,
  FileQuery,
  FileQueryResult,
  FileRecord,
  FolderNamingLanguage,
  OperationLog,
  RestoreBatch,
  RestoreRetentionDays,
  RestoreStatus,
  Rule,
  ScanRoot,
  SearchIndexState,
  SearchQuery,
  SearchResult,
  SearchSource
} from "../types/domain.js";
import { nowIso, stableId } from "./id.js";
import { builtInRules } from "./ruleEngine.js";

type Row = Record<string, unknown>;

export class Database {
  private constructor(
    private readonly db: SqliteDatabase,
    private readonly dbPath: string
  ) {}

  static async open(userDataPath: string): Promise<Database> {
    await fs.mkdir(userDataPath, { recursive: true });
    const dbPath = path.join(userDataPath, "zen-canvas.sqlite");
    const db = new BetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const database = new Database(db, dbPath);
    database.migrate();
    database.ensureSystemRules();
    database.pruneOperationLogs(database.getRestoreRetentionDays());
    return database;
  }

  close() {
    this.db.close();
  }

  getSnapshot(): AppSnapshot {
    const scanRoots = this.getScanRoots();
    return {
      stats: this.getDashboardStats(scanRoots),
      files: this.queryFilesPage({ limit: 50, offset: 0, sortBy: "modified_at", sortDirection: "desc" }).files,
      rules: this.getRules(),
      operations: this.getOperationLogs(),
      scanRoots,
      searchSources: this.getSearchSources(),
      searchIndex: this.getSearchIndexState()
    };
  }

  upsertFiles(files: FileRecord[]) {
    if (!files.length) return;
    const insert = this.db.prepare(`
      INSERT INTO files (
        id, name, path, directory, extension, size, file_type, purpose, lifecycle, context,
        risk_level, hash, created_at, modified_at, scanned_at, last_seen_at, is_hidden,
        is_deleted, is_duplicate, suggested_action, suggested_target_path, suggested_name,
        confidence, classification_reason, matched_rules, requires_confirmation,
        dispatch_zone, recommended_folder, folder_reuse_candidate, folder_rename_suggestion,
        dispatch_reason, next_action, last_opened_at, open_count, indexed_at, source_id, is_stale
      ) VALUES (
        @id, @name, @path, @directory, @extension, @size, @file_type, @purpose, @lifecycle, @context,
        @risk_level, @hash, @created_at, @modified_at, @scanned_at, @last_seen_at, @is_hidden,
        @is_deleted, @is_duplicate, @suggested_action, @suggested_target_path, @suggested_name,
        @confidence, @classification_reason, @matched_rules, @requires_confirmation,
        @dispatch_zone, @recommended_folder, @folder_reuse_candidate, @folder_rename_suggestion,
        @dispatch_reason, @next_action, @last_opened_at, @open_count, @indexed_at, @source_id, @is_stale
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        directory = excluded.directory,
        extension = excluded.extension,
        size = excluded.size,
        file_type = excluded.file_type,
        purpose = excluded.purpose,
        lifecycle = excluded.lifecycle,
        context = excluded.context,
        risk_level = excluded.risk_level,
        hash = excluded.hash,
        created_at = excluded.created_at,
        modified_at = excluded.modified_at,
        scanned_at = excluded.scanned_at,
        last_seen_at = excluded.last_seen_at,
        is_hidden = excluded.is_hidden,
        is_deleted = excluded.is_deleted,
        is_duplicate = excluded.is_duplicate,
        suggested_action = excluded.suggested_action,
        suggested_target_path = excluded.suggested_target_path,
        suggested_name = excluded.suggested_name,
        confidence = excluded.confidence,
        classification_reason = excluded.classification_reason,
        matched_rules = excluded.matched_rules,
        requires_confirmation = excluded.requires_confirmation,
        dispatch_zone = excluded.dispatch_zone,
        recommended_folder = excluded.recommended_folder,
        folder_reuse_candidate = excluded.folder_reuse_candidate,
        folder_rename_suggestion = excluded.folder_rename_suggestion,
        dispatch_reason = excluded.dispatch_reason,
        next_action = excluded.next_action,
        indexed_at = excluded.indexed_at,
        source_id = excluded.source_id,
        is_stale = excluded.is_stale
    `);
    const deleteFts = this.db.prepare("DELETE FROM files_fts WHERE id = ?");
    const clearFts = this.db.prepare("DELETE FROM files_fts");
    const insertFts = this.db.prepare(`
      INSERT INTO files_fts (
        id, name, path, extension, file_type, purpose, lifecycle, context, classification_reason
      ) VALUES (
        @id, @name, @path, @extension, @file_type, @purpose, @lifecycle, @context, @classification_reason
      )
    `);

    const sources = this.getSearchSources();
    const ftsRows = this.db.prepare("SELECT COUNT(*) AS count FROM files_fts").get() as Row;
    const resetFtsForBatch = files.length > 10_000 || Number(ftsRows.count ?? 0) === 0;
    const transaction = this.db.transaction((items: FileRecord[]) => {
      if (resetFtsForBatch) {
        clearFts.run();
      }
      for (const file of items) {
        const sourceId = findSourceIdForFile(file, sources);
        const serialized = serializeFile({
          ...file,
          source_id: sourceId ?? file.source_id,
          indexed_at: file.indexed_at ?? nowIso(),
          open_count: file.open_count ?? 0,
          is_stale: file.is_stale ?? false
        });
        insert.run(serialized);
        if (!resetFtsForBatch) {
          deleteFts.run(file.id);
        }
        insertFts.run(serialized);
      }
    });
    transaction(files);
  }

  replaceFilesForRoots(roots: ScanRoot[], files: FileRecord[]) {
    const rootPaths = roots.map((root) => root.path).filter(Boolean);
    if (rootPaths.length) {
      const selectIds = this.db.prepare(`
        SELECT id
        FROM files
        WHERE is_deleted = 0
          AND (path = @root OR path LIKE @prefix ESCAPE '!')
      `);
      const markDeleted = this.db.prepare(`
        UPDATE files
        SET is_deleted = 1, is_stale = 1, last_seen_at = @now
        WHERE id = @id
      `);
      const deleteFts = this.db.prepare("DELETE FROM files_fts WHERE id = @id");
      const now = nowIso();
      const transaction = this.db.transaction((pathsToReplace: string[]) => {
        for (const rootPath of pathsToReplace) {
          const normalizedRoot = path.resolve(rootPath);
          const rootWithSeparator = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
          const rows = selectIds.all({
            root: normalizedRoot,
            prefix: `${escapeSqlLike(rootWithSeparator)}%`
          }) as Row[];
          for (const row of rows) {
            const id = String(row.id);
            markDeleted.run({ id, now });
            deleteFts.run({ id });
          }
        }
      });
      transaction(rootPaths);
    }
    this.upsertFiles(files);
  }

  getAllFiles(): FileRecord[] {
    return this.selectFiles("SELECT * FROM files WHERE is_deleted = 0 ORDER BY modified_at DESC");
  }

  getFileById(id: string): FileRecord | null {
    const row = this.db.prepare("SELECT * FROM files WHERE id = ? LIMIT 1").get(id) as Row | undefined;
    return row ? deserializeFile(row) : null;
  }

  queryFiles(query: FileQuery): FileRecord[] {
    return this.queryFilesPage(query).files;
  }

  queryFilesPage(query: FileQuery): FileQueryResult {
    const clauses = ["is_deleted = 0"];
    const params: Record<string, unknown> = {};
    const search = query.search?.trim();

    if (search) {
      clauses.push("(name LIKE @search ESCAPE '!' OR path LIKE @search ESCAPE '!' OR context LIKE @search ESCAPE '!')");
      params.search = `%${escapeSqlLike(search)}%`;
    }
    if (query.fileType && query.fileType !== "All") {
      clauses.push("file_type = @fileType");
      params.fileType = query.fileType;
    }
    if (query.purpose && query.purpose !== "All") {
      clauses.push("purpose = @purpose");
      params.purpose = query.purpose;
    }
    if (query.lifecycle && query.lifecycle !== "All") {
      clauses.push("lifecycle = @lifecycle");
      params.lifecycle = query.lifecycle;
    }
    if (query.riskLevel && query.riskLevel !== "All") {
      clauses.push("risk_level = @riskLevel");
      params.riskLevel = query.riskLevel;
    }
    if (query.sourceDirectory) {
      clauses.push("directory LIKE @sourceDirectory ESCAPE '!'");
      params.sourceDirectory = `%${escapeSqlLike(query.sourceDirectory)}%`;
    }
    if (query.roots?.length) {
      const rootClauses: string[] = [];
      query.roots.filter(Boolean).forEach((root, index) => {
        const normalizedRoot = path.resolve(root);
        const rootWithSeparator = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
        const rootParam = `root${index}`;
        const prefixParam = `rootPrefix${index}`;
        rootClauses.push(`(path = @${rootParam} OR path LIKE @${prefixParam} ESCAPE '!')`);
        params[rootParam] = normalizedRoot;
        params[prefixParam] = `${escapeSqlLike(rootWithSeparator)}%`;
      });
      if (rootClauses.length) {
        clauses.push(`(${rootClauses.join(" OR ")})`);
      }
    }
    if (query.onlyActionable) {
      clauses.push("suggested_action != 'Keep'");
    }
    if (query.onlyNeedsConfirmation) {
      clauses.push("requires_confirmation = 1");
    }

    const allowedSort = new Set(["name", "size", "modified_at", "confidence"]);
    const sortBy = allowedSort.has(query.sortBy ?? "") ? query.sortBy : "modified_at";
    const direction = query.sortDirection === "asc" ? "ASC" : "DESC";
    const limit = clampInteger(query.limit, 1, 500, 50);
    const offset = clampInteger(query.offset, 0, 1_000_000, 0);
    const whereSql = clauses.join(" AND ");
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM files WHERE ${whereSql}`).get(params) as Row;
    const files = this.selectFiles(
      `SELECT * FROM files WHERE ${whereSql} ORDER BY ${sortBy} ${direction} LIMIT @limit OFFSET @offset`,
      { ...params, limit, offset }
    );
    return {
      files,
      total: Number(totalRow.total ?? 0),
      limit,
      offset
    };
  }

  searchFiles(query: SearchQuery): SearchResult[] {
    const raw = query.query.trim();
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const parsed = parseSearch(raw);
    const sourceIds = query.sourceIds?.filter(Boolean) ?? [];
    const sourceFilter = sourceIds.length
      ? ` AND f.source_id IN (${sourceIds.map((_, index) => `@source${index}`).join(", ")})`
      : "";
    const sourceParams = Object.fromEntries(sourceIds.map((sourceId, index) => [`source${index}`, sourceId]));

    if (!raw) {
      const rows = this.db.prepare(`
        SELECT f.*, 0 AS score, f.name AS matched_text
        FROM files f
        WHERE f.is_deleted = 0${sourceFilter}
        ORDER BY f.last_opened_at DESC NULLS LAST, f.modified_at DESC, length(f.path) ASC
        LIMIT @limit
      `).all({ limit, ...sourceParams }) as Row[];
      return rows.map((row) => ({ file: deserializeFile(row), score: 0, matched_text: String(row.matched_text) }));
    }

    const extensionClause = parsed.extension ? " AND f.extension = @extension" : "";
    const ftsExpression = buildFtsExpression(parsed.tokens);
    if (ftsExpression) {
      try {
        const rows = this.db.prepare(`
          SELECT f.*, bm25(files_fts) AS score, files_fts.name AS matched_text
          FROM files_fts
          JOIN files f ON f.id = files_fts.id
          WHERE files_fts MATCH @fts
            AND f.is_deleted = 0
            ${extensionClause}
            ${sourceFilter}
          ORDER BY score ASC, f.open_count DESC, f.modified_at DESC, length(f.path) ASC
          LIMIT @limit
        `).all({
          fts: ftsExpression,
          extension: parsed.extension,
          limit,
          ...sourceParams
        }) as Row[];
        return rows.map((row) => ({
          file: deserializeFile(row),
          score: Number(row.score),
          matched_text: String(row.matched_text)
        }));
      } catch {
        // Fall back to LIKE below if user input cannot be represented as valid FTS syntax.
      }
    }

    const likeClauses = parsed.tokens.length
      ? parsed.tokens.map((_, index) => `(f.name LIKE @like${index} OR f.path LIKE @like${index})`).join(" AND ")
      : "(f.name LIKE @raw OR f.path LIKE @raw)";
    const likeParams = parsed.tokens.length
      ? Object.fromEntries(parsed.tokens.map((token, index) => [`like${index}`, `%${escapeLike(token)}%`]))
      : { raw: `%${escapeLike(raw)}%` };
    const rows = this.db.prepare(`
      SELECT f.*, 10 AS score, f.name AS matched_text
      FROM files f
      WHERE f.is_deleted = 0
        AND ${likeClauses}
        ${extensionClause}
        ${sourceFilter}
      ORDER BY f.open_count DESC, f.modified_at DESC, length(f.path) ASC
      LIMIT @limit
    `).all({ ...likeParams, extension: parsed.extension, limit, ...sourceParams }) as Row[];
    return rows.map((row) => ({ file: deserializeFile(row), score: Number(row.score), matched_text: String(row.matched_text) }));
  }

  recordFileOpened(fileId: string) {
    this.db.prepare(`
      UPDATE files
      SET last_opened_at = @now, open_count = COALESCE(open_count, 0) + 1
      WHERE id = @fileId
    `).run({ now: nowIso(), fileId });
  }

  getRules(): Rule[] {
    const rows = this.db.prepare("SELECT * FROM rules ORDER BY source ASC, priority DESC, updated_at DESC").all() as Row[];
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
    this.db.prepare(`
      INSERT INTO rules (
        id, name, source, enabled, priority, weight, root_operator, condition_json, action_json, created_at, updated_at
      ) VALUES (
        @id, @name, @source, @enabled, @priority, @weight, @root_operator, @condition_json, @action_json, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        source = excluded.source,
        enabled = excluded.enabled,
        priority = excluded.priority,
        weight = excluded.weight,
        root_operator = excluded.root_operator,
        condition_json = excluded.condition_json,
        action_json = excluded.action_json,
        updated_at = excluded.updated_at
    `).run({
      id: rule.id,
      name: rule.name,
      source: rule.source,
      enabled: rule.enabled ? 1 : 0,
      priority: rule.priority,
      weight: rule.weight,
      root_operator: rule.root_operator,
      condition_json: JSON.stringify(rule.groups),
      action_json: JSON.stringify(rule.action),
      created_at: rule.created_at,
      updated_at: rule.updated_at
    });
  }

  deleteRule(id: string) {
    this.db.prepare("DELETE FROM rules WHERE id = @id AND source != 'system'").run({ id });
  }

  upsertScanRoots(roots: ScanRoot[]) {
    if (!roots.length) return;
    const stmt = this.db.prepare(`
      INSERT INTO scan_roots (
        id, path, platform, enabled, last_scanned_at, created_at,
        disk_total_size, disk_free_size, scanned_size, indexed_file_count, skipped_count, summarized_count
      )
      VALUES (
        @id, @path, @platform, @enabled, @last_scanned_at, @created_at,
        @disk_total_size, @disk_free_size, @scanned_size, @indexed_file_count, @skipped_count, @summarized_count
      )
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        platform = excluded.platform,
        enabled = excluded.enabled,
        last_scanned_at = excluded.last_scanned_at,
        disk_total_size = excluded.disk_total_size,
        disk_free_size = excluded.disk_free_size,
        scanned_size = excluded.scanned_size,
        indexed_file_count = excluded.indexed_file_count,
        skipped_count = excluded.skipped_count,
        summarized_count = excluded.summarized_count
    `);
    const insert = this.db.transaction((items: ScanRoot[]) => {
      for (const root of items) {
        stmt.run({
          id: root.id,
          path: root.path,
          platform: root.platform,
          enabled: root.enabled ? 1 : 0,
          last_scanned_at: root.last_scanned_at,
          created_at: root.created_at,
          disk_total_size: root.disk_total_size ?? null,
          disk_free_size: root.disk_free_size ?? null,
          scanned_size: root.scanned_size ?? 0,
          indexed_file_count: root.indexed_file_count ?? 0,
          skipped_count: root.skipped_count ?? 0,
          summarized_count: root.summarized_count ?? 0
        });
        this.upsertSearchSourceForRoot(root.path, root.path, "folder", true);
      }
    });
    insert(roots);
  }

  getScanRoots(): ScanRoot[] {
    return (this.db.prepare("SELECT * FROM scan_roots ORDER BY path").all() as Row[]).map((row) => ({
      id: String(row.id),
      path: String(row.path),
      platform: String(row.platform),
      enabled: Boolean(row.enabled),
      last_scanned_at: row.last_scanned_at ? String(row.last_scanned_at) : null,
      created_at: String(row.created_at),
      disk_total_size: row.disk_total_size == null ? null : Number(row.disk_total_size),
      disk_free_size: row.disk_free_size == null ? null : Number(row.disk_free_size),
      scanned_size: Number(row.scanned_size ?? 0),
      indexed_file_count: Number(row.indexed_file_count ?? 0),
      skipped_count: Number(row.skipped_count ?? 0),
      summarized_count: Number(row.summarized_count ?? 0)
    }));
  }

  upsertSearchSourceForRoot(
    sourcePath: string,
    label = path.basename(sourcePath) || sourcePath,
    type: SearchSource["type"] = "folder",
    enabled = true
  ) {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO search_sources (id, label, path, type, enabled, is_stale, indexed_at, created_at, updated_at)
      VALUES (@id, @label, @path, @type, @enabled, 0, @indexed_at, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        path = excluded.path,
        type = excluded.type,
        enabled = excluded.enabled,
        is_stale = 0,
        indexed_at = excluded.indexed_at,
        updated_at = excluded.updated_at
    `).run({
      id: stableId(sourcePath),
      label,
      path: sourcePath,
      type,
      enabled: enabled ? 1 : 0,
      indexed_at: now,
      created_at: now,
      updated_at: now
    });
  }

  getSearchSources(): SearchSource[] {
    const rows = this.db.prepare("SELECT * FROM search_sources ORDER BY type, label").all() as Row[];
    return rows.map(deserializeSearchSource);
  }

  updateSearchSources(sources: SearchSource[]) {
    const now = nowIso();
    const stmt = this.db.prepare(`
      INSERT INTO search_sources (id, label, path, type, enabled, is_stale, indexed_at, created_at, updated_at)
      VALUES (@id, @label, @path, @type, @enabled, @is_stale, @indexed_at, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        path = excluded.path,
        type = excluded.type,
        enabled = excluded.enabled,
        is_stale = excluded.is_stale,
        indexed_at = excluded.indexed_at,
        updated_at = excluded.updated_at
    `);
    const update = this.db.transaction((items: SearchSource[]) => {
      for (const source of items) {
        stmt.run({
          id: source.id || stableId(source.path),
          label: source.label,
          path: source.path,
          type: source.type,
          enabled: source.enabled ? 1 : 0,
          is_stale: source.is_stale ? 1 : 0,
          indexed_at: source.indexed_at,
          created_at: source.created_at || now,
          updated_at: now
        });
      }
    });
    update(sources);
  }

  markSearchSourceStaleByPath(changedPath: string) {
    const source = this.getSearchSources()
      .filter((item) => item.enabled)
      .sort((a, b) => b.path.length - a.path.length)
      .find((item) => isSameOrInside(changedPath, item.path));
    if (!source) return;
    this.db.prepare("UPDATE search_sources SET is_stale = 1, updated_at = @now WHERE id = @id")
      .run({ now: nowIso(), id: source.id });
  }

  rebuildSearchIndex() {
    const now = nowIso();
    const files = this.getAllFiles();
    const deleteFts = this.db.prepare("DELETE FROM files_fts");
    const insertFts = this.db.prepare(`
      INSERT INTO files_fts (
        id, name, path, extension, file_type, purpose, lifecycle, context, classification_reason
      ) VALUES (
        @id, @name, @path, @extension, @file_type, @purpose, @lifecycle, @context, @classification_reason
      )
    `);
    const transaction = this.db.transaction((items: FileRecord[]) => {
      deleteFts.run();
      for (const file of items) {
        insertFts.run(serializeFile(file));
      }
      this.db.prepare("UPDATE files SET indexed_at = @now, is_stale = 0").run({ now });
      this.db.prepare("UPDATE search_sources SET indexed_at = @now, is_stale = 0, updated_at = @now").run({ now });
    });
    transaction(files);
    return this.getSearchIndexState();
  }

  getSearchIndexState(): SearchIndexState {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM files WHERE is_deleted = 0) AS total_files,
        (SELECT COUNT(*) FROM files_fts) AS indexed_files,
        (SELECT MAX(indexed_at) FROM files) AS last_indexed_at,
        (SELECT COUNT(*) FROM search_sources WHERE is_stale = 1) AS stale_sources
    `).get() as Row;
    return {
      total_files: Number(row.total_files ?? 0),
      indexed_files: Number(row.indexed_files ?? 0),
      last_indexed_at: row.last_indexed_at ? String(row.last_indexed_at) : null,
      stale_sources: Number(row.stale_sources ?? 0)
    };
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ? LIMIT 1").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setSetting(key: string, value: string) {
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (@key, @value, @updated_at)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run({ key, value, updated_at: nowIso() });
  }

  getFolderNamingLanguage(): FolderNamingLanguage {
    return this.getSetting("folderNamingLanguage") === "zh" ? "zh" : "en";
  }

  getRestoreRetentionDays(): RestoreRetentionDays {
    const value = Number(this.getSetting("restoreRetentionDays") ?? 30);
    return value === 15 || value === 60 || value === 90 ? value : 30;
  }

  addOperationLogs(logs: OperationLog[]) {
    if (!logs.length) return;
    const stmt = this.db.prepare(`
      INSERT INTO operation_logs (
        id, batch_id, operation_type, source_path, target_path, old_name, new_name,
        status, error_message, created_at, can_undo, path_before, path_after,
        name_before, name_after, can_restore, restored_at, restore_status, restore_error
      ) VALUES (
        @id, @batch_id, @operation_type, @source_path, @target_path, @old_name, @new_name,
        @status, @error_message, @created_at, @can_undo, @path_before, @path_after,
        @name_before, @name_after, @can_restore, @restored_at, @restore_status, @restore_error
      )
    `);
    const insert = this.db.transaction((items: OperationLog[]) => {
      for (const log of items) stmt.run(serializeOperationLog(log));
    });
    insert(logs);
  }

  getOperationLogs(): OperationLog[] {
    return (this.db.prepare("SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT 300").all() as Row[])
      .map(deserializeOperationLog);
  }

  getOperationLogsByBatch(batchId: string): OperationLog[] {
    return (this.db.prepare("SELECT * FROM operation_logs WHERE batch_id = @batchId ORDER BY created_at ASC").all({ batchId }) as Row[])
      .map(deserializeOperationLog);
  }

  getRestoreBatches(retentionDays = this.getRestoreRetentionDays()): RestoreBatch[] {
    const minCreatedAt = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const rows = this.db.prepare(`
      SELECT
        batch_id,
        MIN(created_at) AS created_at,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN can_restore = 1 AND restore_status = 'not_restored' THEN 1 ELSE 0 END) AS restorable,
        SUM(CASE WHEN restore_status = 'restored' THEN 1 ELSE 0 END) AS restored
      FROM operation_logs
      WHERE created_at >= @minCreatedAt
      GROUP BY batch_id
      ORDER BY created_at DESC
      LIMIT 50
    `).all({ minCreatedAt }) as Row[];
    return rows.map((row) => {
      const createdAt = String(row.created_at);
      return {
        batch_id: String(row.batch_id),
        created_at: createdAt,
        total: Number(row.total ?? 0),
        success: Number(row.success ?? 0),
        failed: Number(row.failed ?? 0),
        skipped: Number(row.skipped ?? 0),
        restorable: Number(row.restorable ?? 0),
        restored: Number(row.restored ?? 0),
        expires_at: new Date(new Date(createdAt).getTime() + retentionDays * 86_400_000).toISOString()
      };
    });
  }

  markRestoreResult(logId: string, status: RestoreStatus, error: string | null) {
    this.db.prepare(`
      UPDATE operation_logs
      SET restore_status = @status,
          restored_at = CASE WHEN @status = 'restored' THEN @now ELSE restored_at END,
          restore_error = @error
      WHERE id = @logId
    `).run({ logId, status, error, now: nowIso() });
  }

  pruneOperationLogs(retentionDays = this.getRestoreRetentionDays()) {
    const threshold = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    this.db.prepare("DELETE FROM operation_logs WHERE created_at < @threshold")
      .run({ threshold });
  }

  getDashboardStats(scanRoots = this.getScanRoots()): DashboardStats {
    const aggregate = this.db.prepare(`
      SELECT
        COUNT(*) AS totalFiles,
        COALESCE(SUM(size), 0) AS totalSize,
        COALESCE(SUM(CASE WHEN is_duplicate = 1 THEN 1 ELSE 0 END), 0) AS duplicateFiles,
        COALESCE(SUM(CASE WHEN size > 1073741824 THEN 1 ELSE 0 END), 0) AS largeFiles,
        COALESCE(SUM(CASE WHEN risk_level = 'Sensitive' THEN 1 ELSE 0 END), 0) AS sensitiveFiles,
        COALESCE(SUM(CASE WHEN requires_confirmation = 1 THEN 1 ELSE 0 END), 0) AS needsConfirmation,
        MAX(scanned_at) AS lastScannedAt
      FROM files
      WHERE is_deleted = 0
    `).get() as Row;
    const byTypeRows = this.db.prepare(`
      SELECT file_type AS key, COUNT(*) AS count
      FROM files
      WHERE is_deleted = 0
      GROUP BY file_type
    `).all() as Row[];
    const byLifecycleRows = this.db.prepare(`
      SELECT lifecycle AS key, COUNT(*) AS count
      FROM files
      WHERE is_deleted = 0
      GROUP BY lifecycle
    `).all() as Row[];
    const diskTotalSize = sumUniqueRootDiskMetric(scanRoots, "disk_total_size");
    const diskFreeSize = sumUniqueRootDiskMetric(scanRoots, "disk_free_size");
    const totalSize = Number(aggregate.totalSize ?? 0);
    return {
      totalFiles: Number(aggregate.totalFiles ?? 0),
      totalSize,
      diskTotalSize,
      diskFreeSize,
      diskUsageRatio: diskTotalSize > 0 ? Math.min(1, totalSize / diskTotalSize) : 0,
      duplicateFiles: Number(aggregate.duplicateFiles ?? 0),
      largeFiles: Number(aggregate.largeFiles ?? 0),
      sensitiveFiles: Number(aggregate.sensitiveFiles ?? 0),
      needsConfirmation: Number(aggregate.needsConfirmation ?? 0),
      byType: Object.fromEntries(byTypeRows.map((row) => [String(row.key), Number(row.count ?? 0)])),
      byLifecycle: Object.fromEntries(byLifecycleRows.map((row) => [String(row.key), Number(row.count ?? 0)])),
      lastScannedAt: aggregate.lastScannedAt ? String(aggregate.lastScannedAt) : null
    };
  }

  private selectFiles(sql: string, params: Record<string, unknown> = {}): FileRecord[] {
    return (this.db.prepare(sql).all(params) as Row[]).map(deserializeFile);
  }

  private migrate() {
    this.db.exec(`
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
        created_at TEXT NOT NULL,
        disk_total_size INTEGER,
        disk_free_size INTEGER,
        scanned_size INTEGER NOT NULL DEFAULT 0,
        indexed_file_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        summarized_count INTEGER NOT NULL DEFAULT 0
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

      CREATE TABLE IF NOT EXISTS search_sources (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        is_stale INTEGER NOT NULL,
        indexed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        id UNINDEXED,
        name,
        path,
        extension,
        file_type,
        purpose,
        lifecycle,
        context,
        classification_reason,
        tokenize = 'unicode61'
      );
    `);

    this.addMissingColumns("files", {
      dispatch_zone: "TEXT",
      recommended_folder: "TEXT",
      folder_reuse_candidate: "TEXT",
      folder_rename_suggestion: "TEXT",
      dispatch_reason: "TEXT",
      next_action: "TEXT",
      last_opened_at: "TEXT",
      open_count: "INTEGER NOT NULL DEFAULT 0",
      indexed_at: "TEXT",
      source_id: "TEXT",
      is_stale: "INTEGER NOT NULL DEFAULT 0"
    });
    this.addMissingColumns("operation_logs", {
      batch_id: "TEXT NOT NULL DEFAULT 'legacy'",
      path_before: "TEXT NOT NULL DEFAULT ''",
      path_after: "TEXT NOT NULL DEFAULT ''",
      name_before: "TEXT NOT NULL DEFAULT ''",
      name_after: "TEXT NOT NULL DEFAULT ''",
      can_restore: "INTEGER NOT NULL DEFAULT 0",
      restored_at: "TEXT",
      restore_status: "TEXT NOT NULL DEFAULT 'not_restored'",
      restore_error: "TEXT"
    });
    this.addMissingColumns("search_sources", {
      is_stale: "INTEGER NOT NULL DEFAULT 0",
      indexed_at: "TEXT",
      updated_at: "TEXT NOT NULL DEFAULT ''"
    });
    this.addMissingColumns("scan_roots", {
      disk_total_size: "INTEGER",
      disk_free_size: "INTEGER",
      scanned_size: "INTEGER NOT NULL DEFAULT 0",
      indexed_file_count: "INTEGER NOT NULL DEFAULT 0",
      skipped_count: "INTEGER NOT NULL DEFAULT 0",
      summarized_count: "INTEGER NOT NULL DEFAULT 0"
    });

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
      CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
      CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);
      CREATE INDEX IF NOT EXISTS idx_files_modified ON files(modified_at);
      CREATE INDEX IF NOT EXISTS idx_files_source ON files(source_id);
      CREATE INDEX IF NOT EXISTS idx_operation_logs_batch ON operation_logs(batch_id);
      CREATE INDEX IF NOT EXISTS idx_search_sources_path ON search_sources(path);
    `);

    const ftsCount = this.db.prepare("SELECT COUNT(*) AS count FROM files_fts").get() as Row;
    const fileCount = this.db.prepare("SELECT COUNT(*) AS count FROM files").get() as Row;
    if (Number(ftsCount.count ?? 0) === 0 && Number(fileCount.count ?? 0) > 0) {
      this.rebuildSearchIndex();
    }
  }

  private addMissingColumns(table: string, columns: Record<string, string>) {
    const existing = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name)));
    for (const [column, definition] of Object.entries(columns)) {
      if (!existing.has(column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
  }

  private ensureSystemRules() {
    for (const rule of builtInRules) {
      this.saveRule(rule);
    }
  }
}

function serializeFile(file: FileRecord): Record<string, unknown> {
  return {
    id: file.id,
    name: file.name,
    path: file.path,
    directory: file.directory,
    extension: file.extension,
    size: file.size,
    file_type: file.file_type,
    purpose: file.purpose,
    lifecycle: file.lifecycle,
    context: file.context,
    risk_level: file.risk_level,
    hash: file.hash,
    created_at: file.created_at,
    modified_at: file.modified_at,
    scanned_at: file.scanned_at,
    last_seen_at: file.last_seen_at,
    is_hidden: file.is_hidden ? 1 : 0,
    is_deleted: file.is_deleted ? 1 : 0,
    is_duplicate: file.is_duplicate ? 1 : 0,
    suggested_action: file.suggested_action,
    suggested_target_path: file.suggested_target_path,
    suggested_name: file.suggested_name,
    confidence: file.confidence,
    classification_reason: file.classification_reason,
    matched_rules: JSON.stringify(file.matched_rules),
    requires_confirmation: file.requires_confirmation ? 1 : 0,
    dispatch_zone: file.dispatch_zone ?? null,
    recommended_folder: file.recommended_folder ?? null,
    folder_reuse_candidate: file.folder_reuse_candidate ?? null,
    folder_rename_suggestion: file.folder_rename_suggestion ?? null,
    dispatch_reason: file.dispatch_reason ?? null,
    next_action: file.next_action ?? null,
    last_opened_at: file.last_opened_at ?? null,
    open_count: file.open_count ?? 0,
    indexed_at: file.indexed_at ?? nowIso(),
    source_id: file.source_id ?? sourceIdForPath(file.directory),
    is_stale: file.is_stale ? 1 : 0
  };
}

function deserializeFile(row: Row): FileRecord {
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
    context: String(row.context ?? ""),
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
    suggested_target_path: String(row.suggested_target_path ?? ""),
    suggested_name: String(row.suggested_name ?? row.name),
    confidence: Number(row.confidence ?? 0),
    classification_reason: String(row.classification_reason ?? ""),
    matched_rules: JSON.parse(String(row.matched_rules || "[]")) as string[],
    requires_confirmation: Boolean(row.requires_confirmation),
    dispatch_zone: row.dispatch_zone ? row.dispatch_zone as FileRecord["dispatch_zone"] : undefined,
    recommended_folder: row.recommended_folder ? String(row.recommended_folder) : undefined,
    folder_reuse_candidate: row.folder_reuse_candidate ? String(row.folder_reuse_candidate) : undefined,
    folder_rename_suggestion: row.folder_rename_suggestion ? String(row.folder_rename_suggestion) : undefined,
    dispatch_reason: row.dispatch_reason ? String(row.dispatch_reason) : undefined,
    next_action: row.next_action ? String(row.next_action) : undefined,
    last_opened_at: row.last_opened_at ? String(row.last_opened_at) : null,
    open_count: Number(row.open_count ?? 0),
    indexed_at: row.indexed_at ? String(row.indexed_at) : undefined,
    source_id: row.source_id ? String(row.source_id) : undefined,
    is_stale: Boolean(row.is_stale)
  };
}

function serializeOperationLog(log: OperationLog): Record<string, unknown> {
  return {
    id: log.id,
    batch_id: log.batch_id,
    operation_type: log.operation_type,
    source_path: log.source_path,
    target_path: log.target_path,
    old_name: log.old_name,
    new_name: log.new_name,
    status: log.status,
    error_message: log.error_message,
    created_at: log.created_at,
    can_undo: log.can_undo ? 1 : 0,
    path_before: log.path_before,
    path_after: log.path_after,
    name_before: log.name_before,
    name_after: log.name_after,
    can_restore: log.can_restore ? 1 : 0,
    restored_at: log.restored_at,
    restore_status: log.restore_status,
    restore_error: log.restore_error
  };
}

function deserializeOperationLog(row: Row): OperationLog {
  return {
    id: String(row.id),
    batch_id: String(row.batch_id ?? "legacy"),
    operation_type: String(row.operation_type),
    source_path: String(row.source_path),
    target_path: String(row.target_path),
    old_name: String(row.old_name),
    new_name: String(row.new_name),
    status: row.status as OperationLog["status"],
    error_message: row.error_message ? String(row.error_message) : null,
    created_at: String(row.created_at),
    can_undo: Boolean(row.can_undo),
    path_before: String(row.path_before || row.source_path),
    path_after: String(row.path_after || row.target_path),
    name_before: String(row.name_before || row.old_name),
    name_after: String(row.name_after || row.new_name),
    can_restore: Boolean(row.can_restore),
    restored_at: row.restored_at ? String(row.restored_at) : null,
    restore_status: (row.restore_status || "not_restored") as RestoreStatus,
    restore_error: row.restore_error ? String(row.restore_error) : null
  };
}

function deserializeSearchSource(row: Row): SearchSource {
  return {
    id: String(row.id),
    label: String(row.label),
    path: String(row.path),
    type: row.type as SearchSource["type"],
    enabled: Boolean(row.enabled),
    is_stale: Boolean(row.is_stale),
    indexed_at: row.indexed_at ? String(row.indexed_at) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at || row.created_at)
  };
}

function buildStats(files: FileRecord[], scanRoots: ScanRoot[]): DashboardStats {
  const diskTotalSize = sumUniqueRootDiskMetric(scanRoots, "disk_total_size");
  const diskFreeSize = sumUniqueRootDiskMetric(scanRoots, "disk_free_size");
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const stats: DashboardStats = {
    totalFiles: files.length,
    totalSize,
    diskTotalSize,
    diskFreeSize,
    diskUsageRatio: diskTotalSize > 0 ? Math.min(1, totalSize / diskTotalSize) : 0,
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

function sumUniqueRootDiskMetric(scanRoots: ScanRoot[], metric: "disk_total_size" | "disk_free_size"): number {
  const seenVolumes = new Set<string>();
  let total = 0;
  for (const root of scanRoots) {
    const value = Number(root[metric] ?? 0);
    if (!value) continue;
    const volume = volumeKeyForPath(root.path);
    if (seenVolumes.has(volume)) continue;
    seenVolumes.add(volume);
    total += value;
  }
  return total;
}

function volumeKeyForPath(targetPath: string): string {
  const parsed = path.parse(path.resolve(targetPath));
  return parsed.root.toLowerCase() || targetPath.toLowerCase();
}

function parseSearch(input: string): { tokens: string[]; extension: string | null } {
  const rawTokens = input.split(/\s+/).map((token) => token.trim()).filter(Boolean);
  let extension: string | null = null;
  const tokens: string[] = [];
  for (const token of rawTokens) {
    const extMatch = token.match(/^ext:(.+)$/i);
    if (extMatch) {
      extension = extMatch[1].replace(/^\./, "").toLowerCase();
    } else if (token.startsWith(".") && token.length > 1) {
      extension = token.slice(1).toLowerCase();
    } else {
      tokens.push(token);
    }
  }
  return { tokens, extension };
}

function buildFtsExpression(tokens: string[]): string {
  return tokens
    .map((token) => token.replace(/["*]/g, "").trim())
    .filter(Boolean)
    .map((token) => `"${token}"*`)
    .join(" AND ");
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (char) => `\\${char}`);
}

function escapeSqlLike(value: string): string {
  return value.replace(/[!%_]/g, (char) => `!${char}`);
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(Number(value))));
}

function sourceIdForPath(directory: string): string {
  return stableId(directory);
}

function findSourceIdForFile(file: FileRecord, sources: SearchSource[]): string | null {
  const matched = sources
    .filter((source) => isSameOrInside(file.path, source.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return matched?.id ?? null;
}

function isSameOrInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
