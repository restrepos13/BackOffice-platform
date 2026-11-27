import { clsx } from 'clsx';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Lock, RotateCcw } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, postWithRetry } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtMoney } from '../../lib/format';
import { fbpCookie, pixelEvent } from '../../lib/meta-pixel';
import type { SetupProfile } from '../../lib/setup';
import type { AuthUser } from '../../lib/types';
import { Button, Field, Input, Loading } from '../../components/ui';
import {
  ACCOUNT_FIELDS, type AccountForm, type FieldErrors, type Preview, adoptSession, clearDraft, emailSuggestion, formatPhone, funnel,
  loadDraft, passwordStrength, referralCode, saveDraft, sendContact, sessionToken, takeEarlyContact, track, validateAll, validateField,
} from './signup-helpers';
import ContactStep, { type ContactValues } from './signup/ContactStep';
import QuestionsStep from './signup/QuestionsStep';
import QuickContact from './signup/QuickContact';
import { QUESTION_COUNT, categoryOf, questionsFor, toMessages, type Answers } from './signup/questions';
import { Notice, StepActions, StepTitle, Stepper, type StepNumber } from './signup/parts';

// Los pasos 2 a 4 se descargan cuando hacen falta: la pantalla de entrada carga liviana
const ProposalStep = lazy(() => import('./signup/ProposalStep'));
const ProductsStep = lazy(() => import('./signup/ProductsStep'));
const ReviewSummary = lazy(() => import('./signup/ReviewSummary'));

/**
 * Registro autoservicio:
 *  0. Contacto primero (una sola pantalla con la entrada): nombre del negocio y
 *     WhatsApp. Sin IA y sin esperar al servidor. Desde aquí queda «Por contactar».
 *  1. Cinco preguntas fijas que se responden tocando, con barra de avance y un
 *     adelanto después de la 2. Sin IA.
 *  2. Propuesta: UNA llamada de IA con las respuestas.
 *  3. Productos.  4. Revisión y cuenta.
 * El avance se guarda en el navegador (sin la contraseña) y en el servidor
 * (para retomar desde el correo). Cada pantalla deja un evento del embudo.
 */

const DRAFT_VERSION = 4;
const EMPTY_FORM: AccountForm = { companyName: '', city: '', name: '', email: '', phone: '', password: '', accept: false };

