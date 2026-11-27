import { beforeEach, describe, expect, it } from 'vitest';
import { captureOrigin, externalReferrer } from './origin';

/** Fuente de la visita: utm, ?g= de grupos por ciudad, fbclid y referrer, conservados al navegar. */

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('Captura de la fuente', () => {
  it('guarda utm, g (grupos por ciudad) y fbclid al llegar', () => {
    const o = captureOrigin('?utm_source=meta&utm_medium=paid_social&utm_campaign=registro&utm_content=reel&utm_id=52637929268760&fbclid=IwAR0abc123&g=Manizales', '/');
    expect(o).toEqual({
      utmSource: 'meta', utmMedium: 'paid_social', utmCampaign: 'registro', utmContent: 'reel', utmId: '52637929268760',
      fbclid: 'IwAR0abc123', g: 'manizales', landingPath: '/?utm_source=meta&utm_medium=paid_social&utm_campaign=registro&utm_content=reel&utm_id=52637929268760&fbclid=IwAR0abc123&g=Manizales',
    });
  });

  it('se conserva aunque navegue por la web antes de registrarse (otra pestaña incluida)', () => {
    captureOrigin('?g=pereira', '/automatizacion-de-whatsapp', 'https://m.facebook.com/groups/123');
    sessionStorage.clear(); // otra pestaña
    expect(captureOrigin('', '/registro', 'https://www.backoffice.store/automatizacion-de-whatsapp')).toMatchObject({ g: 'pereira', referrer: 'https://m.facebook.com/groups/123' });
  });

  it('un clic nuevo de campaña reemplaza al anterior; navegar sin parámetros no', () => {
    captureOrigin('?utm_source=meta&utm_campaign=vieja', '/registro');
    expect(captureOrigin('', '/precios')).toMatchObject({ utmCampaign: 'vieja' });
    expect(captureOrigin('?utm_source=meta&utm_campaign=nueva', '/registro')).toMatchObject({ utmCampaign: 'nueva' });
  });

  it('sin campaña: Google cuenta como fuente; la propia web no', () => {
    expect(captureOrigin('', '/registro', 'https://www.backoffice.store/')).toEqual({});
    expect(captureOrigin('', '/', 'https://www.google.com/')).toEqual({ referrer: 'https://www.google.com/', landingPath: '/' });
    expect(externalReferrer('http://localhost:5173/x')).toBeUndefined();
    expect(externalReferrer('no es una url')).toBeUndefined();
  });

  it('descarta valores dinámicos sin reemplazar de Meta y grupos inválidos', () => {
    expect(captureOrigin('?utm_id={{campaign.id}}&utm_campaign=x&g=<script>', '/registro')).toEqual({ utmCampaign: 'x', landingPath: '/registro?utm_id={{campaign.id}}&utm_campaign=x&g=<script>' });
  });

  it('vence a los 30 días', () => {
    captureOrigin('?g=cali', '/', '', Date.now() - 31 * 86400e3);
    expect(captureOrigin('', '/registro')).toEqual({});
  });
});
