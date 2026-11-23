import { ServiceError } from './auth.js';
import { maskPrivateText } from './private-text.js';

export type ResearchDiagnostic = {
  at: number;
  phase: string;
  code: string;
  errorName: string;
  message: string;
  frames: string[];
  recovery: 'reobserve' | 'stopped';
};

// Keep the cause of wrapped Playwright errors, without its DOM/call-log payload,
// request URLs, local home path, credentials or participant values.
export function researchDiagnostic(
  error: unknown,
  phase: string,
  secrets: string[],
  recovery: ResearchDiagnostic['recovery'],
): ResearchDiagnostic {
  const outer = error instanceof Error ? error : new Error('Non-Error exception');
  const cause = outer.cause instanceof Error ? outer.cause : outer;
  const clean = (text: string) =>
    maskPrivateText(text, secrets)
      .replace(/https?:\/\/[^\s)]+/g, '[url]')
      .replace(/(?:Bearer\s+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*)\S+/gi, '[secret]')
      .replace(/(['"`]).*?\1/g, '[value]');
  return {
    at: Date.now(),
    phase,
    code: outer instanceof ServiceError ? outer.code : 'research_browser_error',
    errorName: /^[A-Za-z]{1,40}$/.test(cause.name) ? cause.name : 'Error',
    message: clean(cause.message.split('\n')[0] || 'Unknown browser error').slice(0, 400),
    frames: (cause.stack || '')
      .split('\n')
      .slice(1)
      .map((line) => {
        const match = line.match(/(?:^|\/)([\w.-]+\.(?:[cm]?[jt]s)):(\d+):(\d+)/);
        return match ? `${match[1]}:${match[2]}:${match[3]}` : '';
      })
      .filter(Boolean)
      .slice(0, 4),
    recovery,
  };
}
