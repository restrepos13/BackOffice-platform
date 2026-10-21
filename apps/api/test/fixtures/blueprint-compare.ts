/** Convierte un plano crudo (formato IA) a lo que compara el medidor, con los mismos validadores del registro. */
import { normalizeBlueprint } from '../../src/common/blueprint';
import { detectProfile, fitToProfile } from '../../src/common/business-profile';
import { guessRubro } from '../../src/common/rubros';
import { ComparableBlueprint } from '../../src/common/blueprint-similarity';
import { normalizeProposal } from '../../src/modules/ai-setup.module';

export function toComparable(raw: any, answers: string[]): ComparableBlueprint {
  const owner = answers.join(' ');
  const proposal: any = normalizeProposal(raw);
  const bp: any = fitToProfile(normalizeBlueprint(raw, guessRubro(owner)), proposal, detectProfile(owner, answers[0]), owner);
  return {
    rubro: bp.rubro, businessType: bp.businessType, needs: bp.needs, modules: bp.modules, pipeline: bp.pipeline,
    clientData: bp.clientData, assistantFlow: bp.assistantFlow, quickReplies: bp.quickReplies,
    faqs: proposal.faqs ?? [], products: (proposal.products ?? []).map((p: any) => ({ name: p.name, price: p.price })),
    schedule: proposal.schedule, deliveryEnabled: proposal.delivery ? !!proposal.delivery.enabled : null,
    assistantWelcome: proposal.assistant?.welcome ?? '', companyName: String(raw?.empresa?.nombre ?? ''), city: String(raw?.empresa?.ciudad ?? ''),
  };
}
