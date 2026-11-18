#!/usr/bin/env python3
"""
Code Visualizer — Python Backend & SQLite Database Server
Run with: python app.py (or python3 app.py)
Serves the HTML/CSS/JS frontend and provides SQLite persistence (repos.db)
for previously fetched and uploaded repositories.
"""

import datetime
import http.server
import json
import os
import re
import socketserver
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

PORT = int(os.environ.get("PORT", 3000))
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT_DIR, "repos.db")


def load_dotenv_file():
    env_path = os.path.join(ROOT_DIR, ".env")
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass


load_dotenv_file()


def get_db_connection(db_path=DB_PATH):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(db_path=DB_PATH):
    conn = get_db_connection(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_repos (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                repo_url TEXT NOT NULL,
                language TEXT NOT NULL,
                file_count INTEGER NOT NULL,
                files_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def detect_primary_language(files):
    if not files:
        return "Unknown"
    ext_map = {
        ".py": "python",
        ".js": "javascript",
        ".jsx": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".java": "java",
        ".cpp": "cpp",
        ".c": "c",
        ".rs": "rust",
        ".go": "go",
        ".php": "php",
        ".cs": "csharp",
        ".html": "html",
        ".css": "css",
        ".json": "json",
    }
    counts = {}
    for f in files:
        path_str = str(f.get("path", "")).lower()
        lang = "Unknown"
        for ext, l_name in ext_map.items():
            if path_str.endswith(ext):
                lang = l_name
                break
        counts[lang] = counts.get(lang, 0) + 1
    sorted_langs = sorted(counts.items(), key=lambda item: item[1], reverse=True)
    return sorted_langs[0][0] if sorted_langs else "Unknown"


def sanitize_repo_id(raw_id):
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "-", str(raw_id or "")).strip("-")
    cleaned = re.sub(r"-+", "-", cleaned)[:120]
    if not cleaned:
        cleaned = f"repo-{int(datetime.datetime.now(datetime.timezone.utc).timestamp())}"
    return cleaned


def row_to_dict(row):
    try:
        files = json.loads(row["files_json"])
    except Exception:
        files = []
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "repoUrl": row["repo_url"],
        "language": row["language"],
        "fileCount": row["file_count"],
        "files": files,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def list_saved_repos(db_path=DB_PATH):
    init_db(db_path)
    conn = get_db_connection(db_path)
    try:
        cur = conn.execute(
            "SELECT * FROM saved_repos ORDER BY updated_at DESC LIMIT 100"
        )
        return [row_to_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def get_saved_repo_by_id(repo_id, db_path=DB_PATH):
    init_db(db_path)
    conn = get_db_connection(db_path)
    try:
        cur = conn.execute("SELECT * FROM saved_repos WHERE id = ?", (repo_id,))
        row = cur.fetchone()
        return row_to_dict(row) if row else None
    finally:
        conn.close()


def save_repo_to_db(payload, db_path=DB_PATH):
    init_db(db_path)
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    raw_files = payload.get("files") or []
    clean_files = []
    for f in raw_files[:50]:
        clean_files.append(
            {
                "path": str(f.get("path") or "src/main.py")[:240],
                "content": str(f.get("content") or "")[:60000],
            }
        )

    name = str(payload.get("name") or "unnamed-repo").strip()[:120] or "unnamed-repo"
    repo_url = str(payload.get("repoUrl") or "").strip()[:500]
    description = str(
        payload.get("description") or f"Saved project ({len(clean_files)} files)"
    )[:500]
    language = detect_primary_language(clean_files)[:60]
    file_count = len(clean_files)
    files_json = json.dumps(clean_files)

    conn = get_db_connection(db_path)
    try:
        existing = None
        if repo_url:
            cur = conn.execute(
                "SELECT * FROM saved_repos WHERE LOWER(repo_url) = LOWER(?)",
                (repo_url,),
            )
            existing = cur.fetchone()
        if not existing and payload.get("id"):
            cur = conn.execute(
                "SELECT * FROM saved_repos WHERE id = ?", (str(payload.get("id")),)
            )
            existing = cur.fetchone()
        if not existing and not repo_url:
            cur = conn.execute(
                "SELECT * FROM saved_repos WHERE LOWER(name) = LOWER(?) AND repo_url = ''",
                (name,),
            )
            existing = cur.fetchone()

        if existing:
            repo_id = existing["id"]
            created_at = existing["created_at"]
            conn.execute(
                """
                UPDATE saved_repos
                SET name = ?, description = ?, repo_url = ?, language = ?,
                    file_count = ?, files_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    name,
                    description,
                    repo_url,
                    language,
                    file_count,
                    files_json,
                    now_iso,
                    repo_id,
                ),
            )
        else:
            repo_id = sanitize_repo_id(
                payload.get("id")
                or f"repo-{name.lower()}-{int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)}"
            )
            created_at = now_iso
            conn.execute(
                """
                INSERT INTO saved_repos
                (id, name, description, repo_url, language, file_count, files_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    repo_id,
                    name,
                    description,
                    repo_url,
                    language,
                    file_count,
                    files_json,
                    created_at,
                    now_iso,
                ),
            )
        conn.commit()
        return get_saved_repo_by_id(repo_id, db_path)
    finally:
        conn.close()


def delete_saved_repo(repo_id, db_path=DB_PATH):
    init_db(db_path)
    conn = get_db_connection(db_path)
    try:
        cur = conn.execute("DELETE FROM saved_repos WHERE id = ?", (repo_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def fetch_github_repository(repo_url):
    match = re.search(r"github\.com/([^/]+)/([^/.\s]+)", str(repo_url), re.IGNORECASE)
    if not match:
        raise ValueError("Supported URL format: https://github.com/<owner>/<repo>")

    owner, repo = match.group(1), match.group(2)
    headers = {"User-Agent": "CodeVisualizer-PythonBackend"}

    meta_req = urllib.request.Request(
        f"https://api.github.com/repos/{owner}/{repo}", headers=headers
    )
    with urllib.request.urlopen(meta_req, timeout=15) as resp:
        repo_meta = json.loads(resp.read().decode("utf-8"))

    branch = repo_meta.get("default_branch") or "main"
    description = (
        repo_meta.get("description") or f"Imported from github.com/{owner}/{repo}"
    )

    tree_req = urllib.request.Request(
        f"https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1",
        headers=headers,
    )
    with urllib.request.urlopen(tree_req, timeout=15) as resp:
        tree_data = json.loads(resp.read().decode("utf-8"))

    code_ext_re = re.compile(
        r"\.(py|ts|tsx|js|jsx|java|cpp|c|rs|go|php|cs|json)$", re.IGNORECASE
    )
    candidate_blobs = []
    for item in tree_data.get("tree", []):
        p = item.get("path", "")
        if (
            item.get("type") == "blob"
            and code_ext_re.search(p)
            and "node_modules/" not in p
            and "dist/" not in p
            and "package-lock.json" not in p
            and int(item.get("size") or 0) < 60000
        ):
            candidate_blobs.append(item)
            if len(candidate_blobs) >= 14:
                break

    files = []
    for blob in candidate_blobs:
        blob_path = urllib.parse.quote(blob["path"], safe="/")
        raw_url = (
            f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{blob_path}"
        )
        raw_req = urllib.request.Request(raw_url, headers=headers)
        try:
            with urllib.request.urlopen(raw_req, timeout=12) as r_resp:
                content = r_resp.read().decode("utf-8", errors="replace")
                files.append({"path": blob["path"], "content": content})
        except Exception:
            continue

    if not files:
        raise ValueError("No supported source files found in this repository.")

    saved_record = save_repo_to_db(
        {
            "name": f"{owner}/{repo}",
            "description": description,
            "repoUrl": repo_url,
            "files": files,
        }
    )
    return saved_record


def call_gemini_api(prompt, response_schema=None):
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key or api_key == "MY_GEMINI_API_KEY":
        return None, "GEMINI_API_KEY is not configured. Showing deterministic static AST analysis."

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    if response_schema:
        payload["generationConfig"] = {
            "responseMimeType": "application/json",
            "responseSchema": response_schema,
        }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "aistudio-build",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            candidates = result.get("candidates") or []
            if candidates:
                parts = candidates[0].get("content", {}).get("parts") or []
                if parts and "text" in parts[0]:
                    return parts[0]["text"], None
            return None, "Empty response from Gemini API."
    except Exception as exc:
        return None, str(exc)


class CodeVisualizerHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def log_message(self, format_str, *args):
        # Keep server logs clean
        pass

    def _send_json(self, status_code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS"
        )
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def do_OPTIONS(self):
        self._send_json(200, {"ok": True})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/history":
            repos = list_saved_repos()
            self._send_json(200, {"repos": repos})
            return

        if path.startswith("/api/history/"):
            repo_id = urllib.parse.unquote(path[len("/api/history/") :])
            record = get_saved_repo_by_id(repo_id)
            if not record:
                self._send_json(404, {"error": "Saved repository not found"})
                return
            self._send_json(200, {"repo": record})
            return

        # Serve static frontend files (index.html, style.css, app.js)
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            body = self._read_json_body()
        except Exception as exc:
            self._send_json(400, {"error": f"Invalid JSON payload: {exc}"})
            return

        if path == "/api/history":
            name = body.get("name")
            files = body.get("files")
            if not name or not isinstance(files, list) or len(files) == 0:
                self._send_json(
                    400,
                    {
                        "error": "Repository name and non-empty files array are required."
                    },
                )
                return
            saved = save_repo_to_db(body)
            self._send_json(200, {"repo": saved})
            return

        if path == "/api/repo/import":
            repo_url = body.get("repoUrl")
            if not repo_url:
                self._send_json(
                    400, {"error": "Please provide a valid GitHub repository URL."}
                )
                return
            try:
                saved = fetch_github_repository(repo_url)
                self._send_json(
                    200,
                    {
                        "id": saved["id"],
                        "name": saved["name"],
                        "description": saved["description"],
                        "repoUrl": saved["repoUrl"],
                        "language": saved["language"],
                        "files": saved["files"],
                        "savedRecord": saved,
                    },
                )
            except urllib.error.HTTPError as http_err:
                self._send_json(
                    http_err.code,
                    {"error": f"GitHub API returned {http_err.code}: unable to fetch repository."},
                )
            except Exception as exc:
                self._send_json(400, {"error": str(exc)})
            return

        if path == "/api/ai/explain-node":
            node = body.get("node")
            if not node:
                self._send_json(400, {"error": "Missing node payload"})
                return
            file_content = str(body.get("fileContent") or "")[:3500]
            project_summary = str(body.get("projectSummary") or "Multi-file repository")
            runtime_observed = body.get("runtimeObserved")

            prompt = f"""You are a static analysis & execution flow tutor for Code Visualizer.
Analyze the selected Control-Flow Node strictly based on the provided AST/CFG metadata and source snippet.

Project Context: {project_summary}
Selected Node:
- Label: {node.get('label')}
- Kind: {node.get('kind')}
- File: {node.get('file')} (Line {node.get('location', {}).get('startLine')})
- Function: {node.get('functionName') or 'module'}
- Expression: {node.get('expression') or 'N/A'}
- Runtime Observed Data: {json.dumps(runtime_observed) if runtime_observed else 'Not executed yet'}

Source Code:
```
{file_content}
```"""
            schema = {
                "type": "OBJECT",
                "properties": {
                    "whatItDoes": {"type": "STRING"},
                    "whyItExists": {"type": "STRING"},
                    "inputs": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "outputs": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "dependencies": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "possiblePaths": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "beginnerExplanation": {"type": "STRING"},
                    "confidenceNote": {"type": "STRING"},
                },
                "required": [
                    "whatItDoes",
                    "whyItExists",
                    "inputs",
                    "outputs",
                    "dependencies",
                    "possiblePaths",
                    "beginnerExplanation",
                    "confidenceNote",
                ],
            }
            text_out, err = call_gemini_api(prompt, schema)
            if err or not text_out:
                self._send_json(503, {"error": err or "AI explanation unavailable"})
                return
            try:
                parsed_ai = json.loads(text_out)
                parsed_ai["nodeId"] = node.get("id")
                parsed_ai["provenance"] = (
                    "runtime_observed" if runtime_observed else "ai_inferred"
                )
                self._send_json(200, parsed_ai)
            except Exception as exc:
                self._send_json(500, {"error": f"Failed to parse AI response: {exc}"})
            return

        if path == "/api/ai/chat":
            question = body.get("question")
            if not question:
                self._send_json(400, {"error": "Missing question"})
                return
            prompt = f"""You are the Code Visualizer Repository Assistant.
Answer the developer's question accurately and cite file paths and line numbers.

Repository Structure & Code:
{body.get('projectContext', '')}

Active File: {body.get('activeFile', 'None')}
Active Node: {body.get('activeNode', 'None')}
Trace Summary: {body.get('traceSummary', 'Not run')}

Question:
{question}"""
            text_out, err = call_gemini_api(prompt)
            if err or not text_out:
                self._send_json(503, {"error": err or "AI Chat unavailable"})
                return
            self._send_json(200, {"answer": text_out})
            return

        self._send_json(404, {"error": "Unknown API endpoint"})

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/history/"):
            repo_id = urllib.parse.unquote(path[len("/api/history/") :])
            deleted = delete_saved_repo(repo_id)
            self._send_json(200, {"deleted": deleted, "id": repo_id})
            return

        self._send_json(404, {"error": "Unknown API endpoint"})


class ReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    init_db()
    with ReusableTCPServer(("0.0.0.0", PORT), CodeVisualizerHandler) as httpd:
        print(f"Code Visualizer Python server running on http://localhost:{PORT}")
        httpd.serve_forever()
