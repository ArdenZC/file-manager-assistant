DROP TRIGGER IF EXISTS files_ai;
DROP TRIGGER IF EXISTS files_ad;
DROP TRIGGER IF EXISTS files_au;
DROP TABLE IF EXISTS files_fts;

CREATE VIRTUAL TABLE files_fts USING fts5(
    name,
    path,
    content='files',
    content_rowid='rowid',
    tokenize='trigram'
);

INSERT INTO files_fts(files_fts) VALUES('rebuild');

CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts(rowid, name, path)
    VALUES (new.rowid, new.name, new.path);
END;

CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name, path)
    VALUES('delete', old.rowid, old.name, old.path);
END;

CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name, path)
    VALUES('delete', old.rowid, old.name, old.path);
    INSERT INTO files_fts(rowid, name, path)
    VALUES (new.rowid, new.name, new.path);
END;