function messageOf(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Primera pregunta sin responder (para retomar). */
function firstOpen(answers: Answers): number {
  const qs = questionsFor(categoryOf(answers.tipo));
  const i = qs.findIndex((q) => !answers[q.id]);
  return i === -1 ? QUESTION_COUNT - 1 : i;
}

export default function Signup() {
  const { user, loading, adopt } = useAuth();
  const navigate = useNavigate();
  const saved = useMemo(() => loadDraft(), []);
  const early = useMemo(() => takeEarlyContact(), []);
  const savedV4 = saved && (saved.v ?? 0) >= 4 ? saved : null;
  // Se ofrece retomar si había avance de verdad (una pregunta respondida o una propuesta)
  const [resumeOffer, setResumeOffer] = useState(() => !early && !!saved && (saved.step > 1 || (!!savedV4?.contactDone && Object.keys(savedV4.answers ?? {}).length > 0)));
  const [contactDone, setContactDone] = useState(() => !early && !!savedV4?.contactDone);
  const [step, setStep] = useState<StepNumber>(1);
  const [answers, setAnswers] = useState<Answers>({});
  const [link, setLink] = useState('');
  const [qIndex, setQIndex] = useState(0);
  const [showValue, setShowValue] = useState(false);
  const [building, setBuilding] = useState(false);
  const [waking, setWaking] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [productError, setProductError] = useState<string | null>(null);
  const [form, setForm] = useState<AccountForm>(() => {
    if (early) return { ...EMPTY_FORM, companyName: early.companyName, phone: early.phone, email: early.email };
    // Un borrador viejo (entrevista libre) no se retoma, pero su contacto sí se aprovecha
    return saved && !resumeOffer ? { ...EMPTY_FORM, ...saved.form, password: '' } : EMPTY_FORM;
  });
  const [touched, setTouched] = useState<Partial<Record<keyof AccountForm, boolean>>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const fieldRefs = useRef<Partial<Record<keyof AccountForm, HTMLElement | null>>>({});
  const previewRef = useRef<Preview | null>(null);
  previewRef.current = preview;
  const firstRender = useRef(true);

  const questions = questionsFor(categoryOf(answers.tipo));
  const question = questions[Math.min(qIndex, QUESTION_COUNT - 1)];

  useEffect(() => {
    document.title = 'Crea tu empresa · BackOffice';
    (window as unknown as { __signupReact?: boolean }).__signupReact = true; // early.js deja de atender el formulario
    // En el celular el teclado achica la página (no la tapa): «Continuar» queda a la vista.
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const prevViewport = viewport?.content;
    if (viewport && prevViewport && !prevViewport.includes('interactive-widget')) viewport.content = `${prevViewport}, interactive-widget=resizes-content`;
    track('view', { step: 'STARTED' });
    funnel('registro_abierto'); // early.js ya lo mandó si llegó directo; el servidor cuenta uno
    if (!contactDone) funnel('presentacion_vista');
    referralCode(); // guarda el ?ref= antes de que la URL cambie
    void resumeFromEmail();
    // El botón Atrás del navegador cambia de paso en vez de salir del registro
    window.history.replaceState({ ...(window.history.state ?? {}), signupStep: 1 }, '');
    const onPop = (e: PopStateEvent) => {
      const n = Number(e.state?.signupStep) as StepNumber;
      if (n >= 1 && n <= 4) setStep(n > 1 && !previewRef.current ? 1 : n);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      if (viewport && prevViewport !== undefined) viewport.content = prevViewport;
      window.removeEventListener('popstate', onPop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Se guarda el avance (nunca la contraseña)
  useEffect(() => {
    if (resumeOffer || !contactDone) return;
    const { password: _p, ...safeForm } = form;
    saveDraft({ v: DRAFT_VERSION, step, contactDone, qIndex, showValue, answers, link, preview, form: safeForm });
  }, [step, contactDone, qIndex, showValue, answers, link, preview, form, resumeOffer]);

  // «Vio la pregunta N» (una vez por pregunta en el servidor)
  useEffect(() => {
    if (!contactDone || resumeOffer || step !== 1 || showValue || building) return;
    funnel('pregunta_vista', { questionNo: question.n, questionId: question.id });
  }, [contactDone, resumeOffer, step, showValue, building, question.n, question.id]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (step > 1) track('view', { step: step === 4 ? 'ACCOUNT' : 'PREVIEW' });
    if (step === 2) funnel('plan_revisado');
    if (step === 4) funnel('datos_llenados');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // El foco va al título del paso (teclado y lectores de pantalla)
    setTimeout(() => document.getElementById('step-title')?.focus({ preventScroll: true }), 60);
  }, [step]);

  if (!loading && user) return <Navigate to="/" replace />;

  const setup = preview?.setup ?? null;
  const setSetup = (next: SetupProfile) => setPreview((prev) => (prev ? { ...prev, setup: next } : prev));

  function goTo(n: StepNumber) {
    if (n === step) return;
    setStep(n);
    window.history.pushState({ ...(window.history.state ?? {}), signupStep: n }, '');
  }
  const reachable = (n: StepNumber) => n === 1 || (!!preview && !building);

  /** ?retomar=… del correo «Te quedaste en la pregunta X»: sigue exactamente donde iba. */
  async function resumeFromEmail() {
    const t = new URLSearchParams(window.location.search).get('retomar');
    if (!t) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('retomar');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
    try {
      const r = await postWithRetry<{ session: string; answers: Answers; link: string | null; contact: { companyName: string; phone: string; email: string } }>(
        '/public/signup/resume', { t }, { tries: 3, onRetry: () => setWaking(true) },
      );
      adoptSession(r.session);
      setForm((f) => ({ ...f, companyName: r.contact.companyName || f.companyName, phone: formatPhone(r.contact.phone || f.phone), email: r.contact.email || f.email }));
      setAnswers(r.answers ?? {});
      setLink(r.link ?? '');
      setQIndex(firstOpen(r.answers ?? {}));
      setShowValue(false);
      setContactDone(true);
      setResumeOffer(false);
      setStep(1);
      toast.success('¡Bienvenido de vuelta! Sigues donde ibas.');
    } catch (e) {
      toast.error(messageOf(e, 'No pudimos abrir tu registro. Empieza de nuevo: tus datos ya los tenemos.'));
    } finally {
      setWaking(false);
    }
  }

  function resume() {
    if (!saved) return;
    setPreview(saved.preview);
    setForm({ ...EMPTY_FORM, ...saved.form, password: '' });
    setContactDone(true);
    if (savedV4) {
      setAnswers((savedV4.answers ?? {}) as Answers);
      setLink(savedV4.link ?? '');
      setQIndex(Math.min(QUESTION_COUNT - 1, savedV4.qIndex ?? firstOpen((savedV4.answers ?? {}) as Answers)));
      setShowValue(!!savedV4.showValue);
    }
    // Borradores de antes (3 pasos): su paso 3 era «Tus datos», que ahora es el 4
    const savedStep = (saved.v ?? 2) < 3 && saved.step === 3 ? 4 : saved.step;
    const n = (saved.preview ? savedStep : 1) as StepNumber;
    setStep(n);
    window.history.replaceState({ ...(window.history.state ?? {}), signupStep: n }, '');
    setResumeOffer(false);
  }

  function restart() {
    clearDraft();
    setAnswers({});
    setLink('');
    setQIndex(0);
    setShowValue(false);
    setPreview(null);
    setBuildError(null);
    // Empezar de nuevo no vuelve a pedir el contacto
    const kept = { ...EMPTY_FORM, companyName: form.companyName || saved?.form.companyName || '', phone: form.phone || saved?.form.phone || '', email: form.email || saved?.form.email || '', name: form.name || saved?.form.name || '' };
    setForm(kept);
    setContactDone(!validateField('companyName', kept) && !validateField('phone', kept));
    setStep(1);
    setResumeOffer(false);
    track('view', { step: 'STARTED' });
  }

  /* ── Paso 0: contacto ── */

  function submitContact(c: ContactValues) {
    setForm((f) => ({ ...f, companyName: c.companyName, phone: c.phone, email: c.email || f.email }));
    setContactDone(true);
    setQIndex(0);
    void sendContact({ companyName: c.companyName, phone: c.phone, ...(c.email ? { email: c.email } : {}) });
    pixelEvent('Lead', `lead-${sessionToken()}`);
    window.scrollTo({ top: 0 });
  }

  /* ── Las 5 preguntas ── */

  function answer(value: string) {
    const q = question;
    let next: Answers = { ...answers, [q.id]: value };
    // Cambió el tipo de negocio: las opciones de 3 y 4 ya no aplican
    if (q.id === 'tipo' && categoryOf(value) !== categoryOf(answers.tipo)) {
      next = { tipo: value, ...(answers.oferta ? { oferta: answers.oferta } : {}) };
    }
    setAnswers(next);
    funnel('pregunta_respondida', { questionNo: q.n, questionId: q.id, progress: next as Record<string, string>, ...(link ? { link } : {}) });
    if (q.n === 2) {
      // El adelanto se muestra «antes» de la pregunta 3
      setQIndex(2);
      setShowValue(true);
      funnel('adelanto_visto');
    } else if (q.n >= QUESTION_COUNT) {
      void build(next);
    } else {
      setQIndex(q.n);
    }
  }

  function back() {
    if (showValue) {
      setShowValue(false);
      setQIndex(1);
    } else if (qIndex > 0) {
      setQIndex(qIndex - 1);
    }
  }

  async function build(current = answers) {
    setBuilding(true);
    setBuildError(null);
    try {
      const r = await postWithRetry<Preview>(
        '/public/signup/preview',
        { session: sessionToken(), messages: toMessages(form.companyName, current, link), ...(link ? { link } : {}) },
        { onRetry: () => setWaking(true) },
      );
      setPreview(r);
      setForm((f) => ({ ...f, companyName: f.companyName || r.company.name, city: f.city || r.company.city }));
      setStep(2);
      window.history.pushState({ ...(window.history.state ?? {}), signupStep: 2 }, '');
    } catch (e) {
      const msg = messageOf(e, 'No pudimos armar tu propuesta.');
      setBuildError(msg);
      track('error', { step: 'PREVIEW', message: msg });
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
    const session = sessionToken();
    try {
      const res = await postWithRetry<{ token: string; user: AuthUser }>(
        '/public/signup',
        {
          session,
          messages: toMessages(form.companyName, answers, link),
          rubro: preview.rubro,
          proposal: preview.proposal,
          blueprint: preview.blueprint,
          setup: preview.setup,
          company: { name: form.companyName, city: form.city },
          admin: { name: form.name, email: form.email.trim(), phone: form.phone, password: form.password },
          acceptTerms: form.accept,
          referralCode: referralCode(),
          fbp: fbpCookie(),
        },
        { tries: 2, onRetry: () => setWaking(true) },
      );
      pixelEvent('CompleteRegistration', `reg-${session}`);
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
  const onContact = step === 1 && !resumeOffer && !contactDone;

  return (
    <div className="min-h-screen bg-bone text-ink">
      <header className="border-b-2 border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 md:px-6 md:py-4">
          <Link to="/" className="display text-2xl leading-none">
            BackOffice<span className="text-ok">.</span>
          </Link>
          <p className="text-sm text-ink-2">
            ¿Ya tienes cuenta? <Link to="/login" className="font-semibold text-ink underline-offset-2 hover:underline">Entrar</Link>
          </p>
        </div>
      </header>

      <main className={clsx('mx-auto max-w-6xl px-4 pb-24 md:px-6', onContact ? 'pt-5 sm:pt-10' : 'pt-6 sm:pt-8')}>
        {!resumeOffer && step > 1 && <Stepper step={step} reachable={reachable} onGo={goTo} />}

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

        {onContact && (
          <ContactStep
            initial={{ companyName: form.companyName, phone: form.phone, email: form.email }}
            autoSubmit={!!early?.submitted}
            onSubmit={submitContact}
            onSeen={() => funnel('formulario_visto')}
            onTyping={() => funnel('formulario_empezado')}
            onAttempt={() => funnel('contacto_enviado')}
          />
        )}

        {step === 1 && !resumeOffer && contactDone && (
          <QuestionsStep
            question={question}
            answers={answers}
            link={link}
            onLink={setLink}
            onAnswer={answer}
            onBack={back}
            showValue={showValue}
            onContinueValue={() => { setShowValue(false); setQIndex(2); }}
            building={building}
            buildError={buildError}
            onRetryBuild={() => void build()}
            phone={form.phone}
          />
        )}

        <Suspense fallback={<Loading />}>
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
              onCorrectAnswers={() => { setQIndex(0); setShowValue(false); goTo(1); }}
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
                        y autorizo el tratamiento de mis datos según la{' '}
                        <Link to="/privacidad" target="_blank" className="font-semibold underline" onClick={(e) => e.stopPropagation()}>política de tratamiento de datos personales</Link>{' '}
                        (Ley 1581 de 2012).
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
                  <QuickContact compact phone={form.phone} />
                </aside>
              </div>
            </div>
          )}
        </Suspense>

        {step === 1 && !resumeOffer && contactDone && Object.keys(answers).length > 0 && !building && (
          <p className="mx-auto mt-4 max-w-xl text-right">
            <button type="button" onClick={restart} className="cursor-pointer text-xs text-ink-3 underline hover:text-ink">Empezar de nuevo</button>
          </p>
        )}
      </main>
    </div>
  );
}

