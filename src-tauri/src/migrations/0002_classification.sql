ALTER TABLE files ADD COLUMN ctime INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN file_type TEXT NOT NULL DEFAULT 'Other';
ALTER TABLE files ADD COLUMN purpose TEXT NOT NULL DEFAULT 'Unknown';
ALTER TABLE files ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'Inbox';
ALTER TABLE files ADD COLUMN context TEXT NOT NULL DEFAULT '';
ALTER TABLE files ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'Normal';
ALTER TABLE files ADD COLUMN suggested_action TEXT NOT NULL DEFAULT 'Keep';
ALTER TABLE files ADD COLUMN suggested_target_path TEXT NOT NULL DEFAULT '';
ALTER TABLE files ADD COLUMN suggested_name TEXT NOT NULL DEFAULT '';
ALTER TABLE files ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
ALTER TABLE files ADD COLUMN classification_reason TEXT NOT NULL DEFAULT 'Indexed by Zen Canvas Tauri backend.';
ALTER TABLE files ADD COLUMN matched_rules TEXT NOT NULL DEFAULT '[]';
ALTER TABLE files ADD COLUMN requires_confirmation INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_files_file_type ON files(file_type);
CREATE INDEX IF NOT EXISTS idx_files_purpose ON files(purpose);
CREATE INDEX IF NOT EXISTS idx_files_lifecycle ON files(lifecycle);
CREATE INDEX IF NOT EXISTS idx_files_risk_level ON files(risk_level);
CREATE INDEX IF NOT EXISTS idx_files_requires_confirmation ON files(requires_confirmation);
