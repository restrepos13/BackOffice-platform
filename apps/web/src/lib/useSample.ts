import { sample } from './business';
import { useActiveCompany } from './products';

/** Ejemplos de texto que suenan al negocio de la empresa activa. */
export function useSample() {
  const { company } = useActiveCompany();
  return (key: Parameters<typeof sample>[1]) => sample(company, key);
}
