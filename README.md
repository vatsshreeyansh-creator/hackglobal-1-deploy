# Remix OmniAgent

Remix OmniAgent is a multimodal AI engineering copilot built for HackGlobal. It helps teams turn project files and technical questions into grounded analysis, execution plans, and staged automation actions from a single workbench.

## What it does

- Upload and inspect technical artifacts, including source files, documents, spreadsheets, images, and audio.
- Index uploaded content for semantic retrieval and use relevant excerpts to ground AI responses.
- Chat with the Gemini-powered agent, with standard and deep reasoning modes and streamed responses.
- Generate execution plans and track their steps in the workbench.
- Stage webhook actions and scripts, then simulate a dispatch or send a request to an HTTP(S) endpoint.
- Review ingestion, retrieval, reasoning, and action logs; export a session report in Markdown.
- Manage session artifacts in a sandbox, including previewing, deleting, or purging them.

## Requirements

- Node.js with npm
- A Google Gemini API key for AI responses and Gemini-powered embeddings

## Run locally

1. Clone the repository and install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and set your API key:

   ```env
   GEMINI_API_KEY=your_gemini_api_key
   ```

   The application can also read `GEMINI_MODEL` and `GEMINI_FALLBACK_MODEL` to override the default Gemini models.

3. Start the development server:

   ```bash
   npm run dev
   ```

   Open the local URL printed by the server (the default port is `3000`).

## Available scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Express server with Vite development middleware. |
| `npm run build` | Build the frontend for production. |
| `npm run preview` | Preview the Vite production build. |
| `npm run start` | Start the application server. |
| `npm run lint` | Run TypeScript type checking without emitting files. |

For production serving, build the frontend first with `npm run build`, then start the server with `npm run start` and configure the required environment variables in your hosting environment.

## Project structure

- `src/` — React workbench, UI components, and client-side types.
- `server.ts` — Express API, file upload handling, and streamed agent endpoint.
- `server/` — Gemini client, artifact ingestion, retrieval/indexing, sample data, and agent tools.
- `public/` — Static assets.

## Deployment

The project is configured for Vercel, and the deployed app is available at [hackglobal-1-deploy.vercel.app](https://hackglobal-1-deploy.vercel.app). Set `GEMINI_API_KEY` as a deployment secret before using Gemini-powered features.
