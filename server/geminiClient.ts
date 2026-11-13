process.env.GOOGLE_GENAI_API_VERSION = 'v1beta';
import { GoogleGenAI } from '@google/genai';

let cachedClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  process.env.GOOGLE_GENAI_API_VERSION = 'v1beta';
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please verify your key in Settings > Secrets.'
    );
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      apiVersion: 'v1beta',
      httpOptions: {
        baseUrl: 'https://generativelanguage.googleapis.com/',
        apiVersion: 'v1beta',
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

export interface FormattedApiError {
  code: number;
  kind: 'RATE_LIMIT' | 'AUTH' | 'NOT_FOUND' | 'BAD_REQUEST' | 'INTERNAL';
  message: string;
}

export function formatGeminiError(err: unknown): FormattedApiError {
  const raw = err instanceof Error ? err.message : String(err);
  const statusMatch = raw.match(/\b(400|401|403|404|429|500|503)\b/);
  const statusCode = statusMatch ? Number(statusMatch[1]) : 500;

  if (raw.includes('RESOURCE_EXHAUSTED') || statusCode === 429) {
    return {
      code: 429,
      kind: 'RATE_LIMIT',
      message:
        'Gemini API rate limit reached (429 RESOURCE_EXHAUSTED). Retried with backoff; please wait a few seconds before retrying or reduce batch size.',
    };
  }
  if (
    raw.includes('PERMISSION_DENIED') ||
    raw.includes('API_KEY_INVALID') ||
    statusCode === 401 ||
    statusCode === 403
  ) {
    return {
      code: 403,
      kind: 'AUTH',
      message:
        'Gemini API authentication failed. Please verify GEMINI_API_KEY in the Settings > Secrets panel.',
    };
  }
  if (raw.includes('NOT_FOUND') || statusCode === 404) {
    return {
      code: 404,
      kind: 'NOT_FOUND',
      message:
        'Requested Gemini model endpoint was not found (404). Verify active model identifier (gemini-4-hydrogen / gemini-embedding-2).',
    };
  }
  if (statusCode === 400) {
    return {
      code: 400,
      kind: 'BAD_REQUEST',
      message: `Invalid request payload sent to Gemini: ${raw}`,
    };
  }
  return {
    code: statusCode,
    kind: 'INTERNAL',
    message: raw || 'Unexpected server error while communicating with Gemini.',
  };
}

export function isRateLimitError(err: unknown): boolean {
  return formatGeminiError(err).kind === 'RATE_LIMIT';
}

function parseSuggestedDelayMs(err: unknown): number | null {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(/retry(?:\s+in|Delay["']?\s*[:=]\s*["']?)\s*(\d+(?:\.\d+)?)\s*s/i);
  if (!match) return null;
  const secs = Number(match[1]);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return Math.min(12000, Math.ceil(secs * 1000));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1500,
  onRetry?: (attempt: number, delayMs: number, reason: string) => void
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const formatted = formatGeminiError(err);
      const isRetryable =
        formatted.kind === 'RATE_LIMIT' ||
        formatted.code === 503 ||
        formatted.code === 500;

      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 350);
      const exponential = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
      const suggested = parseSuggestedDelayMs(err);
      const delay = Math.min(12000, Math.max(exponential, suggested ?? 0));
      onRetry?.(attempt, delay, formatted.kind);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
