process.env.GOOGLE_GENAI_API_VERSION = 'v1beta';
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  ThinkingLevel,
  type Content,
  type FunctionCall,
  type Part,
} from '@google/genai';
import {
  formatGeminiError,
  getGeminiClient,
  isRateLimitError,
  withRetry,
} from './server/geminiClient.ts';
import { ingestUploadedFile } from './server/ingestion.ts';
import {
  appendLog,
  getOrCreateSession,
  getSessionStateResponse,
  indexArtifactVectors,
  purgeSession,
  removeArtifactFromSandbox,
  searchSessionIndex,
  serializeArtifactSummary,
} from './server/rag.ts';
import { getHackGlobalSampleBundle } from './server/sampleBundles.ts';
import { executeOmniAgentTool, omniAgentToolDeclarations } from './server/agentTools.ts';

function resolveServerPort(): number {
  const portFlagIdx = process.argv.findIndex((arg) => arg === '--port');
  if (portFlagIdx !== -1 && process.argv[portFlagIdx + 1]) {
    const parsed = Number(process.argv[portFlagIdx + 1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const portEqArg = process.argv.find((arg) => arg.startsWith('--port='));
  if (portEqArg) {
    const parsed = Number(portEqArg.split('=')[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (process.env.NODE_ENV !== 'production') {
    return 3000;
  }
  return Number(process.env.PORT || 3000);
}

const PORT = resolveServerPort();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 22 * 1024 * 1024,
    files: 12,
  },
});

const OMNIAGENT_SYSTEM_INSTRUCTION = `You are OmniAgent, an elite enterprise-grade multi-modal autonomous AI workflow copilot and technical agent built for HackGlobal.
Your objective is to bridge unstructured multi-format artifacts (source code, PDFs, Markdown specs, CSV/Excel telemetry, UI/architecture wireframes, and audio notes) into actionable, automated engineering execution.

CRITICAL BEHAVIORAL RULES:
1. NEVER give one-sentence answers, surface-level summaries, or lazy placeholders. Every response must be deeply technical, exhaustive, and production-ready.
2. When asked for code, architecture, or workflows, write out the COMPLETE implementation (full runnable scripts, configuration files, CI/CD YAML workflows, SQL migrations, Dockerfiles, and markdown documentation)—NEVER use shorthand, ellipses, or "// insert code here" placeholders.
3. Always display multi-step agentic reasoning logs, tool execution traces, and structured outputs. Include a transparent \`## Agentic Reasoning & Execution Trace\` section summarizing the diagnostic pipeline, bottlenecks identified, and tools invoked, AND actively invoke your declared tools:
   - Call \`search_vector_index\` when additional semantic cross-file retrieval is needed.
   - Call \`analyze_tabular_schema\` when inspecting CSV/Excel datasets.
   - Call \`generate_execution_plan\` whenever diagnosing bottlenecks, planning migrations, or breaking down sprints so the structured blueprint populates the Execution Plan sidebar.
   - Call \`dispatch_webhook_action\` to stage complete, runnable Git PR patches, CI/CD workflows, SQL migrations, storage manifests, or task tickets.
4. When RAG artifacts or files are attached, parse every single chunk deeply and reference them explicitly in your technical outputs by exact filename, chunk ID, line range (e.g., \`order_service.py (L12-L38)\`), column metrics, or wireframe components.`;

function writeSseEvent(res: express.Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Healthcheck
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'OmniAgent', timestamp: new Date().toISOString() });
  });

  // Get session sandbox state
  app.get('/api/session/:sessionId', (req, res) => {
    const sandbox = getOrCreateSession(req.params.sessionId);
    res.json(getSessionStateResponse(sandbox));
  });

  // Purge / sanitize session sandbox
  app.post('/api/session/:sessionId/purge', (req, res) => {
    const fresh = purgeSession(req.params.sessionId);
    res.json(getSessionStateResponse(fresh));
  });

  // Upload and ingest multi-modal files
  app.post('/api/session/:sessionId/upload', (req, res) => {
    upload.array('files', 12)(req, res, async (uploadErr) => {
      if (uploadErr) {
        return res.status(400).json({
          error:
            uploadErr instanceof Error
              ? uploadErr.message
              : 'File upload rejected by multipart parser.',
        });
      }

      const sandbox = getOrCreateSession(req.params.sessionId);
      const files = (req.files as Express.Multer.File[]) ?? [];

      if (files.length === 0) {
        return res.status(400).json({ error: 'No files were attached in the upload request.' });
      }

      const results = [];
      for (const file of files) {
        const artifactId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const record = ingestUploadedFile(
          artifactId,
          file.originalname,
          file.mimetype,
          file.buffer
        );

        if (record.status === 'error') {
          sandbox.artifacts.set(record.id, record);
          appendLog(sandbox, {
            phase: 'INGESTION',
            title: `Rejected corrupt/unsupported file: ${record.name}`,
            detail: record.errorMessage ?? 'File failed sandbox validation.',
            status: 'error',
          });
          results.push(serializeArtifactSummary(record));
          continue;
        }

        const embedInfo = await indexArtifactVectors(sandbox, record);
        appendLog(sandbox, {
          phase: 'EMBEDDING',
          title: `Indexed ${record.name} (${record.modality})`,
          detail: embedInfo.usedFallback
            ? `Parsed ${record.chunkCount} chunks with local lexical fallback.`
            : `Embedded ${record.chunkCount} chunks into ${embedInfo.dims}d gemini-embedding-2 vector space.`,
          durationMs: embedInfo.durationMs,
          status: embedInfo.usedFallback ? 'warning' : 'completed',
        });

        results.push(serializeArtifactSummary(record));
      }

      return res.json({
        uploaded: results,
        state: getSessionStateResponse(sandbox),
      });
    });
  });

  // Load curated HackGlobal multi-modal sample bundle
  app.post('/api/session/:sessionId/load-sample', async (req, res) => {
    const sandbox = getOrCreateSession(req.params.sessionId);
    const samples = getHackGlobalSampleBundle();

    for (const sample of samples) {
      // Avoid duplicating identical sample filename in same session
      const existing = Array.from(sandbox.artifacts.values()).find(
        (a) => a.name === sample.fileName
      );
      if (existing) continue;

      const artifactId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const record = ingestUploadedFile(
        artifactId,
        sample.fileName,
        sample.mimeType,
        sample.buffer
      );
      const embedInfo = await indexArtifactVectors(sandbox, record);
      appendLog(sandbox, {
        phase: 'INGESTION',
        title: `Loaded sample artifact: ${record.name}`,
        detail: embedInfo.usedFallback
          ? `Indexed ${record.chunkCount} chunks (lexical fallback).`
          : `Indexed ${record.chunkCount} chunks (${embedInfo.dims}d gemini-embedding-2).`,
        durationMs: embedInfo.durationMs,
        status: embedInfo.usedFallback ? 'warning' : 'completed',
      });
    }

    res.json(getSessionStateResponse(sandbox));
  });

  // Delete single artifact
  app.delete('/api/session/:sessionId/artifacts/:artifactId', (req, res) => {
    const sandbox = getOrCreateSession(req.params.sessionId);
    const removed = removeArtifactFromSandbox(sandbox, req.params.artifactId);
    if (removed) {
      appendLog(sandbox, {
        phase: 'SECURITY',
        title: 'Removed artifact from sandbox',
        detail: `Artifact ${req.params.artifactId} and its vector chunks were purged.`,
        status: 'completed',
      });
    }
    res.json(getSessionStateResponse(sandbox));
  });

  // Inspect full parsed preview of an artifact
  app.get('/api/session/:sessionId/artifacts/:artifactId/preview', (req, res) => {
    const sandbox = getOrCreateSession(req.params.sessionId);
    const artifact = sandbox.artifacts.get(req.params.artifactId);
    if (!artifact) {
      return res.status(404).json({ error: 'Artifact not found in current sandbox.' });
    }
    const mediaDataUrl =
      artifact.inlineBase64 &&
      (artifact.modality === 'audio' || artifact.mimeType === 'application/pdf')
        ? `data:${artifact.mimeType};base64,${artifact.inlineBase64}`
        : undefined;

    return res.json({
      ...serializeArtifactSummary(artifact),
      fullTextContent: artifact.fullTextContent,
      mediaDataUrl,
    });
  });

  // Direct semantic vector search endpoint for Vector Explorer tab
  app.post('/api/session/:sessionId/search', async (req, res) => {
    const sandbox = getOrCreateSession(req.params.sessionId);
    const query = String(req.body?.query ?? '').trim();
    const topK = Math.min(12, Math.max(1, Number(req.body?.topK ?? 6)));

    if (!query) {
      return res.status(400).json({ error: 'Search query cannot be empty.' });
    }

    const result = await searchSessionIndex(sandbox, query, topK);
    appendLog(sandbox, {
      phase: 'RAG_RETRIEVAL',
      title: `Vector Explorer query: "${query.slice(0, 42)}"`,
      detail: `Returned ${result.matches.length} semantic matches via ${result.mode} index.`,
      durationMs: result.durationMs,
      status: 'completed',
    });

    return res.json({
      ...result,
      logs: sandbox.logs,
    });
  });

  // Toggle execution plan step completion status
  app.patch('/api/session/:sessionId/plans/:planId/steps/:stepNumber', (req, res) => {
    const sandbox = getOrCreateSession(req.params.sessionId);
    const plan = sandbox.plans.find((p) => p.id === req.params.planId);
    if (!plan) {
      return res.status(404).json({ error: 'Execution plan not found.' });
    }
    const stepNum = Number(req.params.stepNumber);
    const step = plan.steps.find((s) => s.stepNumber === stepNum);
    if (!step) {
      return res.status(404).json({ error: 'Execution step not found.' });
    }

    step.status = step.status === 'executed' ? 'ready' : 'executed';
    appendLog(sandbox, {
      phase: 'TOOL_CALL',
      title: `Plan step ${String(step.stepNumber).padStart(2, '0')} marked ${step.status}`,
      detail: `${plan.title}: ${step.title}`,
      status: 'completed',
    });

    return res.json({
      plan,
      state: getSessionStateResponse(sandbox),
    });
  });

  // Execute / dispatch a staged webhook hook (real HTTP POST if targetUrl provided, or sandbox simulation)
  app.post('/api/session/:sessionId/actions/:actionId/dispatch', async (req, res) => {
    const sandbox = getOrCreateSession(req.params.sessionId);
    const action = sandbox.actions.find((a) => a.id === req.params.actionId);
    if (!action) {
      return res.status(404).json({ error: 'Staged webhook action not found.' });
    }

    const rawTargetUrl = typeof req.body?.targetUrl === 'string' ? req.body.targetUrl.trim() : '';

    if (rawTargetUrl) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawTargetUrl);
      } catch {
        return res.status(400).json({ error: 'Invalid target webhook URL.' });
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return res.status(400).json({ error: 'Webhook URL must use http:// or https://.' });
      }
      const host = parsedUrl.hostname.toLowerCase();
      const isPrivateOrLoopback =
        host === 'localhost' ||
        host === '::1' ||
        host.endsWith('.local') ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^169\.254\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host);

      if (isPrivateOrLoopback) {
        return res.status(400).json({
          error: 'Private, loopback, and metadata IP webhook targets are blocked for security.',
        });
      }

      try {
        const start = Date.now();
        const hookRes = await fetch(parsedUrl.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'OmniAgent-Webhook/1.0',
          },
          body: JSON.stringify({
            source: 'OmniAgent',
            targetSystem: action.targetSystem,
            operation: action.operation,
            endpointPath: action.endpointPath,
            summary: action.summary,
            payload: (() => {
              try {
                return JSON.parse(action.payloadJson);
              } catch {
                return action.payloadJson;
              }
            })(),
            scriptFilename: action.scriptFilename,
            scriptContent: action.scriptContent,
            timestamp: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(8000),
        });
        const elapsed = Date.now() - start;
        const bodySnippet = (await hookRes.text()).slice(0, 140).replace(/\s+/g, ' ').trim();

        if (!hookRes.ok) {
          appendLog(sandbox, {
            phase: 'WEBHOOK_HOOK',
            title: `Live webhook failed (${hookRes.status}): ${action.operation}`,
            detail: `${parsedUrl.origin}${parsedUrl.pathname} returned HTTP ${hookRes.status}${bodySnippet ? `: ${bodySnippet}` : ''}`,
            durationMs: elapsed,
            status: 'error',
          });
          return res.status(502).json({
            error: `Target webhook returned HTTP ${hookRes.status}${bodySnippet ? ` (${bodySnippet})` : ''}.`,
          });
        }

        action.status = 'dispatched';
        action.dispatchedAt = new Date().toISOString();
        action.targetUrl = parsedUrl.toString();
        action.httpStatus = hookRes.status;
        action.dispatchReceipt = `Live HTTP ${hookRes.status} · ${parsedUrl.host} · ${elapsed}ms${
          bodySnippet ? ` · "${bodySnippet}"` : ''
        }`;

        appendLog(sandbox, {
          phase: 'WEBHOOK_HOOK',
          title: `Dispatched live ${action.targetSystem.toUpperCase()} webhook (${hookRes.status})`,
          detail: action.dispatchReceipt,
          durationMs: elapsed,
          status: 'completed',
        });

        return res.json({
          action,
          state: getSessionStateResponse(sandbox),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Network error calling webhook target.';
        appendLog(sandbox, {
          phase: 'WEBHOOK_HOOK',
          title: `Live webhook error: ${action.operation}`,
          detail: msg,
          status: 'error',
        });
        return res.status(502).json({ error: `Failed to reach webhook URL: ${msg}` });
      }
    }

    action.status = 'dispatched';
    action.dispatchedAt = new Date().toISOString();
    action.dispatchReceipt = `[Sandbox Simulation] HTTP 202 Accepted · ${action.endpointPath} · Trace #${Math.random()
      .toString(36)
      .slice(2, 10)
      .toUpperCase()}`;

    appendLog(sandbox, {
      phase: 'WEBHOOK_HOOK',
      title: `Simulated ${action.targetSystem.toUpperCase()} hook: ${action.operation}`,
      detail: action.dispatchReceipt,
      status: 'completed',
    });

    return res.json({
      action,
      state: getSessionStateResponse(sandbox),
    });
  });

  // Streaming Agentic Copilot Endpoint (SSE)
  app.post('/api/agent/stream', async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? 'default');
    const prompt = String(req.body?.prompt ?? '').trim();
    const reasoningDepth = req.body?.reasoningDepth === 'deep' ? 'deep' : 'standard';
    const history = Array.isArray(req.body?.history) ? req.body.history : [];

    if (!prompt) {
      return res.status(400).json({
        error: 'Prompt cannot be empty. Provide an instruction, code question, or workflow objective.',
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const sandbox = getOrCreateSession(sessionId);
    const sandboxVersion = sandbox.version;
    const requestStart = Date.now();
    let clientAborted = false;

    res.on('close', () => {
      if (!res.writableEnded) {
        clientAborted = true;
      }
    });

    const isCancelled = () => clientAborted || sandbox.version !== sandboxVersion;

    const validArtifactNames = Array.from(sandbox.artifacts.values())
      .filter((a) => a.status !== 'error')
      .map((a) => a.name);

    const userMsgId = `msg_u_${Date.now()}`;
    const assistantMsgId = `msg_a_${Date.now() + 1}`;

    sandbox.messages.push({
      id: userMsgId,
      role: 'user',
      content: prompt,
      timestamp: new Date().toISOString(),
      attachedArtifactNames: validArtifactNames,
    });
    if (sandbox.messages.length > 100) {
      sandbox.messages = sandbox.messages.slice(-100);
    }

    let accumulatedMarkdown = '';
    let capturedRagMatches: Awaited<ReturnType<typeof searchSessionIndex>>['matches'] = [];
    const capturedTraces: Array<{
      id: string;
      phase: 'INGESTION' | 'EMBEDDING' | 'RAG_RETRIEVAL' | 'REASONING' | 'TOOL_CALL' | 'WEBHOOK_HOOK' | 'SYNTHESIS' | 'SECURITY';
      title: string;
      detail: string;
      durationMs?: number;
      status: 'completed' | 'running' | 'warning' | 'error';
    }> = [];

    const recordTraceAndSend = (
      entry: Omit<(typeof capturedTraces)[number], 'id'> & { id?: string; timestamp?: string }
    ) => {
      if (isCancelled()) return;
      const logged = appendLog(sandbox, {
        phase: entry.phase,
        title: entry.title,
        detail: entry.detail,
        durationMs: entry.durationMs,
        status: entry.status,
      });
      capturedTraces.push({
        id: logged.id,
        phase: logged.phase,
        title: logged.title,
        detail: logged.detail,
        durationMs: logged.durationMs,
        status: logged.status,
      });
      writeSseEvent(res, 'agent_step', logged);
      return logged;
    };

    try {
      const ai = getGeminiClient();

      // 1. RAG Vector Retrieval
      recordTraceAndSend({
        phase: 'RAG_RETRIEVAL',
        title: 'Querying local vector index',
        detail: `Embedding prompt via gemini-embedding-2 across ${sandbox.vectors.length} indexed chunks.`,
        status: 'completed',
      });

      const ragResult = await searchSessionIndex(sandbox, prompt, 12);
      if (isCancelled()) {
        res.end();
        return;
      }
      capturedRagMatches = ragResult.matches;
      writeSseEvent(res, 'rag_retrieval', {
        matches: ragResult.matches,
        mode: ragResult.mode,
        durationMs: ragResult.durationMs,
      });

      recordTraceAndSend({
        phase: 'RAG_RETRIEVAL',
        title: `Grounded ${ragResult.matches.length} ranked segments across ${sandbox.artifacts.size} artifact(s)`,
        detail:
          ragResult.matches.length > 0
            ? `Top match: ${ragResult.matches[0].artifactName} (${ragResult.matches[0].lineRange ?? ragResult.matches[0].modality}, score ${ragResult.matches[0].score.toFixed(3)}).`
            : 'No artifacts currently indexed; proceeding with exhaustive direct engineering synthesis.',
        durationMs: ragResult.durationMs,
        status: 'completed',
      });

      // 2. Build Multi-Modal Context Parts
      const userParts: Part[] = [];
      const validArtifacts = Array.from(sandbox.artifacts.values()).filter(
        (a) => a.status !== 'error'
      );

      if (validArtifacts.length > 0) {
        const inventorySummary = validArtifacts
          .map(
            (a) =>
              `- ${a.name} [${a.modality}, ${a.mimeType}, ${(a.sizeBytes / 1024).toFixed(1)} KB, ${a.chunkCount} chunks${
                a.tabularMeta
                  ? `, ${a.tabularMeta.rowCount} rows x ${a.tabularMeta.columnCount} cols`
                  : ''
              }]`
          )
          .join('\n');

        const ragContextText =
          ragResult.matches.length > 0
            ? ragResult.matches
                .map(
                  (m, idx) =>
                    `### Ranked RAG Match ${idx + 1}: ${m.artifactName} [${m.chunkId} | ${m.lineRange ?? m.modality} | similarity=${m.score.toFixed(
                      3
                    )}]\n\`\`\`\n${m.excerpt}\n\`\`\``
                )
                .join('\n\n')
            : 'No ranked text chunks matched.';

        let deepChunkChars = 0;
        const DEEP_CHUNK_CHAR_LIMIT = 32000;
        const deepChunkSections: string[] = [];
        for (const art of validArtifacts) {
          if (art.modality === 'image' || art.modality === 'audio' || art.mimeType === 'application/pdf') {
            continue;
          }
          for (const ch of art.chunks) {
            const block = `#### ${ch.artifactName} [${ch.chunkId} | ${ch.lineRange ?? ch.modality}]\n\`\`\`\n${ch.text}\n\`\`\``;
            if (deepChunkChars + block.length > DEEP_CHUNK_CHAR_LIMIT) break;
            deepChunkSections.push(block);
            deepChunkChars += block.length;
          }
        }

        const fullChunksSection =
          deepChunkSections.length > 0
            ? `\n\n## COMPLETE INDEXED ARTIFACT CHUNKS (${deepChunkSections.length} chunks parsed)\n${deepChunkSections.join('\n\n')}`
            : '';

        userParts.push({
          text: `## SANDBOX WORKSPACE INVENTORY\n${inventorySummary}\n\n## TOP VECTOR RAG MATCHES (${ragResult.mode.toUpperCase()})\n${ragContextText}${fullChunksSection}\n\n## USER REQUEST\n${prompt}`,
        });

        let mediaCount = 0;
        for (const art of validArtifacts) {
          if (
            art.inlineBase64 &&
            (art.modality === 'image' ||
              art.modality === 'audio' ||
              art.mimeType === 'application/pdf') &&
            mediaCount < 5
          ) {
            userParts.push({
              text: `[Attached Multimodal Artifact: ${art.name}]`,
            });
            userParts.push({
              inlineData: {
                mimeType: art.mimeType,
                data: art.inlineBase64,
              },
            });
            mediaCount++;
          }
        }
      } else {
        userParts.push({ text: prompt });
      }

      const conversationContents: Content[] = [];
      for (const msg of history.slice(-6)) {
        if (
          msg &&
          (msg.role === 'user' || msg.role === 'assistant') &&
          typeof msg.content === 'string' &&
          msg.content.trim() !== ''
        ) {
          conversationContents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
          });
        }
      }
      conversationContents.push({ role: 'user', parts: userParts });

      const PRIMARY_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
      const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL?.trim() || 'gemini-2.0-flash';

      const thinkingLevel =
        reasoningDepth === 'deep' ? ThinkingLevel.XHIGH : ThinkingLevel.HIGH;

      recordTraceAndSend({
        phase: 'REASONING',
        title: `Invoking ${PRIMARY_MODEL} (${reasoningDepth === 'deep' ? 'XHIGH' : 'HIGH'} reasoning)`,
        detail: `Hybrid reasoning layer active with ${omniAgentToolDeclarations.length} agentic orchestration tools.`,
        status: 'completed',
      });

      // 3. Streaming + Multi-Step Function Calling Loop (max 4 tool rounds)
      const activeContents: Content[] = [...conversationContents];
      let emittedAnyText = false;
      let activeModel: string = PRIMARY_MODEL;

      const runStreamingRound = async (
        modelName: string
      ): Promise<{
        collectedModelParts: Part[];
        collectedFunctionCalls: FunctionCall[];
        roundTextEmitted: boolean;
      }> => {
        const effectiveThinking =
          modelName === PRIMARY_MODEL
            ? thinkingLevel
            : ThinkingLevel.HIGH;

        const thinkingCfg =
          modelName.includes('gemini-4') || modelName.includes('gemini-3')
            ? { thinkingLevel: effectiveThinking }
            : undefined;

        const requestConfig: Record<string, unknown> = {
          systemInstruction: OMNIAGENT_SYSTEM_INSTRUCTION,
          tools: [{ functionDeclarations: omniAgentToolDeclarations }],
        };
        if (thinkingCfg) {
          requestConfig.thinkingConfig = thinkingCfg;
        }

        return withRetry(
          async () => {
            let roundText = '';
            let roundTextEmitted = false;
            const functionCallMap = new Map<string, FunctionCall>();

            let stream;
            try {
              stream = await ai.models.generateContentStream({
                model: modelName,
                contents: activeContents,
                config: requestConfig,
              });
            } catch (streamErr: unknown) {
              const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
              if (errMsg.includes('Thinking level is not supported') && requestConfig.thinkingConfig) {
                delete requestConfig.thinkingConfig;
                stream = await ai.models.generateContentStream({
                  model: modelName,
                  contents: activeContents,
                  config: requestConfig,
                });
              } else {
                throw streamErr;
              }
            }

            for await (const chunk of stream) {
              if (isCancelled()) break;
              if (chunk.text) {
                roundTextEmitted = true;
                emittedAnyText = true;
                roundText += chunk.text;
                accumulatedMarkdown += chunk.text;
                writeSseEvent(res, 'markdown_delta', { text: chunk.text });
              }

              const candidateParts = chunk.candidates?.[0]?.content?.parts;
              if (candidateParts) {
                for (const part of candidateParts) {
                  if (part.functionCall && part.functionCall.name) {
                    const key = `${part.functionCall.name}:${JSON.stringify(part.functionCall.args || {})}`;
                    functionCallMap.set(key, part.functionCall);
                  }
                }
              }
            }

            const uniqueFunctionCalls = Array.from(functionCallMap.values());
            const cleanModelParts: Part[] = [];
            if (roundText) {
              cleanModelParts.push({ text: roundText });
            }
            for (const fc of uniqueFunctionCalls) {
              cleanModelParts.push({ functionCall: fc });
            }

            return {
              collectedModelParts: cleanModelParts,
              collectedFunctionCalls: uniqueFunctionCalls,
              roundTextEmitted,
            };
          },
          3,
          1500,
          (attempt, delayMs, reason) => {
            recordTraceAndSend({
              phase: 'REASONING',
              title: `${modelName} ${reason} — retry ${attempt}`,
              detail: `Waiting ${(delayMs / 1000).toFixed(1)}s before retrying request.`,
              status: 'warning',
            });
          }
        );
      };

      for (let round = 0; round < 2; round++) {
        if (isCancelled()) break;
        let roundResult;
        try {
          roundResult = await runStreamingRound(activeModel);
        } catch (roundErr) {
          const formatted = formatGeminiError(roundErr);
          if (
            (isRateLimitError(roundErr) || formatted.kind === 'NOT_FOUND') &&
            activeModel !== FALLBACK_MODEL
          ) {
            recordTraceAndSend({
              phase: 'REASONING',
              title: `Model rate-limited or unavailable; failing over to ${FALLBACK_MODEL}`,
              detail: `${activeModel} returned ${formatted.code} (${formatted.kind}). Automatically failing over to ${FALLBACK_MODEL}.`,
              status: 'warning',
            });
            activeModel = FALLBACK_MODEL;
            roundResult = await runStreamingRound(activeModel);
          } else {
            throw roundErr;
          }
        }

        if (isCancelled()) break;

        const { collectedModelParts, collectedFunctionCalls } = roundResult;

        if (collectedFunctionCalls.length === 0) {
          break;
        }

        activeContents.push({
          role: 'model',
          parts: collectedModelParts,
        });

        const functionResponseParts: Part[] = [];
        for (const fc of collectedFunctionCalls) {
          if (isCancelled()) break;
          const toolName = fc.name ?? 'unknown_tool';
          const toolArgs = (fc.args ?? {}) as Record<string, unknown>;
          const execResult = await executeOmniAgentTool(sandbox, toolName, toolArgs);

          if (isCancelled()) break;

          capturedTraces.push({
            id: execResult.log.id,
            phase: execResult.log.phase,
            title: execResult.log.title,
            detail: execResult.log.detail,
            durationMs: execResult.log.durationMs,
            status: execResult.log.status,
          });
          writeSseEvent(res, 'agent_step', execResult.log);
          if (execResult.newPlan) {
            writeSseEvent(res, 'execution_plan', execResult.newPlan);
          }
          if (execResult.newAction) {
            writeSseEvent(res, 'webhook_action', execResult.newAction);
          }

          functionResponseParts.push({
            functionResponse: {
              id: fc.id,
              name: toolName,
              response: execResult.responseObj,
            },
          });
        }

        activeContents.push({
          role: 'user',
          parts: functionResponseParts,
        });
      }

      if (isCancelled()) {
        if (sandbox.version === sandboxVersion) {
          sandbox.messages.push({
            id: assistantMsgId,
            role: 'assistant',
            content: accumulatedMarkdown || 'Execution aborted by operator.',
            timestamp: new Date().toISOString(),
            ragMatches: capturedRagMatches,
            toolTraces: capturedTraces,
            reasoningDepth,
          });
        }
        res.end();
        return;
      }

      if (!emittedAnyText) {
        const fallbackNote =
          'Execution orchestration completed. Inspect the **Execution Logs & Agent Actions** sidebar for the generated plan and webhook artifacts.';
        accumulatedMarkdown = fallbackNote;
        writeSseEvent(res, 'markdown_delta', { text: fallbackNote });
      }

      recordTraceAndSend({
        phase: 'SYNTHESIS',
        title: 'Multi-step synthesis completed',
        detail: `Completed end-to-end orchestration in ${Date.now() - requestStart}ms.`,
        durationMs: Date.now() - requestStart,
        status: 'completed',
      });

      sandbox.messages.push({
        id: assistantMsgId,
        role: 'assistant',
        content: accumulatedMarkdown,
        timestamp: new Date().toISOString(),
        ragMatches: capturedRagMatches,
        toolTraces: capturedTraces,
        reasoningDepth,
      });
      if (sandbox.messages.length > 100) {
        sandbox.messages = sandbox.messages.slice(-100);
      }

      writeSseEvent(res, 'done', {
        durationMs: Date.now() - requestStart,
        state: getSessionStateResponse(sandbox),
      });
      res.end();
    } catch (err) {
      if (isCancelled()) {
        res.end();
        return;
      }
      const formatted = formatGeminiError(err);
      recordTraceAndSend({
        phase: 'REASONING',
        title: `Orchestration error (${formatted.kind})`,
        detail: formatted.message,
        durationMs: Date.now() - requestStart,
        status: 'error',
      });
      sandbox.messages.push({
        id: assistantMsgId,
        role: 'assistant',
        content: accumulatedMarkdown,
        timestamp: new Date().toISOString(),
        ragMatches: capturedRagMatches,
        toolTraces: capturedTraces,
        reasoningDepth,
        error: formatted.message,
      });
      writeSseEvent(res, 'error', {
        code: formatted.code,
        kind: formatted.kind,
        message: formatted.message,
      });
      res.end();
    }
  });

  // Explicit JSON 404 for unknown API endpoints
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Vite dev middleware vs static production serving
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`OmniAgent server listening on http://0.0.0.0:${PORT}`);
  });

  httpServer.on('error', (err) => {
    console.error('OmniAgent HTTP server error:', err);
    process.exit(1);
  });

  const shutdown = () => {
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start OmniAgent server:', err);
  process.exit(1);
});
