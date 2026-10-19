const BASE = '/api';

export function getToken(): string | null {
  return localStorage.getItem('bo_token');
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem('bo_token', token);
  else localStorage.removeItem('bo_token');
}

/**
 * Error del API con lo necesario para mostrarlo bien: mensaje en palabras
 * simples, el campo del formulario que falló (si aplica) y un código.
 * status 0 = no hubo respuesta (sin internet o el servidor está despertando).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: string,
    readonly code?: string,
  ) {
    super(message);
  }
  /** Vale la pena reintentar solo (sin internet, servidor despertando o saturado). */
  get retryable() {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

const FRIENDLY: Record<number, string> = {
  0: 'No pudimos conectarnos. Revisa tu internet e intenta de nuevo.',
  413: 'Lo que enviaste es muy grande. Intenta con algo más corto.',
  429: 'Hiciste muchos intentos seguidos. Espera un minuto y vuelve a intentar.',
  500: 'Algo salió mal de nuestro lado. Intenta de nuevo en un momento.',
  502: 'Estamos encendiendo el sistema. Dame unos segundos e intenta de nuevo.',
  503: 'Estamos encendiendo el sistema. Dame unos segundos e intenta de nuevo.',
  504: 'Tardó demasiado en responder. Intenta de nuevo.',
};

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(FRIENDLY[0], 0);
  }
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/public/')) {
    setToken(null);
    window.location.href = '/login';
    throw new ApiError('Sesión expirada', 401);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = Array.isArray(data?.message) ? data.message.join(', ') : data?.message;
    // Mensajes técnicos (o en inglés) no llegan a la persona
    const technical = !raw || res.status === 429 || (res.status >= 500 && !data?.code) || /^[A-Z][a-z]+(Exception| Error)|Too Many Requests|Internal server/i.test(String(raw));
    const msg = technical ? FRIENDLY[res.status] ?? FRIENDLY[500] : String(raw);
    throw new ApiError(msg, res.status, data?.field, data?.code);
  }
  return data as T;
}

/** Igual que api.post pero reintenta solo si el servidor está despertando o no hubo red. */
export async function postWithRetry<T>(
  path: string,
  body: unknown,
  opts: { tries?: number; onRetry?: (attempt: number) => void } = {},
): Promise<T> {
  const tries = opts.tries ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await request<T>('POST', path, body);
    } catch (err) {
      if (!(err instanceof ApiError) || !err.retryable || attempt >= tries) throw err;
      opts.onRetry?.(attempt);
      await new Promise((r) => setTimeout(r, 2500 * attempt));
    }
  }
}

/** Abre un PDF autenticado del API en una pestaña nueva (blob + JWT). */
export async function openPdf(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error('No se pudo generar el PDF');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Sube un archivo (multipart) al API con el JWT. */
export async function uploadFile<T = unknown>(path: string, field: string, file: File, extra?: Record<string, string>): Promise<T> {
  const form = new FormData();
  form.append(field, file);
  Object.entries(extra ?? {}).forEach(([k, v]) => form.append(k, v));
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(Array.isArray(data?.message) ? data.message.join(', ') : data?.message ?? `Error ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
