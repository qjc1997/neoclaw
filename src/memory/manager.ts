/**
 * MemoryManager — memory lifecycle management and tool handlers.
 *
 * Provides:
 * - memory_search / memory_save / memory_list tool handlers (registered on Agent)
 * - Session summarization on /clear or /new
 * - Index rebuild on startup
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { MemoryStore } from './store.js';
import { summarizeTranscript } from './summarizer.js';

const log = logger('memory');

const REINDEX_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export const KNOWLEDGE_TOPICS = {
  'owner-profile': 'Owner personal info, background, career',
  'preferences': 'Preferences, habits, tools, workflow',
  'people': 'People and contacts',
  'projects': 'Project notes, technical decisions',
  'notes': 'General knowledge and miscellaneous',
} as const;

export type KnowledgeTopic = keyof typeof KNOWLEDGE_TOPICS;

export class MemoryManager {
  private _reindexTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly memoryDir: string,
    private readonly store: MemoryStore
  ) {}

  // ── Tool handlers (return stringified results for the agent) ──

  async handleSearch(input: unknown): Promise<string> {
    const { query, category } = input as { query: string; category?: string };
    if (!query) return 'Error: "query" is required.';

    try {
      const results = this.store.search(query, {
        category: category as 'episode' | 'knowledge' | undefined,
        limit: 5,
      });

      if (results.length === 0) return 'No matching memories found.';

      return results
        .map((r) => {
          const tagStr = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : '';
          return `### ${r.title}${tagStr}\n**Category**: ${r.category} | **Date**: ${r.date}\n\n${r.content}`;
        })
        .join('\n\n---\n\n');
    } catch (err) {
      return `Search error: ${err}`;
    }
  }

  async handleSave(input: unknown): Promise<string> {
    const { topic, content, tags, category } = input as {
      topic: string;
      content: string;
      tags?: string[];
      category?: string;
    };
    if (!content) return 'Error: "content" is required.';

    try {
      const date = new Date().toISOString().slice(0, 10);

      // Identity memory: write directly to SOUL.md (topic is ignored)
      if (category === 'identity') {
        const soulPath = join(this.memoryDir, 'SOUL.md');
        writeFileSync(soulPath, content, 'utf-8');
        this.store.upsert({
          id: 'SOUL',
          category: 'identity',
          title: 'Soul — Personality & Values',
          content,
          tags: ['identity', 'personality'],
          date,
        });
        log.info('SOUL.md updated via memory_save');
        return 'Identity memory (SOUL.md) updated successfully.';
      }

      // Knowledge memory: write to knowledge/<topic>.md
      if (!topic) return 'Error: "topic" is required for knowledge memory.';
      if (!(topic in KNOWLEDGE_TOPICS))
        return `Error: invalid topic "${topic}". Must be one of: ${Object.keys(KNOWLEDGE_TOPICS).join(', ')}`;

      const tagList = tags ?? [];

      const frontmatter = [
        '---',
        `title: "${KNOWLEDGE_TOPICS[topic as KnowledgeTopic]}"`,
        `date: ${date}`,
        `tags: [${tagList.join(', ')}]`,
        '---',
      ].join('\n');
      const markdown = `${frontmatter}\n\n${content}\n`;

      const knowledgeDir = join(this.memoryDir, 'knowledge');
      if (!existsSync(knowledgeDir)) mkdirSync(knowledgeDir, { recursive: true });
      writeFileSync(join(knowledgeDir, `${topic}.md`), markdown, 'utf-8');

      this.store.upsert({
        id: topic,
        category: 'knowledge',
        title: KNOWLEDGE_TOPICS[topic as KnowledgeTopic],
        content,
        tags: tagList,
        date,
      });

      log.info(`Saved knowledge: "${topic}" (${topic}.md)`);
      return `Memory saved: "${topic}" (knowledge/${topic}.md)`;
    } catch (err) {
      return `Save error: ${err}`;
    }
  }

  async handleList(input: unknown): Promise<string> {
    const { category } = (input ?? {}) as { category?: string };

    try {
      const items = this.store.list({
        category: category as 'episode' | 'knowledge' | undefined,
      });

      if (items.length === 0) return 'No memories stored yet.';

      const lines = items.map((item) => {
        const tagStr = item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : '';
        return `- **${item.title}**${tagStr} (${item.category}, ${item.date})`;
      });
      return lines.join('\n');
    } catch (err) {
      return `List error: ${err}`;
    }
  }

  // ── Session summarization ─────────────────────────────────

  /**
   * Generate an episodic memory entry from conversation history.
   * Called before /clear or /new wipes the session.
   */
  async summarizeSession(conversationId: string, workspacesDir: string): Promise<void> {
    const sanitized = conversationId.replace(/:/g, '_');
    const historyDir = join(workspacesDir, sanitized, '.neoclaw', '.history');

    if (!existsSync(historyDir)) {
      log.debug(`No history directory for "${conversationId}", skipping summarization`);
      return;
    }

    // Collect all history files, sorted by date
    let files: string[];
    try {
      files = readdirSync(historyDir)
        .filter((f) => f.endsWith('.txt'))
        .sort();
    } catch {
      return;
    }

    if (files.length === 0) return;

    // Read the offset marker: { "<filename>": <byteOffset>, ... }
    // This tracks how far we've already summarized in each file.
    const markerPath = join(historyDir, '.last-summarized-offset');
    let offsets: Record<string, number> = {};
    try {
      if (existsSync(markerPath)) {
        offsets = JSON.parse(readFileSync(markerPath, 'utf-8'));
      }
    } catch {
      offsets = {};
    }

    // Only read unsummarized content from each file
    const newParts: string[] = [];
    const newOffsets: Record<string, number> = { ...offsets };

    for (const file of files) {
      const filePath = join(historyDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const prevOffset = offsets[file] ?? 0;

      if (prevOffset >= content.length) continue; // already fully summarized
      const newContent = content.slice(prevOffset).trim();
      if (newContent) newParts.push(newContent);

      newOffsets[file] = content.length;
    }

    if (newParts.length === 0) {
      log.debug(`No new history for "${conversationId}", skipping summarization`);
      return;
    }

    const transcript = newParts.join('\n').trim();

    if (transcript.length < 100) {
      // Still update offsets so we don't re-read this tiny content next time
      writeFileSync(markerPath, JSON.stringify(newOffsets, null, 2), 'utf-8');
      log.debug(`Transcript too short for "${conversationId}", skipping summarization`);
      return;
    }

    // Truncate very long transcripts to avoid token limits
    const maxChars = 50_000;
    const truncated = transcript.length > maxChars ? transcript.slice(-maxChars) : transcript;

    try {
      const summaryMd = await summarizeTranscript(truncated);

      // Write to episodes/ directory
      const episodesDir = join(this.memoryDir, 'episodes');
      if (!existsSync(episodesDir)) mkdirSync(episodesDir, { recursive: true });

      const date = new Date().toISOString().slice(0, 10);
      const ts = Date.now();
      const suffix = sanitized.slice(0, 20);
      const fileName = `${date}_${suffix}_${ts}.md`;
      writeFileSync(join(episodesDir, fileName), summaryMd, 'utf-8');

      // Re-index this entry
      const id = fileName.replace('.md', '');
      const titleMatch = summaryMd.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
      const title = titleMatch?.[1] ?? `Session ${date}`;

      this.store.upsert({
        id,
        category: 'episode',
        title,
        content: summaryMd,
        tags: [],
        date,
      });

      // Persist offsets only after successful summarization
      writeFileSync(markerPath, JSON.stringify(newOffsets, null, 2), 'utf-8');
      log.info(`Session summary saved: ${fileName}`);
    } catch (err) {
      log.warn(`Failed to summarize session "${conversationId}": ${err}`);
    }
  }

  // ── Index management ──────────────────────────────────────

  reindex(): void {
    log.info('Rebuilding memory index…');
    this.store.reindex(this.memoryDir);
    const count = this.store.list().length;
    log.info(`Memory index rebuilt: ${count} entries`);
  }

  /** Start periodic reindexing to pick up external file changes. */
  startPeriodicReindex(): void {
    if (this._reindexTimer) return;
    this._reindexTimer = setInterval(() => {
      try {
        this.store.reindex(this.memoryDir);
        log.debug('Periodic reindex completed');
      } catch (err) {
        log.warn(`Periodic reindex failed: ${err}`);
      }
    }, REINDEX_INTERVAL_MS);
    if (typeof this._reindexTimer.unref === 'function') this._reindexTimer.unref();
    log.info(`Periodic reindex scheduled every ${REINDEX_INTERVAL_MS / 1000}s`);
  }

  stopPeriodicReindex(): void {
    if (this._reindexTimer) {
      clearInterval(this._reindexTimer);
      this._reindexTimer = null;
    }
  }
}
