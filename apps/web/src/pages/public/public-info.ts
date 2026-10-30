/**
 * Datos públicos de quien presta el servicio (portada y páginas legales).
 * BackOffice es un proyecto en desarrollo: todavía NO es una sociedad, así que
 * no tiene razón social, NIT ni registro mercantil. No agregar nada de eso
 * hasta que exista de verdad.
 */
export const RESPONSABLE = 'Santiago Restrepo'; // [CONFIRMAR] nombre completo de la persona responsable
export const CIUDAD = 'Medellín, Antioquia, Colombia';
export const EMAIL = 'restrepos591@gmail.com'; // aún no hay correo con el dominio propio
export const WA_NUMBER = '573108790168';
export const WA_TEXT = '+57 310 879 0168';
export const LEGAL_UPDATED = '30 de octubre de 2026';

export const waLink = (text?: string) => `https://wa.me/${WA_NUMBER}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
export const mailLink = (subject?: string) => `mailto:${EMAIL}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
