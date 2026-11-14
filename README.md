#  OmniAgent

Remix OmniAgent is a multimodal AI engineering workbench that helps teams analyze uploaded technical artifacts, ask engineering questions grounded in local file context, and turn them into structured execution plans and automation actions. It combines a local artifact sandbox, vector search, and Gemini-powered reasoning into one interface for technical troubleshooting and workflow generation.

## Overview

This project is a TypeScript-based app built with React, Vite, and Express. It allows users to upload documents, code, spreadsheets, PDFs, images, and audio into a private sandbox, then query that content through a streaming agent. The system stores indexed chunks, retrieves the most relevant context, and uses Gemini to produce deep technical responses, execution blueprints, and staged automation hooks.

## Problem it solves

Most engineering teams work across fragmented artifacts: specs, diagrams, logs, CSV data, source code, and meeting notes. Those files often live in different places and are difficult to reason about together. Remix OmniAgent solves this by creating a single secure workspace where artifacts can be ingested, semantically searched, and analyzed with AI in context.

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
| User / Browser   | ---> | React Frontend       |
|                  |      | (Vite + TypeScript)  |
+-------------------+      +----------+-----------+
                                        |
                                        v
                            +----------------------+
                            | Express API Server   |
                            | /api/* endpoints     |
                            +----------+-----------+
                                       |
            +--------------------------+--------------------------+
            |                         |                         |
            v                         v                         v
 +-------------------+    +---------------------+    +----------------------+
 | Artifact Sandbox  |    | Vector Index / RAG  |    | Gemini API           |
 | File validation   |    | semantic retrieval  |    | reasoning + tools     |
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
- Google Gemini API
- Tailwind CSS
- Multer for uploads
- xlsx for spreadsheet support
- React Markdown for rendering

## Key features

- Multi-format artifact ingestion
- Local session sandbox with logs and state tracking
- Semantic vector retrieval using indexed chunks
- Gemini-powered chat with streaming responses
- Execution plans and workflow blueprints
- Staged webhook action handling
- Markdown session export report
- Security-oriented session purge and artifact removal logic

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
