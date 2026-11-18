import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

dotenv.config();

const PORT = 3000;

function getGenAIClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // 1. Server-side Gemini Node Explanation endpoint
  app.post('/api/ai/explain-node', async (req, res) => {
    try {
      const { node, fileContent, projectSummary, runtimeObserved } = req.body;
      if (!node) {
        res.status(400).json({ error: 'Missing node payload' });
        return;
      }

      const ai = getGenAIClient();
      if (!ai) {
        res.status(503).json({
          error:
            'GEMINI_API_KEY is not configured. Showing deterministic static AST analysis. Configure GEMINI_API_KEY in Settings > Secrets for live Gemini explanations.',
        });
        return;
      }

      const prompt = `You are a rigorous static analysis & execution flow tutor for a developer tool called CodeAtlas ("Google Maps for code").
Analyze the selected Control-Flow Node strictly based on the provided AST/CFG metadata and source snippet.
Do NOT hallucinate behavior that is not in the code. Explicitly distinguish what is proven by static analysis, what was observed at runtime, and what is inferred.

Project Context:
${projectSummary || 'Multi-file repository'}

Selected Node:
- Label: ${node.label}
- Kind: ${node.kind}
- File: ${node.file} (Line ${node.location?.startLine})
- Function: ${node.functionName || 'module'}
- Expression: ${node.expression || 'N/A'}
- Variables Read: ${(node.variablesRead || []).join(', ') || 'None'}
- Variables Written: ${(node.variablesWritten || []).join(', ') || 'None'}
- Runtime Observed Data: ${runtimeObserved ? JSON.stringify(runtimeObserved) : 'Not executed yet'}

Relevant File Source Code:
\`\`\`
${(fileContent || '').slice(0, 3500)}
\`\`\``;

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              whatItDoes: {
                type: Type.STRING,
                description: 'Clear 1-2 sentence explanation of what this node does.',
              },
              whyItExists: {
                type: Type.STRING,
                description: 'Why this construct exists in the broader program flow.',
              },
              inputs: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Variables or parameters entering this node.',
              },
              outputs: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Return values, state changes, or branch outcomes.',
              },
              dependencies: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'External functions or modules this node relies on.',
              },
              possiblePaths: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Concrete next paths (e.g. TRUE -> line X, FALSE -> line Y).',
              },
              beginnerExplanation: {
                type: Type.STRING,
                description: 'Friendly explanation for someone new to this codebase.',
              },
              confidenceNote: {
                type: Type.STRING,
                description:
                  'Explicit note distinguishing Static Analysis Proof vs Observed Runtime vs AI Inference.',
              },
            },
            required: [
              'whatItDoes',
              'whyItExists',
              'inputs',
              'outputs',
              'dependencies',
              'possiblePaths',
              'beginnerExplanation',
              'confidenceNote',
            ],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json({
        nodeId: node.id,
        provenance: runtimeObserved ? 'runtime_observed' : 'ai_inferred',
        ...parsed,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to generate AI node explanation';
      res.status(500).json({ error: msg });
    }
  });

  // 2. Server-side Gemini Repository-Aware Chat endpoint
  app.post('/api/ai/chat', async (req, res) => {
    try {
      const { question, projectContext, activeFile, activeNode, traceSummary } = req.body;
      if (!question) {
        res.status(400).json({ error: 'Missing question' });
        return;
      }

      const ai = getGenAIClient();
      if (!ai) {
        res.status(503).json({
          error:
            'GEMINI_API_KEY is not configured in Settings > Secrets. Please configure your key to use live AI chat.',
        });
        return;
      }

      const prompt = `You are the CodeAtlas Repository Assistant. Answer the developer's question about the loaded repository accurately without hallucinating.
Always cite specific file paths, function names, and line numbers (e.g. \`src/auth.py:6\` or \`authenticate_user()\`) so the UI can turn them into clickable map links.
Explicitly state whether each point is:
- [Proven by Static Analysis]
- [Observed During Execution]
- [AI Inference]

Repository Structure & Call Graph:
${projectContext}

Currently Focused File: ${activeFile || 'None'}
Currently Focused Node: ${activeNode || 'None'}
Latest Execution Trace Summary: ${traceSummary || 'Not run'}

Developer Question:
${question}`;

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
      });

      res.json({
        answer: response.text || 'Unable to generate response.',
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'AI Chat request failed';
      res.status(500).json({ error: msg });
    }
  });

  // 3. GitHub Repository Importer Endpoint
  app.post('/api/repo/import', async (req, res) => {
    try {
      const { repoUrl } = req.body;
      if (!repoUrl || typeof repoUrl !== 'string') {
        res.status(400).json({ error: 'Please provide a valid GitHub repository URL.' });
        return;
      }

      const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.\s]+)/i);
      if (!match) {
        res.status(400).json({
          error: 'Supported URL format: https://github.com/<owner>/<repo>',
        });
        return;
      }

      const owner = match[1];
      const repo = match[2];

      const repoMetaResp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { 'User-Agent': 'CodeAtlas-Studio' },
      });
      if (!repoMetaResp.ok) {
        res.status(repoMetaResp.status).json({
          error: `GitHub API returned ${repoMetaResp.status}: unable to fetch ${owner}/${repo}`,
        });
        return;
      }
      const repoMeta = (await repoMetaResp.json()) as {
        default_branch?: string;
        description?: string;
      };
      const branch = repoMeta.default_branch || 'main';

      const treeResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        { headers: { 'User-Agent': 'CodeAtlas-Studio' } }
      );
      if (!treeResp.ok) {
        res.status(treeResp.status).json({ error: 'Failed to read repository tree from GitHub.' });
        return;
      }

      const treeData = (await treeResp.json()) as {
        tree: Array<{ path: string; type: string; size?: number }>;
      };

      const codeExtensions = /\.(py|ts|tsx|js|jsx|java|cpp|c|rs|go|php|cs|json)$/i;
      const candidateBlobs = (treeData.tree || [])
        .filter(
          (item) =>
            item.type === 'blob' &&
            codeExtensions.test(item.path) &&
            !item.path.includes('node_modules/') &&
            !item.path.includes('dist/') &&
            !item.path.includes('package-lock.json') &&
            (item.size || 0) < 60000
        )
        .slice(0, 14);

      const files: Array<{ path: string; content: string }> = [];
      for (const blob of candidateBlobs) {
        const rawResp = await fetch(
          `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${blob.path}`
        );
        if (rawResp.ok) {
          const content = await rawResp.text();
          files.push({ path: blob.path, content });
        }
      }

      if (files.length === 0) {
        res.status(404).json({ error: 'No supported source files found in this repository.' });
        return;
      }

      res.json({
        name: repo,
        description: repoMeta.description || `Imported from github.com/${owner}/${repo}`,
        repoUrl,
        files,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Repository import failed';
      res.status(500).json({ error: msg });
    }
  });

  // 4. Ready-to-Unzip Full Project Archive Endpoint (/api/project-zip)
  app.get('/api/project-zip', async (_req, res) => {
    try {
      const zip = new JSZip();
      const rootDir = process.cwd();

      const includeFiles = [
        '.env.example',
        '.gitignore',
        'index.html',
        'metadata.json',
        'package.json',
        'tsconfig.json',
        'vite.config.ts',
        'server.ts',
        'README.md',
      ];

      for (const relPath of includeFiles) {
        const fullPath = path.join(rootDir, relPath);
        if (fs.existsSync(fullPath)) {
          zip.file(relPath, fs.readFileSync(fullPath, 'utf-8'));
        }
      }

      const addDirRecursively = (dirRelPath: string) => {
        const absDir = path.join(rootDir, dirRelPath);
        if (!fs.existsSync(absDir)) return;
        for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
          const entryRel = path.join(dirRelPath, entry.name);
          if (entry.isDirectory()) {
            addDirRecursively(entryRel);
          } else if (entry.isFile() && !entry.name.endsWith('.zip')) {
            zip.file(entryRel, fs.readFileSync(path.join(rootDir, entryRel)));
          }
        }
      };

      addDirRecursively('src');

      const zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="codeatlas-ai-code-execution-map.zip"'
      );
      res.send(zipBuffer);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to build project zip';
      res.status(500).json({ error: msg });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CodeAtlas full-stack server running on http://localhost:${PORT}`);
  });
}

startServer();
