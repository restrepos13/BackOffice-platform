import { ConsoleLogger, LogLevel } from '@nestjs/common';

/**
 * Logger de la app con RING BUFFER en memoria: los últimos errores y warnings
 * quedan consultables desde Dev Tools sin ssh ni grep. No sustituye a un
 * agregador externo — es la vista rápida de "¿qué se rompió hace un rato?".
 */

export interface LogEntry {
  at: string;
  level: 'error' | 'warn' | 'log';
  context?: string;
  message: string;
}

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];

function push(level: LogEntry['level'], message: any, context?: string) {
  buffer.push({
    at: new Date().toISOString(),
    level,
    context,
    message: typeof message === 'string' ? message : JSON.stringify(message),
  });
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
}

export function getRecentLogs(level?: string, limit = 100): LogEntry[] {
  const filtered = level && level !== 'all'
    ? buffer.filter((e) => e.level === level)
    : buffer;
  return filtered.slice(-Math.min(Math.max(limit, 1), MAX_ENTRIES)).reverse();
}

export class BufferedLogger extends ConsoleLogger {
  error(message: any, ...rest: any[]) {
    push('error', message, typeof rest[rest.length - 1] === 'string' ? rest[rest.length - 1] : undefined);
    super.error(message, ...rest);
  }

  warn(message: any, ...rest: any[]) {
    push('warn', message, typeof rest[rest.length - 1] === 'string' ? rest[rest.length - 1] : undefined);
    super.warn(message, ...rest);
  }

  setLogLevels(levels: LogLevel[]) {
    super.setLogLevels(levels);
  }
}
