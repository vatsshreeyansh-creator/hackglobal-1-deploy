# OmniAgent

OmniAgent is a multimodal AI engineering workbench that helps teams analyze uploaded technical artifacts, ask engineering questions grounded in local file context, and turn them into structured execution plans and automation actions. It combines a local artifact sandbox, vector search, and Gemini-powered reasoning into one interface for technical troubleshooting and workflow generation.

## Overview

This project is a TypeScript-based app built with React, Vite, and Express. It allows users to upload documents, code, spreadsheets, PDFs, images, and audio into a private sandbox, then query that content through a streaming agent. The system stores indexed chunks, retrieves the most relevant context, and uses Gemini to produce deep technical responses, execution blueprints, and staged automation hooks.

## Problem it solves

Most engineering teams work across fragmented artifacts: specs, diagrams, logs, CSV data, source code, and meeting notes. Those files often live in different places and are difficult to reason about together. OmniAgent solves this by creating a single secure workspace where artifacts can be ingested, semantically searched, and analyzed with AI in context.

Instead of giving shallow summaries, the app is designed to produce actionable outputs such as:

- architecture and bottleneck analysis
- execution plans with steps and effort estimates
- code or workflow suggestions grounded in uploaded files
- webhook automation staging for downstream systems
- session-based technical audit reports

## How it works

1. Users upload files into the sandbox.
2. The server ingests and validates each artifact.
3. Text and structured content are chunked and indexed for retrieval.
4. The app runs a semantic vector search against the current session index.
5. Relevant matches are sent to the Gemini model alongside the user prompt.
6. The AI responds with streamed reasoning, execution traces, plans, and action suggestions.
7. Generated execution plans and automation hooks are stored inside the session state for review.

The application exposes a session-based API for:

- artifact upload and ingestion
- session reset and cleanup
- vector-based retrieval
- execution plan updates
- webhook dispatch simulation or live HTTP dispatch
- SSE-based streaming chat interactions

## Architecture diagram

```text
+-------------------+      +----------------------+
| User / Browser    | ---> | React Frontend       |
|                   |      | (Vite + TypeScript)  |
+-------------------+      +----------+-----------+
                                      |
                                      v
                           +----------------------+
                           | Express API Server   |
                           | /api/* endpoints     |
                           +----------+-----------+
                                      |
           +--------------------------+--------------------------+
           |                          |                          |
           v                          v                          v
+-------------------+    +---------------------+    +----------------------+
| Artifact Sandbox  |    | Vector Index / RAG  |    | Gemini API           |
| File validation   |    | semantic retrieval  |    | reasoning + tools    |
| chunking + logs   |    | session search      |    +----------------------+
+-------------------+             +---------------------+
                                      |
                                      v
                           +----------------------+
                           | Execution Plans /    |
                           | Webhook Actions      |
                           +----------------------+
```

## Setup steps

1. Install dependencies:

```bash
npm install
```

2. Create environment variables from `.env.example`:

```bash
cp .env.example .env
```

3. Add your Gemini key in `.env`:

```env
GEMINI_API_KEY="your_gemini_api_key"
APP_URL="your_app_url"
```

4. Start the app:

```bash
npm run dev
```

5. Open the local app at the URL shown by the server (default is usually `http://localhost:3000`).

## Production build

```bash
npm run build
npm run start
```

## Tech stack

- TypeScript
- React
- Vite
- Express
- Google Gemini API (`@google/genai`)
- Tailwind CSS
- Multer for uploads
- xlsx for spreadsheet support
- React Markdown (`react-markdown` + `remark-gfm`) for rendering
- Lucide React for icons

## Key features

- Multi-format artifact ingestion (Code, PDF/Markdown/Text, CSV/XLSX spreadsheets, PNG/JPG/WebP wireframes, and MP3/WAV/M4A/OGG/WebM audio)
- Corrupt-file and security validation (`%PDF-`, PNG/JPEG magic bytes, disguised null-byte checks, 0-byte rejection, 20 MB per-file sandbox ceiling)
- Local session sandbox with logs and state tracking
- Semantic vector retrieval using indexed chunks (`gemini-embedding-2` cosine similarity with automatic lexical fallback)
- Gemini-powered chat with streaming SSE responses (`gemini-4-hydrogen` with `Standard` / `Deep Reasoning` thinking levels and automatic `429` retry + `gemini-3.1-flash-lite` failover)
- Execution plans and workflow blueprints via server-side Function Calling (`search_vector_index`, `analyze_tabular_schema`, `generate_execution_plan`, `dispatch_webhook_action`)
- Staged webhook action handling (`git`, `cicd`, `storage`, `tasks`, `database`) with script download and sandbox dispatch receipts
- One-click HackGlobal multi-modal sample engineering bundle (`order_service.py`, `latency_telemetry.csv`, `architecture_spec.md`, `service_topology_wireframe.png`)
- Markdown session rendering with GFM tables and copy/save code blocks
- Security-oriented session purge (`Reset Sandbox` & `Privacy Sandbox` modal) and artifact removal logic

