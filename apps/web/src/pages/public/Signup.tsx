import { clsx } from 'clsx';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Lock, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, postWithRetry } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtMoney } from '../../lib/format';
import type { SetupProfile } from '../../lib/setup';
import type { AuthUser, InterviewTurn } from '../../lib/types';
import { Button, Field, Input } from '../../components/ui';
import {
  ACCOUNT_FIELDS, type AccountForm, type FieldErrors, type Msg, type Preview, clearDraft, emailSuggestion, formatPhone,
  loadDraft, passwordStrength, referralCode, saveDraft, sessionToken, speechSupported, startDictation, track, validateAll, validateField,
} from './signup-helpers';
import InterviewStep from './signup/InterviewStep';
import ProductsStep from './signup/ProductsStep';
import ProposalStep from './signup/ProposalStep';
import ReviewSummary from './signup/ReviewSummary';
import { Notice, StepActions, StepTitle, Stepper, type StepNumber } from './signup/parts';

/**
 * Registro autoservicio en 4 pasos:
 *  1. Tu negocio: entrevista adaptativa (IA o preguntas fijas), una pregunta a la vez.
 *  2. Propuesta: lo que entendimos, lo que resolvemos y el estado real de cada función.
 *  3. Productos: qué activar (ninguno es obligatorio) y la configuración inicial.
 *  4. Revisión y cuenta: resumen editable y datos de acceso.
 * Nunca se pierde lo escrito: el avance queda en el navegador (sin la contraseña),
 * el botón Atrás del navegador vuelve de paso, y el servidor valida y recalcula todo.
 */

const OPENING = '¡Hola! Te voy a hacer unas preguntas cortas para armar tu cuenta. Para empezar: ¿qué hace tu negocio?';
const DRAFT_VERSION = 3;
const EMPTY_FORM: AccountForm = { companyName: '', city: '', name: '', email: '', phone: '', password: '', accept: false };

function messageOf(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback;
}

