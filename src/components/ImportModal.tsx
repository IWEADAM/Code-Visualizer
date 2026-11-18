import React, { useState, useRef } from 'react';
import {
  Upload,
  Sparkles,
  FileCode,
  Play,
  X,
  FolderUp,
} from 'lucide-react';
import JSZip from 'jszip';
import { buildProjectModel } from '../engine/parser';
import { ProjectModel } from '../types/codeMap';

interface ImportModalProps {
  isOpen: boolean;
  canClose: boolean;
  animKey?: number;
  onClose: () => void;
  onSelectProject: (project: ProjectModel) => void;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  isOpen,
  canClose,
  animKey = 0,
  onClose,
  onSelectProject,
}) => {
  const [repoInput, setRepoInput] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [pasteMode, setPasteMode] = useState(false);
  const [pastedFileName, setPastedFileName] = useState('src/main.py');
  const [pastedCode, setPastedCode] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleImportGitHubUrl = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = repoInput.trim();
    if (!trimmed) {
      setImportError('Please enter a GitHub repository URL or upload your project files.');
      return;
    }

    setIsImporting(true);
    setImportError(null);
    try {
      const response = await fetch('/api/repo/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: trimmed }),
      });
      const data = await response.json();
      if (!response.ok) {
        setImportError(data.error || 'Could not import repository.');
      } else {
        const built = buildProjectModel(
          `git-${Date.now()}`,
          data.name,
          data.description,
          data.files,
          {},
          [],
          trimmed
        );
        onSelectProject(built);
        onClose();
      }
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : 'Failed to import Git URL');
    } finally {
      setIsImporting(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    setIsImporting(true);
    setImportError(null);
    try {
      const rawFiles: Array<{ path: string; content: string }> = [];

      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        if (file.name.endsWith('.zip')) {
          const zip = await JSZip.loadAsync(file);
          const entries = Object.keys(zip.files);
          for (const entryPath of entries) {
            const zipEntry = zip.files[entryPath];
            if (
              !zipEntry.dir &&
              !entryPath.includes('node_modules/') &&
              !entryPath.includes('.git/') &&
              /\.(py|ts|tsx|js|jsx|java|cpp|c|rs|go|php|cs|html|css|json|md)$/i.test(entryPath)
            ) {
              const text = await zipEntry.async('string');
              rawFiles.push({ path: entryPath, content: text });
            }
          }
        } else {
          const text = await file.text();
          const relPath =
            (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
            `src/${file.name}`;
          rawFiles.push({ path: relPath, content: text });
        }
      }

      if (rawFiles.length === 0) {
        setImportError('No readable source files found in selection.');
        return;
      }

      const project = buildProjectModel(
        `upload-${Date.now()}`,
        rawFiles[0].path.split('/')[0] || 'uploaded-project',
        `Uploaded ${rawFiles.length} source file(s) for interactive visualization.`,
        rawFiles,
        {}
      );
      onSelectProject(project);
      onClose();
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : 'Error reading uploaded files');
    } finally {
      setIsImporting(false);
    }
  };

  const handleAnalyzePastedSnippet = () => {
    if (!pastedCode.trim()) {
      setImportError('Please paste or type source code before analyzing.');
      return;
    }
    setImportError(null);
    const project = buildProjectModel(
      `snippet-${Date.now()}`,
      pastedFileName.split('/').pop() || 'custom-code',
      'Custom source code analyzed into AST, Control-Flow Graph, and Execution Model.',
      [{ path: pastedFileName || 'src/main.py', content: pastedCode }],
      {}
    );
    onSelectProject(project);
    onClose();
  };

  return (
    <div
      key={animKey}
      role="dialog"
      aria-modal="true"
      aria-label="Import Repository or Source Files"
      className="fixed inset-x-0 top-[53px] bottom-0 z-40 bg-[#0e0f12]/95 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto animate-fade-in"
    >
      <div className="w-full max-w-3xl mx-auto flex flex-col items-center text-center relative py-8 animate-fade-in">
        {canClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Import Dialog"
            className="absolute top-2 right-2 p-2 rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Calm Blue Top Pill Header */}
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-blue-500/10 border border-blue-400/25 mb-5">
          <span className="w-5 h-5 rounded-full bg-blue-600 text-[11px] font-bold text-white flex items-center justify-center">
            4
          </span>
          <span className="text-xs font-medium text-blue-200">
            Static AST + Gemini 4 Hydrogen
          </span>
        </div>

        {/* Main Display Headline */}
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-white mb-3">
          Import a repository or files to visualize
        </h1>
        <p className="text-sm text-zinc-400 max-w-xl mb-7">
          Connect a GitHub repository URL, upload individual files, folders, or a .ZIP archive, or paste source code to generate an interactive execution map.
        </p>

        {/* Calm Blue Input Area */}
        <div className="w-full studio-glow-box studio-glow-ambient p-5 text-left">
          {!pasteMode ? (
            <form onSubmit={handleImportGitHubUrl} className="animate-fade-in">
              <label htmlFor="repo-url-input" className="sr-only">
                GitHub Repository URL
              </label>
              <input
                id="repo-url-input"
                type="text"
                value={repoInput}
                onChange={(e) => {
                  setRepoInput(e.target.value);
                  if (importError) setImportError(null);
                }}
                placeholder="Paste a GitHub repository URL (e.g. https://github.com/owner/repository)..."
                className="w-full bg-transparent text-sm text-white placeholder-zinc-500 focus:outline-none pb-8"
              />

              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-blue-500/15">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".py,.js,.ts,.tsx,.jsx,.java,.cpp,.c,.rs,.go,.php,.cs,.html,.css,.json,.zip"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  <input
                    ref={folderInputRef}
                    type="file"
                    multiple
                    {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3.5 py-1.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 border border-blue-400/25 text-xs font-medium text-blue-200 flex items-center gap-1.5 transition-colors"
                  >
                    <Upload className="w-3.5 h-3.5 text-blue-400" />
                    Upload Files / .ZIP
                  </button>
                  <button
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    className="px-3.5 py-1.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 border border-blue-400/25 text-xs font-medium text-blue-200 flex items-center gap-1.5 transition-colors"
                  >
                    <FolderUp className="w-3.5 h-3.5 text-blue-400" />
                    Upload Folder
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPasteMode(true);
                      setImportError(null);
                    }}
                    className="px-3.5 py-1.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 border border-blue-400/25 text-xs font-medium text-blue-200 flex items-center gap-1.5 transition-colors"
                  >
                    <FileCode className="w-3.5 h-3.5 text-blue-400" />
                    Write / Paste Code
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={isImporting}
                    className="px-4 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white flex items-center gap-1.5 transition-colors shadow-sm"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {isImporting ? 'Analyzing Repo...' : 'Import Repository'}
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <div className="space-y-3 animate-fade-in">
              <div className="flex items-center justify-between">
                <input
                  type="text"
                  value={pastedFileName}
                  onChange={(e) => setPastedFileName(e.target.value)}
                  aria-label="Custom file path"
                  placeholder="src/main.py"
                  className="bg-[#1b202c] border border-blue-400/25 rounded-lg px-2.5 py-1 font-mono text-xs text-white focus:outline-none focus:border-blue-400"
                />
                <button
                  type="button"
                  onClick={() => {
                    setPasteMode(false);
                    setImportError(null);
                  }}
                  className="text-xs text-blue-300 hover:text-white transition-colors"
                >
                  ← Back to Git / File Upload
                </button>
              </div>
              <textarea
                rows={7}
                value={pastedCode}
                onChange={(e) => {
                  setPastedCode(e.target.value);
                  if (importError) setImportError(null);
                }}
                placeholder="Paste your Python, TypeScript, JavaScript, Java, C++, Go, or Rust code here..."
                aria-label="Custom source code"
                className="w-full bg-[#0f1218] border border-blue-400/20 rounded-xl p-3 font-mono text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-400"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleAnalyzePastedSnippet}
                  className="px-4 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white flex items-center gap-1.5 transition-colors"
                >
                  <Play className="w-3.5 h-3.5" />
                  Build Visual Map
                </button>
              </div>
            </div>
          )}
        </div>

        {importError && (
          <p className="mt-3 text-xs text-blue-200 bg-blue-950/60 border border-blue-400/30 px-3.5 py-2 rounded-xl animate-fade-in">
            {importError}
          </p>
        )}
      </div>
    </div>
  );
};