## API endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Server healthcheck |
| `GET` | `/api/session/:sessionId` | Retrieve session artifacts, execution logs, plans, webhooks, and vector stats |
| `POST` | `/api/session/:sessionId/purge` | Sanitize and wipe all vectors, files, plans, and actions from session memory |
| `POST` | `/api/session/:sessionId/upload` | Multipart upload and vector indexing for up to 12 multimodal files |
| `POST` | `/api/session/:sessionId/load-sample` | Load and index the 4-modality HackGlobal sample engineering bundle |
| `DELETE` | `/api/session/:sessionId/artifacts/:artifactId` | Remove an artifact and purge its vectors |
| `GET` | `/api/session/:sessionId/artifacts/:artifactId/preview` | Retrieve parsed text, spreadsheet schema/rows, or image preview |
| `POST` | `/api/session/:sessionId/search` | Query the local `gemini-embedding-2` vector index directly |
| `POST` | `/api/session/:sessionId/actions/:actionId/dispatch` | Execute a staged sandbox webhook hook and record an HTTP 202 receipt |
| `POST` | `/api/agent/stream` | SSE endpoint for RAG grounding, multi-round tool execution, and streaming markdown synthesis |

## Project structure

```text
├── server.ts                          # Express + Vite dev/prod server & SSE orchestration
├── server/
│   ├── agentTools.ts                  # Gemini FunctionDeclarations & sandbox tool execution
│   ├── geminiClient.ts                # Server-side @google/genai client, retry & error formatting
│   ├── ingestion.ts                   # Multi-modal parser, validation, xlsx & line-numbered chunking
│   ├── rag.ts                         # Session-isolated vector store & cosine/lexical search
│   └── sampleBundles.ts               # Built-in 4-modality HackGlobal engineering sample bundle
├── src/
│   ├── App.tsx                        # 3-pane workbench state, SSE stream parser & theme sync
│   ├── index.css                      # Tailwind v4 configuration & typography variables
│   ├── types/omniagent.ts             # Shared TypeScript interfaces
│   └── components/
│       ├── TopBar.tsx                 # 3-zone navigation header & Reset Sandbox trigger
│       ├── IngestionPanel.tsx         # Left sidebar: drag-and-drop uploader & vector stats
│       ├── ChatWorkspace.tsx          # Center stream: reasoning toggle, traces, RAG & composer
│       ├── ExecutionSidebar.tsx       # Right sidebar: Logs, Actions & Vector Explorer tabs
│       ├── MarkdownRenderer.tsx       # GFM markdown, tabular figures & copy/save code blocks
│       ├── ArtifactPreviewModal.tsx   # Code, spreadsheet & wireframe inspection modal
│       └── PrivacyModal.tsx           # Local sandbox security summary & memory purge dialog
└── public/assets/aistudio/            # Demo recording & UI screenshots
```

## Demo media

- Screen recording walkthrough: `public/assets/aistudio/Screen_Recording_2026-11-13_191121_e0903997.mp4`
- Workbench screenshots:
  - `public/assets/aistudio/Screenshot_2026-11-13_190813_a48b2599.png`
  - `public/assets/aistudio/Screenshot_2026-11-13_210550_8702993b.png`

## Credits

This project uses the following technologies and services:

- Google Gemini for LLM reasoning and embedding workflows
- Vite for frontend tooling
- React for the user interface
- Express for the backend API and file-serving layer
- Tailwind CSS for styling
- Node.js and TypeScript for the application runtime

## Notes

The repository is configured as a deployable TypeScript app and is intended for AI-assisted engineering analysis and automation tasks. The app emphasizes grounded, artifact-aware responses rather than generic chat output, which makes it useful for technical audits, architecture work, and workflow planning.
