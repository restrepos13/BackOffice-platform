import { ArrowRight, Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Field, Input } from '../../../components/ui';
import { formatPhone, validateField, type AccountForm } from '../signup-helpers';
import { Panel, StepTitle } from './parts';

/**
 * Antes de la entrevista: nombre y WhatsApp. Es lo único que se pide de entrada,
 * para poder ayudar a quien se queda a mitad (casi todos llegan desde el
 * celular, por un anuncio, y se distraen). El resto de la cuenta va al final.
 */
export default function ContactStep({ name, phone, onSubmit }: { name: string; phone: string; onSubmit: (v: { name: string; phone: string }) => void }) {
  const [form, setForm] = useState({ name, phone });
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const check = (f: 'name' | 'phone', v = form) => validateField(f, { ...v } as unknown as AccountForm);

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = { name: check('name'), phone: check('phone') };
    setErrors(next);
    if (next.name || next.phone) {
      document.getElementById(next.name ? 'contact-name' : 'contact-phone')?.focus();
      return;
    }
    onSubmit({ name: form.name.trim(), phone: form.phone });
  }

  const set = (f: 'name' | 'phone', value: string) => {
    const v = { ...form, [f]: value };
    setForm(v);
    if (errors[f]) setErrors((x) => ({ ...x, [f]: check(f, v) }));
  };

  return (
    <div className="mx-auto max-w-xl">
      <StepTitle kicker="Paso 1 · Empecemos" title="¿Con quién hablamos?">
        Te hacemos unas preguntas cortas y armamos tu asistente de WhatsApp. Toma unos 2 minutos.
      </StepTitle>
      <Panel className="p-5 sm:p-6">
        <form noValidate onSubmit={submit} className="space-y-4" aria-label="Tus datos de contacto">
          <Field label="Tu nombre" required error={errors.name}>
            <Input
              id="contact-name"
              autoComplete="name"
              autoCapitalize="words"
              enterKeyHint="next"
              maxLength={80}
              value={form.name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(e) => set('name', e.target.value)}
              onBlur={() => form.name && setErrors((x) => ({ ...x, name: check('name') }))}
            />
          </Field>
          <Field label="Tu WhatsApp" required error={errors.phone} hint="Si te quedas a mitad, te escribimos para ayudarte">
            <Input
              id="contact-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              enterKeyHint="go"
              placeholder="300 123 4567"
              value={form.phone}
              aria-invalid={errors.phone ? true : undefined}
              onChange={(e) => set('phone', formatPhone(e.target.value))}
              onBlur={() => form.phone && setErrors((x) => ({ ...x, phone: check('phone') }))}
            />
          </Field>
          <Button type="submit" className="w-full !py-3 text-base">
            Empezar <ArrowRight size={16} />
          </Button>
          <p className="flex items-start gap-2 text-xs text-ink-3">
            <Lock size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              Sin tarjeta. Usamos tu número solo para ayudarte con tu cuenta, según la{' '}
              <Link to="/privacidad" target="_blank" className="font-semibold underline">política de tratamiento de datos</Link> (Ley 1581 de 2012).
            </span>
          </p>
        </form>
      </Panel>
    </div>
  );
}
