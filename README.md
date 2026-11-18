# Code Visualizer

A full-stack interactive code visualization and execution flow map built with:
- **Frontend**: Plain HTML (`index.html`), CSS (`style.css`), and Vanilla JavaScript (`app.js`) — no React, no TypeScript, no Vite bundler needed.
- **Backend**: Python 3 (`app.py`) with built-in **SQLite Database (`repos.db`)** to store and reload previously fetched or uploaded repositories in the **History** tab.

## How to Run Locally

1. Run the Python backend server (uses standard library `http.server` + `sqlite3`, zero `pip install` needed):
   ```bash
   python app.py
   ```
   *(or `python3 app.py` on macOS/Linux)*

2. Open `http://localhost:3000` in your browser.
   *(You can also open `index.html` directly in any browser; `style.css` and `app.js` work standalone without a build step!)*
