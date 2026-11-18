import fs from 'fs';
import path from 'path';
import { detectLanguage } from './parser';

export interface SavedRepoRecord {
  id: string;
  name: string;
  description: string;
  repoUrl: string;
  language: string;
  fileCount: number;
  files: Array<{ path: string; content: string }>;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'repo-history.json');

function ensureDbFile(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify([], null, 2), 'utf-8');
  }
}

export function sanitizeRepoId(rawId: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 120);
  return cleaned || `repo-${Date.now()}`;
}

export function detectPrimaryLanguage(files: Array<{ path: string; content: string }>): string {
  if (!files || files.length === 0) return 'Unknown';
  const counts: Record<string, number> = {};
  for (const f of files) {
    const { language } = detectLanguage(f.path);
    counts[language] = (counts[language] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || 'Unknown';
}

export function listSavedRepos(dbPath: string = DEFAULT_DB_PATH): SavedRepoRecord[] {
  ensureDbFile(dbPath);
  try {
    const raw = fs.readFileSync(dbPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as SavedRepoRecord[]).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  } catch {
    return [];
  }
}

export function getSavedRepoById(
  id: string,
  dbPath: string = DEFAULT_DB_PATH
): SavedRepoRecord | null {
  const all = listSavedRepos(dbPath);
  return all.find((r) => r.id === id) || null;
}

export function saveRepoToHistory(
  input: {
    id?: string;
    name: string;
    description?: string;
    repoUrl?: string;
    files: Array<{ path: string; content: string }>;
  },
  dbPath: string = DEFAULT_DB_PATH
): SavedRepoRecord {
  ensureDbFile(dbPath);
  const all = listSavedRepos(dbPath);
  const nowIso = new Date().toISOString();

  const cleanFiles = (input.files || []).slice(0, 50).map((f) => ({
    path: String(f.path || 'src/main.py').slice(0, 240),
    content: String(f.content || '').slice(0, 60000),
  }));

  const normalizedUrl = String(input.repoUrl || '').trim().slice(0, 500);
  const normalizedName = String(input.name || 'unnamed-repo').trim().slice(0, 120) || 'unnamed-repo';
  const language = detectPrimaryLanguage(cleanFiles).slice(0, 60);

  // Deduplicate by repoUrl (if GitHub URL) or by id/name
  const existingIdx = all.findIndex(
    (item) =>
      (input.id && item.id === input.id) ||
      (normalizedUrl !== '' && item.repoUrl.toLowerCase() === normalizedUrl.toLowerCase()) ||
      (normalizedUrl === '' && item.name.toLowerCase() === normalizedName.toLowerCase())
  );

  if (existingIdx >= 0) {
    const existing = all[existingIdx];
    const updated: SavedRepoRecord = {
      ...existing,
      name: normalizedName,
      description: String(input.description || existing.description || '').slice(0, 500),
      repoUrl: normalizedUrl,
      language,
      fileCount: cleanFiles.length,
      files: cleanFiles,
      updatedAt: nowIso,
    };
    all[existingIdx] = updated;
    fs.writeFileSync(dbPath, JSON.stringify(all, null, 2), 'utf-8');
    return updated;
  }

  const newId = sanitizeRepoId(
    input.id || `repo-${normalizedName.toLowerCase()}-${Date.now().toString(36)}`
  );
  const record: SavedRepoRecord = {
    id: newId,
    name: normalizedName,
    description: String(input.description || `Saved project (${cleanFiles.length} files)`).slice(
      0,
      500
    ),
    repoUrl: normalizedUrl,
    language,
    fileCount: cleanFiles.length,
    files: cleanFiles,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  all.unshift(record);
  fs.writeFileSync(dbPath, JSON.stringify(all.slice(0, 100), null, 2), 'utf-8');
  return record;
}

export function deleteSavedRepo(id: string, dbPath: string = DEFAULT_DB_PATH): boolean {
  ensureDbFile(dbPath);
  const all = listSavedRepos(dbPath);
  const filtered = all.filter((item) => item.id !== id);
  if (filtered.length === all.length) return false;
  fs.writeFileSync(dbPath, JSON.stringify(filtered, null, 2), 'utf-8');
  return true;
}
