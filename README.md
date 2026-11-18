# CodeAtlas — AI Code Visualization & Execution Map

"Google Maps for code." Full-stack developer tool that turns source code and Git repositories into an interactive visual control-flow map, cross-file dependency graph, sandboxed execution tracer, and Gemini-powered architecture explorer.

## Quick Start (After Unzipping)

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment variables:
   ```bash
   cp .env.example .env
   # Add your GEMINI_API_KEY in .env
   ```
3. Start the full-stack server (port 3000):
   ```bash
   npm run dev
   ```
4. Run unit tests:
   ```bash
   npx --yes tsx --test src/engine/engine.test.ts
   ```