export default function Signup() {
  const { user, loading, adopt } = useAuth();
  const navigate = useNavigate();
  const saved = useMemo(() => loadDraft(), []);
  const [resumeOffer, setResumeOffer] = useState(!!saved && (saved.step > 1 || saved.messages.length > 1));
  const [step, setStep] = useState<StepNumber>(1);
  const [messages, setMessages] = useState<Msg[]>([{ role: 'assistant', content: OPENING }]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [waking, setWaking] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [interviewDone, setInterviewDone] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [productError, setProductError] = useState<string | null>(null);
  const [form, setForm] = useState<AccountForm>(EMPTY_FORM);
  const [touched, setTouched] = useState<Partial<Record<keyof AccountForm, boolean>>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [listening, setListening] = useState(false);
  const stopDictation = useRef<(() => void) | null>(null);
  const dictationBase = useRef('');
  const input = useRef<HTMLTextAreaElement>(null);
  const fieldRefs = useRef<Partial<Record<keyof AccountForm, HTMLElement | null>>>({});
  const previewRef = useRef<Preview | null>(null);
  previewRef.current = preview;
  const firstRender = useRef(true);

  useEffect(() => {
    document.title = 'Crea tu empresa · BackOffice';
    track('view', { step: 'STARTED' });
    referralCode(); // guarda el ?ref= antes de que la URL cambie
    // El botón Atrás del navegador cambia de paso en vez de salir del registro
    window.history.replaceState({ ...(window.history.state ?? {}), signupStep: 1 }, '');
    const onPop = (e: PopStateEvent) => {
      const n = Number(e.state?.signupStep) as StepNumber;
      if (n >= 1 && n <= 4) setStep(n > 1 && !previewRef.current ? 1 : n);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      stopDictation.current?.();
    };
  }, []);
  // Se guarda el avance (nunca la contraseña)
  useEffect(() => {
    if (resumeOffer) return;
    if (messages.length < 2 && step === 1) return;
    const { password: _p, ...safeForm } = form;
    saveDraft({ v: DRAFT_VERSION, step, messages, interviewDone, preview, form: safeForm });
  }, [step, messages, interviewDone, preview, form, resumeOffer]);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (step > 1) track('view', { step: step === 4 ? 'ACCOUNT' : 'PREVIEW' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // El foco va al título del paso (teclado y lectores de pantalla)
    setTimeout(() => document.getElementById('step-title')?.focus({ preventScroll: true }), 60);
  }, [step]);

  if (!loading && user) return <Navigate to="/" replace />;

  const transcript = (list = messages) => list.filter((m) => !m.failed).map(({ role, content }) => ({ role, content }));
  const setup = preview?.setup ?? null;
  const setSetup = (next: SetupProfile) => setPreview((prev) => (prev ? { ...prev, setup: next } : prev));

  function goTo(n: StepNumber) {
    if (n === step) return;
    setStep(n);
    window.history.pushState({ ...(window.history.state ?? {}), signupStep: n }, '');
  }
  const reachable = (n: StepNumber) => n === 1 || (!!preview && !correcting && !building);

  function resume() {
    if (!saved) return;
    // Borradores de antes (3 pasos): su paso 3 era «Tus datos», que ahora es el 4
    const savedStep = (saved.v ?? 2) < DRAFT_VERSION && saved.step === 3 ? 4 : saved.step;
    setMessages(saved.messages.filter((m) => !m.failed));
    setInterviewDone(saved.interviewDone);
    setPreview(saved.preview);
    setForm({ ...EMPTY_FORM, ...saved.form, password: '' });
    const n = (saved.preview ? savedStep : 1) as StepNumber;
    setStep(n);
    window.history.replaceState({ ...(window.history.state ?? {}), signupStep: n }, '');
    setResumeOffer(false);
  }

  function restart() {
    clearDraft();
    setMessages([{ role: 'assistant', content: OPENING }]);
    setPreview(null);
    setInterviewDone(false);
    setCorrecting(false);
    setBuildError(null);
    setChatError(null);
    setDraft('');
    setForm(EMPTY_FORM);
    setStep(1);
    setResumeOffer(false);
    track('view', { step: 'STARTED' });
  }

  function toggleDictation() {
    if (listening) {
      stopDictation.current?.();
      return;
    }
    dictationBase.current = draft ? `${draft.trim()} ` : '';
    const stop = startDictation(
      (text) => setDraft(`${dictationBase.current}${text}`.slice(0, 1200)),
      () => {
        setListening(false);
        stopDictation.current = null;
      },
    );
    if (!stop) {
      toast.error('No pudimos usar el micrófono. Revisa que el navegador tenga permiso.');
      return;
    }
    stopDictation.current = stop;
    setListening(true);
  }

  async function answer(text: string) {
    const t = text.trim();
    if (!t || thinking) return;
    stopDictation.current?.();
    const base = messages.filter((m) => !m.failed);
    const next: Msg[] = [...base, { role: 'user', content: t }];
    setMessages(next);
    setDraft('');
    setChatError(null);
    setThinking(true);
    try {
      const turn = await postWithRetry<InterviewTurn & { mode?: string }>(
        '/public/signup/interview',
        { session: sessionToken(), messages: transcript(next) },
        { onRetry: () => setWaking(true) },
      );
      const withNote = next.map((m, i) => (i === next.length - 1 && turn.understood ? { ...m, note: turn.understood } : m));
      if (turn.done) {
        setMessages([...withNote, { role: 'assistant', content: '¡Listo! Ya entendí cómo funciona tu negocio. Ahora armo tu propuesta.' }]);
        setInterviewDone(true);
        void build(transcript(withNote));
      } else {
        setMessages([...withNote, { role: 'assistant', content: turn.question, options: turn.options }]);
      }
    } catch (e) {
      // La respuesta no se pierde: queda marcada para reintentar
      setMessages(next.map((m, i) => (i === next.length - 1 ? { ...m, failed: true } : m)));
      const msg = messageOf(e, 'No pudimos enviar tu respuesta.');
      setChatError(msg);
      track('error', { step: 'INTERVIEW', message: msg });
    } finally {
      setThinking(false);
      setWaking(false);
      setTimeout(() => input.current?.focus(), 50);
    }
  }

  function retryFailed() {
    const failed = [...messages].reverse().find((m) => m.failed);
    if (!failed) return;
    setMessages(messages.filter((m) => m !== failed));
    void answer(failed.content);
  }

  /** Corregir una respuesta: la conversación sigue desde esa pregunta (el motor vuelve a preguntar lo siguiente). */
  function correct(index: number) {
    const target = messages[index];
    if (!target || target.role !== 'user') return;
    stopDictation.current?.();
    setMessages(messages.slice(0, index));
    setDraft(target.content);
    setInterviewDone(false);
    setCorrecting(true);
    setBuildError(null);
    setChatError(null);
    if (step !== 1) goTo(1);
    setTimeout(() => {
      input.current?.focus();
      input.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  }

  async function build(history = transcript()) {
    setInterviewDone(true);
    setBuilding(true);
    setBuildError(null);
    try {
      const r = await postWithRetry<Preview>('/public/signup/preview', { session: sessionToken(), messages: history }, { onRetry: () => setWaking(true) });
      setPreview(r);
      setCorrecting(false);
      setForm((f) => ({ ...f, companyName: f.companyName || r.company.name, city: f.city || r.company.city }));
      setStep(2);
      window.history.pushState({ ...(window.history.state ?? {}), signupStep: 2 }, '');
    } catch (e) {
      const msg = messageOf(e, 'No pudimos armar tu propuesta.');
      setBuildError(msg);
      track('error', { step: 'PREVIEW', message: msg });
      // Si faltó contar más, se vuelve a la entrevista para seguir
      if (e instanceof ApiError && e.code === 'TOO_SHORT') {
        setInterviewDone(false);
        setMessages((list) => [...list, { role: 'assistant', content: 'Cuéntame un poquito más: ¿qué vendes y a quién?' }]);
        setBuildError(null);
        setStep(1);
      }
    } finally {
      setBuilding(false);
      setWaking(false);
    }
  }

  function toProducts() {
    if (!form.companyName.trim()) {
      setNameError('Escribe el nombre de tu negocio para seguir');
      document.getElementById('company-name')?.focus();
      return;
    }
    setNameError(null);
    goTo(3);
  }

  function toReview() {
    if (setup && !setup.products.selected.length) {
      setProductError('Elige al menos un producto para seguir.');
      return;
    }
    setProductError(null);
    goTo(4);
  }

  /* ── Paso 4: validación amable ── */

  function setField<K extends keyof AccountForm>(field: K, value: AccountForm[K]) {
    const next = { ...form, [field]: value };
    setForm(next);
    if (serverError) setServerError(null);
    if (touched[field] || errors[field]) setErrors((e) => ({ ...e, [field]: validateField(field, next) }));
  }

  function blur(field: keyof AccountForm) {
    setTouched((t) => ({ ...t, [field]: true }));
    const err = validateField(field, form);
    setErrors((e) => ({ ...e, [field]: err }));
    // Contacto bien escrito → el equipo puede ayudarle si se queda a mitad
    if (!err && ['name', 'email', 'phone', 'companyName'].includes(field)) {
      track('contact', { data: { name: form.name, email: form.email, phone: form.phone, companyName: form.companyName } });
    }
  }

  function focusFirstError(errs: FieldErrors) {
    const first = ACCOUNT_FIELDS.find((f) => errs[f]);
    if (first) {
      const el = fieldRefs.current[first];
      el?.focus();
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!preview || busy) return;
    const errs = validateAll(form);
    setErrors(errs);
    setTouched(Object.fromEntries(ACCOUNT_FIELDS.map((f) => [f, true])));
    if (Object.values(errs).some(Boolean)) {
      focusFirstError(errs);
      return;
    }
    setBusy(true);
    setServerError(null);
    try {
      const res = await postWithRetry<{ token: string; user: AuthUser }>(
        '/public/signup',
        {
          session: sessionToken(),
          messages: transcript(),
          rubro: preview.rubro,
          proposal: preview.proposal,
          blueprint: preview.blueprint,
          setup: preview.setup,
          company: { name: form.companyName, city: form.city },
          admin: { name: form.name, email: form.email.trim(), phone: form.phone, password: form.password },
          acceptTerms: form.accept,
          referralCode: referralCode(),
        },
        { tries: 2, onRetry: () => setWaking(true) },
      );
      clearDraft();
      adopt(res.token, res.user);
      toast.success('¡Tu empresa quedó creada!');
      navigate('/app/bienvenida', { replace: true });
    } catch (err) {
      const msg = messageOf(err, 'No pudimos crear tu cuenta. Intenta de nuevo.');
      track('error', { step: 'ACCOUNT', message: msg });
      if (err instanceof ApiError && err.field && (ACCOUNT_FIELDS as string[]).includes(err.field)) {
        const field = err.field as keyof AccountForm;
        const errs2 = { ...errors, [field]: msg };
        setErrors(errs2);
        focusFirstError(errs2);
        if (err.code === 'EMAIL_TAKEN') setServerError({ message: msg, code: err.code });
      } else {
        setServerError({ message: msg });
      }
    } finally {
      setBusy(false);
      setWaking(false);
    }
  }

  const strength = passwordStrength(form.password);
  const suggestion = emailSuggestion(form.email);
  const invalid = (f: keyof AccountForm) => (errors[f] ? true : undefined);

  return (
    <div className="min-h-screen bg-bone text-ink">
      <header className="border-b-2 border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 md:px-6">
          <Link to="/" className="display text-2xl leading-none">
            BackOffice<span className="text-ok">.</span>
          </Link>
          <p className="text-sm text-ink-2">
            ¿Ya tienes cuenta? <Link to="/login" className="font-semibold text-ink underline-offset-2 hover:underline">Entrar</Link>
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-8 md:px-6">
        {!resumeOffer && <Stepper step={step} reachable={reachable} onGo={goTo} />}

        {resumeOffer && saved && (
          <div className="mx-auto max-w-2xl border-2 border-ink bg-paper p-6">
            <p className="kicker">Registro guardado</p>
            <h1 className="mt-1 text-2xl font-semibold">Tienes un registro a medias{saved.form.companyName ? ` de ${saved.form.companyName}` : ''}</h1>
            <p className="mt-2 text-sm text-ink-2">Guardamos tus respuestas en este navegador. Puedes seguir donde ibas o empezar desde cero.</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button onClick={resume}>Seguir donde iba <ArrowRight size={14} /></Button>
              <Button variant="outline" onClick={restart}><RotateCcw size={13} /> Empezar de nuevo</Button>
            </div>
          </div>
        )}

        {waking && (
          <div className="mb-5">
            <Notice tone="warn">Estamos encendiendo el sistema. A veces tarda unos segundos; no cierres la página.</Notice>
          </div>
        )}

        {step === 1 && !resumeOffer && (
          <InterviewStep
            messages={messages}
            draft={draft}
            setDraft={setDraft}
            thinking={thinking}
            building={building}
            buildError={buildError}
            chatError={chatError}
            interviewDone={interviewDone}
            correcting={correcting}
            listening={listening}
            speech={speechSupported()}
            inputRef={input}
            hasProposal={!!preview && !correcting}
            onAnswer={answer}
            onRetryFailed={retryFailed}
            onBuild={() => void build()}
            onCorrect={correct}
            onToggleDictation={toggleDictation}
            onRestart={restart}
            onReturnToProposal={() => goTo(2)}
          />
        )}

        {step === 2 && preview && (
          <ProposalStep
            preview={preview}
            companyName={form.companyName}
            onCompanyName={(v) => {
              setForm({ ...form, companyName: v });
              if (v.trim()) setNameError(null);
            }}
            nameError={nameError}
            setup={setup}
            onSetup={setSetup}
            building={building}
            buildError={buildError}
            onRegenerate={() => void build()}
            onCorrectAnswers={() => goTo(1)}
            onNext={toProducts}
          />
        )}

        {step === 3 && preview && (
          <ProductsStep
            preview={preview}
            setPreview={setPreview}
            setup={setup}
            onSetup={(s) => {
              setSetup(s);
              if (s.products.selected.length) setProductError(null);
            }}
            error={productError}
            onBack={() => goTo(2)}
            onNext={toReview}
          />
        )}

        {step === 4 && preview && (
          <div>
            <StepTitle kicker="Paso 4 · Revisión y cuenta" title="Revisa y crea tu cuenta">
              Confirma que todo esté bien y pon tus datos de acceso. Con esto entras a tu panel.
            </StepTitle>
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
              <form noValidate onSubmit={create} className="order-2 space-y-5 self-start border-2 border-ink bg-paper p-5 sm:p-6 lg:order-1" aria-labelledby="account-title">
                <h2 id="account-title" className="text-lg font-semibold">Tus datos</h2>

                {serverError && (
                  <Notice
                    tone="bad"
                    action={serverError.code === 'EMAIL_TAKEN' ? <Link to="/login" className="text-sm font-semibold underline">Entrar con ese correo</Link> : undefined}
                  >
                    {serverError.message}
                  </Notice>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Nombre de tu negocio" required error={errors.companyName}>
                    <Input
                      ref={(el) => { fieldRefs.current.companyName = el; }}
                      value={form.companyName}
                      maxLength={80}
                      aria-invalid={invalid('companyName')}
                      onChange={(e) => setField('companyName', e.target.value)}
                      onBlur={() => blur('companyName')}
                    />
                  </Field>
                  <Field label="Ciudad" hint="Opcional">
                    <Input value={form.city} maxLength={60} autoComplete="address-level2" onChange={(e) => setField('city', e.target.value)} />
                  </Field>
                  <Field label="Tu nombre" required error={errors.name}>
                    <Input
                      ref={(el) => { fieldRefs.current.name = el; }}
                      autoComplete="name"
                      value={form.name}
                      maxLength={80}
                      aria-invalid={invalid('name')}
                      onChange={(e) => setField('name', e.target.value)}
                      onBlur={() => blur('name')}
                    />
                  </Field>
                  <Field label="Tu WhatsApp" required error={errors.phone} hint="Por aquí te escribimos para dejar todo listo">
                    <Input
                      ref={(el) => { fieldRefs.current.phone = el; }}
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="300 123 4567"
                      value={form.phone}
                      aria-invalid={invalid('phone')}
                      onChange={(e) => setField('phone', formatPhone(e.target.value))}
                      onBlur={() => blur('phone')}
                    />
                  </Field>
                  <Field label="Tu correo" required error={errors.email} hint={suggestion ? undefined : 'Con este correo entras a tu cuenta'}>
                    <Input
                      ref={(el) => { fieldRefs.current.email = el; }}
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      placeholder="nombre@gmail.com"
                      value={form.email}
                      aria-invalid={invalid('email')}
                      onChange={(e) => setField('email', e.target.value.replace(/\s/g, ''))}
                      onBlur={() => blur('email')}
                    />
                  </Field>
                  <Field label="Crea una contraseña" required error={errors.password} hint="Mínimo 8 caracteres">
                    <span className="relative block">
                      <Input
                        ref={(el) => { fieldRefs.current.password = el; }}
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={form.password}
                        aria-invalid={invalid('password')}
                        className="!pr-11"
                        onChange={(e) => setField('password', e.target.value)}
                        onBlur={() => blur('password')}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Ocultar contraseña' : 'Ver contraseña'}
                        className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer p-1 text-ink-3 hover:text-ink"
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </span>
                    {form.password && !errors.password && (
                      <span className={clsx('mt-1 block text-xs font-semibold', strength.tone === 'ok' ? 'text-ok' : strength.tone === 'warn' ? 'text-warn' : 'text-bad')}>
                        {strength.label}
                      </span>
                    )}
                  </Field>
                </div>

                {suggestion && (
                  <button type="button" onClick={() => setField('email', suggestion)} className="cursor-pointer text-sm font-semibold underline">
                    ¿Quisiste decir {suggestion}? Toca para corregir
                  </button>
                )}

                <div>
                  <label className={clsx('flex cursor-pointer items-start gap-3 border-2 p-3 text-sm', errors.accept ? 'border-bad bg-bad-soft' : 'border-line')}>
                    <input
                      ref={(el) => { fieldRefs.current.accept = el; }}
                      type="checkbox"
                      className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-[#1a1a1a]"
                      checked={form.accept}
                      aria-invalid={invalid('accept')}
                      onChange={(e) => {
                        setField('accept', e.target.checked);
                        if (e.target.checked) setErrors((x) => ({ ...x, accept: undefined }));
                      }}
                    />
                    <span>
                      Acepto los{' '}
                      <Link to="/terminos" target="_blank" className="font-semibold underline" onClick={(e) => e.stopPropagation()}>términos y condiciones</Link>{' '}
                      y autorizo el tratamiento de mis datos para crear y operar mi cuenta.
                    </span>
                  </label>
                  {errors.accept && <p role="alert" className="mt-1 text-xs font-semibold text-bad">{errors.accept}</p>}
                </div>

                <StepActions
                  back={<Button type="button" variant="outline" onClick={() => goTo(3)}><ArrowLeft size={14} /> Atrás</Button>}
                  next={
                    <Button type="submit" disabled={busy} className="!px-5 !py-2.5">
                      {busy ? 'Creando tu empresa…' : <>Crear mi empresa <ArrowRight size={15} /></>}
                    </Button>
                  }
                />
                <p className="flex items-start gap-2 text-xs text-ink-3">
                  <Lock size={13} className="mt-0.5 shrink-0" aria-hidden />
                  No te pedimos tarjeta. Tu contraseña no se guarda en el navegador; el resto del avance sí, para que no lo pierdas.
                </p>
              </form>

              <aside className="order-1 space-y-4 lg:sticky lg:top-6 lg:order-2 lg:self-start">
                <ReviewSummary preview={preview} setup={setup} companyName={form.companyName} city={form.city} onEdit={goTo} />
                <div className="space-y-2 text-sm">
                  <p className="kicker">Qué pasa después</p>
                  <ol className="space-y-2 text-ink-2">
                    <li className="border-l-2 border-ink pl-3"><b className="text-ink">Entras a tu panel</b> con lo que armamos.</li>
                    <li className="border-l-2 border-ink pl-3"><b className="text-ink">Te escribimos por WhatsApp</b> para conectar lo que falte.</li>
                    <li className="border-l-2 border-ink pl-3"><b className="text-ink">Eliges tu plan</b> cuando todo esté funcionando.</li>
                  </ol>
                  <p className="text-xs text-ink-3">Desde {fmtMoney(preview.rubro === 'SERVICIOS' ? 129000 : preview.rubro === 'COMIDAS' ? 149000 : preview.rubro === 'WEBCAM' ? 390000 : 199000)} al mes, IVA incluido.</p>
                </div>
              </aside>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
