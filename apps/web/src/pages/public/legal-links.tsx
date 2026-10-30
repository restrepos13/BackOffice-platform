import { Link } from 'react-router-dom';

/** Páginas públicas legales (Meta, Google y TikTok las piden para revisar las apps). */
export const LEGAL_LINKS = [
  { to: '/privacidad', label: 'Privacidad' },
  { to: '/terminos', label: 'Términos' },
  { to: '/eliminacion-de-datos', label: 'Eliminación de datos' },
  { to: '/contacto', label: 'Contacto' },
];

/** Enlaces legales para el pie de la portada, el login y las páginas legales. */
export function LegalFooterLinks({ className = '' }: { className?: string }) {
  return (
    <nav aria-label="Información legal" className={`flex flex-wrap gap-x-4 gap-y-1 ${className}`}>
      {LEGAL_LINKS.map((l) => (
        <Link key={l.to} to={l.to} className="hover:underline">{l.label}</Link>
      ))}
    </nav>
  );
}
