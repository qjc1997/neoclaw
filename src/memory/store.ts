/**
 * MemoryStore — SQLite FTS5 index for memory entries.
 *
 * Markdown files under `episodes/` and `knowledge/` are the source of truth.
 * This store provides full-text search over their content.
 */

import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface MemoryEntry {
  /** File name without extension. */
  id: string;
  category: 'episode' | 'knowledge' | 'identity';
  title: string;
  /** Markdown body. */
  content: string;
  tags: string[];
  /** ISO date string. */
  date: string;
}

export class MemoryStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this._initSchema();
  }

  private _initSchema(): void {
    // Regular table for metadata + FTS5 virtual table for full-text search.
    this.db.run(`CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL
    )`);
    this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id, category, title, content, tags, date,
      content='memory',
      content_rowid='rowid',
      tokenize='unicode61'
    )`);
    // Triggers to keep FTS in sync with the content table
    this.db.run(`CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, id, category, title, content, tags, date)
        VALUES (new.rowid, new.id, new.category, new.title, new.content, new.tags, new.date);
    END`);
    this.db.run(`CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, id, category, title, content, tags, date)
        VALUES ('delete', old.rowid, old.id, old.category, old.title, old.content, old.tags, old.date);
    END`);
    this.db.run(`CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, id, category, title, content, tags, date)
        VALUES ('delete', old.rowid, old.id, old.category, old.title, old.content, old.tags, old.date);
      INSERT INTO memory_fts(rowid, id, category, title, content, tags, date)
        VALUES (new.rowid, new.id, new.category, new.title, new.content, new.tags, new.date);
    END`);
  }

  upsert(entry: MemoryEntry): void {
    const tags = entry.tags.join(',');
    this.db.run(
      `INSERT INTO memory (id, category, title, content, tags, date)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         category=excluded.category, title=excluded.title, content=excluded.content,
         tags=excluded.tags, date=excluded.date`,
      [entry.id, entry.category, entry.title, entry.content, tags, entry.date]
    );
  }

  delete(id: string): void {
    this.db.run('DELETE FROM memory WHERE id = ?', [id]);
  }

  search(query: string, opts?: { category?: string; limit?: number }): MemoryEntry[] {
    const limit = opts?.limit ?? 10;
    type Row = {
      id: string;
      category: string;
      title: string;
      content: string;
      tags: string;
      date: string;
    };

    let rows: Row[];
    if (opts?.category) {
      rows = this.db
        .query(
          `SELECT m.id, m.category, m.title, m.content, m.tags, m.date
         FROM memory_fts f JOIN memory m ON f.rowid = m.rowid
         WHERE memory_fts MATCH ? AND m.category = ?
         ORDER BY rank LIMIT ?`
        )
        .all(query, opts.category, limit) as Row[];
    } else {
      rows = this.db
        .query(
          `SELECT m.id, m.category, m.title, m.content, m.tags, m.date
         FROM memory_fts f JOIN memory m ON f.rowid = m.rowid
         WHERE memory_fts MATCH ?
         ORDER BY rank LIMIT ?`
        )
        .all(query, limit) as Row[];
    }

    return rows.map((r) => ({
      id: r.id,
      category: r.category as MemoryEntry['category'],
      title: r.title,
      content: r.content,
      tags: r.tags ? r.tags.split(',') : [],
      date: r.date,
    }));
  }

  list(opts?: { category?: string }): Array<{
    id: string;
    title: string;
    category: string;
    tags: string[];
    date: string;
  }> {
    type ListRow = { id: string; title: string; category: string; tags: string; date: string };

    let rows: ListRow[];
    if (opts?.category) {
      rows = this.db
        .query(
          'SELECT id, title, category, tags, date FROM memory WHERE category = ? ORDER BY date DESC'
        )
        .all(opts.category) as ListRow[];
    } else {
      rows = this.db
        .query('SELECT id, title, category, tags, date FROM memory ORDER BY date DESC')
        .all() as ListRow[];
    }

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      tags: r.tags ? r.tags.split(',') : [],
      date: r.date,
    }));
  }

  /** Rebuild index from markdown files on disk. */
  reindex(memoryDir: string): void {
    this.db.run('DELETE FROM memory');

    // Index SOUL.md as identity memory
    const soulPath = join(memoryDir, 'SOUL.md');
    if (existsSync(soulPath)) {
      const content = readFileSync(soulPath, 'utf-8');
      this.upsert({
        id: 'SOUL',
        category: 'identity',
        title: 'Soul — Personality & Values',
        content,
        tags: ['identity', 'personality'],
        date: new Date().toISOString().slice(0, 10),
      });
    }

    for (const category of ['episodes', 'knowledge'] as const) {
      const dir = join(memoryDir, category);
      if (!existsSync(dir)) continue;

      let entries: string[];
      try {
        entries = readdirSync(dir).filter((f) => f.endsWith('.md'));
      } catch {
        continue;
      }

      const cat = category === 'episodes' ? 'episode' : 'knowledge';
      for (const file of entries) {
        const content = readFileSync(join(dir, file), 'utf-8');
        const parsed = parseFrontmatter(content);
        const id = basename(file, '.md');

        this.upsert({
          id,
          category: cat,
          title: parsed.title || id,
          content: parsed.body,
          tags: parsed.tags,
          date: parsed.date || new Date().toISOString().slice(0, 10),
        });
      }
    }
  }

  close(): void {
    this.db.close();
  }
}

// ── Frontmatter parser ────────────────────────────────────────

interface Frontmatter {
  title: string;
  tags: string[];
  date: string;
  body: string;
}

function parseFrontmatter(content: string): Frontmatter {
  const result: Frontmatter = { title: '', tags: [], date: '', body: content };

  if (!content.startsWith('---')) return result;

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return result;

  const fm = content.slice(3, endIdx).trim();
  result.body = content.slice(endIdx + 3).trim();

  for (const line of fm.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();

    if (key === 'title') {
      result.title = val.replace(/^["']|["']$/g, '');
    } else if (key === 'date') {
      result.date = val;
    } else if (key === 'tags') {
      // Support: tags: [a, b, c] or tags: a, b, c
      const stripped = val.replace(/^\[|\]$/g, '');
      result.tags = stripped
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
  }

  return result;
}
