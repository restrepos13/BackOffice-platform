/**
 * Ayudas del registro: validación en palabras simples, avance guardado en el
 * navegador, dictado por voz y seguimiento de pasos (para que el equipo sepa
 * dónde se queda la gente).
 */
import type { BusinessBlueprint, SetupProposal } from '../../lib/types';

export type Msg = { role: 'user' | 'assistant'; content: string; note?: string; options?: string[]; failed?: boolean };

export interface Preview {
  rubro: string;
  rubroLabel: string;
  company: { name: string; city: string; summary: string };
  proposal: SetupProposal;
  blueprint: BusinessBlueprint;
  /** Tipo de negocio detectado y herramientas que no le aplican */
  profile?: { key: string; label: string; hide: string[] };
  mode?: 'ai' | 'guided';
}

export interface AccountForm {
  companyName: string;
  city: string;
  name: string;
  email: string;
  phone: string;
  password: string;
  accept: boolean;
}

export type FieldErrors = Partial<Record<keyof AccountForm, string>>;

/* ── Validación ─────────────────────────────────────────────────── */

const DOMAIN_TYPOS: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com', 'gnail.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmail.om': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmail.co': 'hotmail.com', 'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outlook.co': 'outlook.com', 'yaho.com': 'yahoo.com', 'yahoo.co': 'yahoo.com',
};

export function emailSuggestion(email: string): string | null {
  const [user, domain] = email.trim().toLowerCase().split('@');
  if (!user || !domain) return null;
  const fixed = DOMAIN_TYPOS[domain];
  return fixed ? `${user}@${fixed}` : null;
}

export const phoneDigits = (v: string) => v.replace(/\D/g, '');

/** 3001234567 → "300 123 4567" mientras escribe. */
export function formatPhone(v: string): string {
  const d = phoneDigits(v);
  if (d.length > 10 || !d.startsWith('3')) return v.replace(/[^\d+\s]/g, '').slice(0, 18);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 10)].filter(Boolean).join(' ');
}

export function validateField(field: keyof AccountForm, form: AccountForm): string | undefined {
  const v = form[field];
  switch (field) {
    case 'companyName':
      return String(v).trim().length < 2 ? 'Escribe el nombre de tu negocio' : undefined;
    case 'name':
      return String(v).trim().length < 2 ? 'Escribe tu nombre' : undefined;
    case 'email': {
      const e = String(v).trim();
      if (!e) return 'Escribe tu correo';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'A ese correo le falta algo. Ejemplo: nombre@gmail.com';
      return undefined;
    }
    case 'phone': {
      const d = phoneDigits(String(v));
      if (!d) return 'Escribe tu número de WhatsApp';
      if (!((d.length === 10 && d.startsWith('3')) || (d.length >= 11 && d.length <= 15))) {
        return 'Debe tener 10 números y empezar por 3. Ejemplo: 300 123 4567';
      }
      return undefined;
    }
    case 'password':
      return String(v).length < 8 ? `Te faltan ${8 - String(v).length} letras o números (mínimo 8)` : undefined;
    case 'accept':
      return v ? undefined : 'Marca esta casilla para continuar';
    default:
      return undefined;
  }
}

export const ACCOUNT_FIELDS: Array<keyof AccountForm> = ['companyName', 'name', 'phone', 'email', 'password', 'accept'];

export function validateAll(form: AccountForm): FieldErrors {
  const out: FieldErrors = {};
  for (const f of ACCOUNT_FIELDS) {
    const e = validateField(f, form);
    if (e) out[f] = e;
  }
  return out;
}

export function passwordStrength(p: string): { label: string; tone: 'bad' | 'warn' | 'ok' } {
  if (p.length < 8) return { label: 'Muy corta', tone: 'bad' };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter((re) => re.test(p)).length;
  if (p.length >= 12 && kinds >= 3) return { label: 'Muy segura', tone: 'ok' };
  if (kinds >= 2) return { label: 'Buena', tone: 'ok' };
  return { label: 'Aceptable: mezcla letras y números', tone: 'warn' };
}

/* ── Avance guardado (si recarga o se va, sigue donde iba) ───────── */

const DRAFT_KEY = 'bo_signup_v2';
const SESSION_KEY = 'bo_signup_session';
const DRAFT_TTL_MS = 7 * 86400e3;

export interface SignupDraft {
  step: 1 | 2 | 3;
  messages: Msg[];
  interviewDone: boolean;
  preview: Preview | null;
  form: Omit<AccountForm, 'password'>;
  savedAt: number;
}

export function loadDraft(): SignupDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SignupDraft;
    if (!d?.savedAt || Date.now() - d.savedAt > DRAFT_TTL_MS || !Array.isArray(d.messages)) return null;
    return d;
  } catch {
    return null;
  }
}

export function saveDraft(d: Omit<SignupDraft, 'savedAt'>) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, savedAt: Date.now() }));
  } catch {
    /* sin almacenamiento: igual funciona, solo no recuerda */
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* nada que borrar */
  }
}

/** Token de esta sesión de registro (para el seguimiento del equipo). */
export function sessionToken(): string {
  try {
    const saved = localStorage.getItem(SESSION_KEY);
    if (saved && /^[A-Za-z0-9_-]{16,64}$/.test(saved)) return saved;
    const fresh = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
    localStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    return Math.random().toString(36).slice(2).padEnd(20, 'x');
  }
}

/** Campaña de origen (?utm_source=facebook&utm_campaign=…), recordada mientras dura el registro. */
function utm(): { utmSource?: string; utmCampaign?: string } {
  try {
    const qs = new URLSearchParams(window.location.search);
    const fresh = { utmSource: qs.get('utm_source') ?? undefined, utmCampaign: qs.get('utm_campaign') ?? undefined };
    if (fresh.utmSource || fresh.utmCampaign) sessionStorage.setItem('bo_utm', JSON.stringify(fresh));
    return JSON.parse(sessionStorage.getItem('bo_utm') ?? '{}');
  } catch {
    return {};
  }
}

/** Código de quien lo invitó (?ref=ABC123), recordado durante el registro. */
export function referralCode(): string | undefined {
  try {
    const fresh = new URLSearchParams(window.location.search).get('ref');
    if (fresh && /^[A-Za-z0-9]{6}$/.test(fresh)) sessionStorage.setItem('bo_ref', fresh.toUpperCase());
    return sessionStorage.getItem('bo_ref') ?? undefined;
  } catch {
    return undefined;
  }
}

/** Aviso de paso / contacto / error al equipo. Nunca bloquea ni muestra errores. */
export function track(event: 'view' | 'contact' | 'error', extra: Record<string, unknown> = {}) {
  try {
    void fetch('/api/public/signup/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionToken(), event, referrer: document.referrer || undefined, ...utm(), ...extra }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* seguimiento opcional */
  }
}

/* ── Dictado por voz (Chrome, Edge, Safari) ──────────────────────── */

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

export function startDictation(onText: (text: string, final: boolean) => void, onEnd: () => void): (() => void) | null {
  const Rec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Rec) return null;
  const rec = new Rec();
  rec.lang = 'es-CO';
  rec.interimResults = true;
  rec.continuous = true;
  rec.onresult = (e: any) => {
    let text = '';
    let final = false;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      text += e.results[i][0].transcript;
      final = e.results[i].isFinal;
    }
    onText(text, final);
  };
  rec.onend = onEnd;
  rec.onerror = onEnd;
  try {
    rec.start();
  } catch {
    return null;
  }
  return () => {
    try {
      rec.stop();
    } catch {
      /* ya se detuvo */
    }
  };
}
