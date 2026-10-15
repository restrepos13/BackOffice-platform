import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { parseJson } from '../../common/constants';
import { geocodeAddress } from '../../common/geo';
import { OrdersService } from '../../modules/orders.module';
import { AiSession, recordAiUsage } from '../ai-access';
import { AI_PROVIDER, AiProvider, ChatMessage, extractJson } from '../types';
import { buildAgentPrompt, validateAgentStep } from './protocol';
import { AGENT_TOOLS, AgentTool, ToolAccess, ToolContext, enabledTools } from './tools';

export interface AgentRunInput {
  conversation: any;
  company: any;
  contact: any;
  integration: any;
  bot: any;
  effective: {
    systemPrompt: string;
    personality: Record<string, string>;
    sales: Record<string, string>;
    welcomeMessage: string | null;
    model: string;
    temperature: number;
  };
  messages: any[];
  /** Llave(s) de la corrida: principal + respaldo en modo híbrido */
  session: AiSession;
  conversationId: string;
  now?: Date;
}

export interface AgentRunResult {
  reply: string[];
  state: string;
  escalate: boolean;
  reason?: string;
  draftOrderId?: string | null;
  confirmedOrderId?: string | null;
  toolTrace: Array<{ name: string; ok: boolean }>;
}

/** Pasos máximos (llamadas al modelo) por mensaje entrante. */
export const MAX_AGENT_STEPS = 6;

/**
 * Agente con herramientas: bucle modelo → herramientas → modelo hasta que
 * produce la respuesta final. Mismas garantías que el motor de pedidos:
 * salida validada, umbral de confianza y escalamiento con motivo registrado.
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger('Agent');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    @Optional() private readonly orders?: OrdersService,
  ) {}

  /** Herramientas que el bot puede EJECUTAR (las de escritura exigen permiso write). */
  private runnableTools(bot: any): Array<{ tool: AgentTool; granted: ToolAccess }> {
    const granted = enabledTools(bot.toolsJson);
    return AGENT_TOOLS
      .filter((tool) => granted.has(tool.name))
      .filter((tool) => tool.access === 'read' || granted.get(tool.name) === 'write')
      .map((tool) => ({ tool, granted: granted.get(tool.name)! }));
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { conversation, company, contact, bot, effective } = input;
    const now = input.now ?? new Date();
    const orderConfig = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const threshold = Number(orderConfig.aiConfidenceThreshold ?? 0.75);
    const tools = this.runnableTools(bot);
    const toolTrace: AgentRunResult['toolTrace'] = [];

    const ctx: ToolContext = {
      prisma: this.prisma,
      orders: this.orders,
      company,
      orderConfig,
      conversation,
      contact,
      now,
      geocode: geocodeAddress,
      state: { draftOrderId: null, confirmedOrderId: null },
    };

    const system = buildAgentPrompt({
      companyName: company.name,
      industry: company.industry,
      timezone: company.timezone || 'America/Bogota',
      now,
      systemPrompt: effective.systemPrompt,
      personality: effective.personality,
      sales: effective.sales,
      welcomeMessage: effective.welcomeMessage,
      knowledgeBase: Array.isArray(orderConfig.knowledgeBase) ? orderConfig.knowledgeBase : [],
      contactName: contact?.name,
      tools,
      deliveryEnabled: !!orderConfig.delivery?.enabled,
    });

    const history: ChatMessage[] = input.messages.slice(-24).map((m: any) => ({
      role: m.direction === 'IN' ? ('user' as const) : ('assistant' as const),
      content:
        (m.direction === 'IN' && m.transcription ? `[audio] ${m.transcription}` : m.content) +
        (m.author === 'AGENT' ? ' [respondió una persona del equipo]' : ''),
    }));
    const transcript: ChatMessage[] = [{ role: 'system', content: system }, ...history];

    const done = (partial: Omit<AgentRunResult, 'toolTrace' | 'draftOrderId' | 'confirmedOrderId'>): AgentRunResult => ({
      ...partial,
      draftOrderId: ctx.state.draftOrderId,
      confirmedOrderId: ctx.state.confirmedOrderId,
      toolTrace,
    });

    let invalidStreak = 0;
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      const { result: completion, billedTo } = await input.session.run((apiKey) =>
        this.ai.chat({
          apiKey,
          model: effective.model,
          temperature: Math.min(effective.temperature, 0.6),
          maxTokens: 900,
          messages: transcript,
          jsonMode: true,
        }),
      );
      await recordAiUsage(this.prisma, {
        companyId: company.id,
        integrationId: input.integration?.id ?? null,
        botId: bot.id,
        model: effective.model,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        billedTo,
        conversationId: input.conversationId,
      });

      const validated = validateAgentStep(extractJson(completion.content));
      if (!validated.ok) {
        invalidStreak++;
        this.logger.warn(`salida inválida del agente (paso ${step + 1}): ${validated.errors.join('; ')}`);
        if (invalidStreak >= 2) {
          return done({
            reply: ['Dame un momento, ya te confirmo con el equipo.'],
            state: 'escalado', escalate: true,
            reason: `El agente no devolvió el formato esperado: ${validated.errors.join('; ')}`,
          });
        }
        transcript.push({ role: 'assistant', content: completion.content.slice(0, 2000) });
        transcript.push({
          role: 'system',
          content: `Tu salida no cumplió el formato: ${validated.errors.join('; ')}. Devuelve SOLO un objeto JSON con "tool_calls" o con "reply" + "confidence".`,
        });
        continue;
      }
      invalidStreak = 0;
      const agentStep = validated.step;

      if (agentStep.kind === 'reply') {
        if (agentStep.confidence < threshold) {
          return done({
            reply: agentStep.reply, state: 'escalado', escalate: true,
            reason: `Confianza ${agentStep.confidence.toFixed(2)} por debajo del umbral ${threshold}`,
          });
        }
        return done({ reply: agentStep.reply, state: agentStep.state, escalate: false });
      }

      // Ejecución de herramientas (en orden; cada resultado vuelve al modelo)
      transcript.push({ role: 'assistant', content: JSON.stringify({ tool_calls: agentStep.calls }) });
      for (const call of agentStep.calls) {
        const entry = tools.find((t) => t.tool.name === call.name);
        let result: Record<string, any>;
        if (!entry) {
          const exists = AGENT_TOOLS.some((t) => t.name === call.name);
          result = {
            error: exists
              ? `No tienes permiso para usar ${call.name} en este negocio. Si el cliente lo necesita, pasar_a_humano.`
              : `La herramienta ${call.name} no existe. Usa solo las de la lista.`,
          };
        } else {
          try {
            result = await entry.tool.run(ctx, call.args);
          } catch (err: any) {
            this.logger.error(`herramienta ${call.name} falló [co=${company.id}]: ${err.message}`);
            result = { error: 'La consulta falló por un problema interno. Si es importante, pasar_a_humano.' };
          }
        }
        toolTrace.push({ name: call.name, ok: !result.error });
        if (result.escalar) {
          const message = typeof call.args?.mensaje_al_cliente === 'string' && call.args.mensaje_al_cliente.trim()
            ? call.args.mensaje_al_cliente.trim().slice(0, 400)
            : 'Dame un momento, ya te comunico con alguien del equipo.';
          return done({ reply: [message], state: 'escalado', escalate: true, reason: result.motivo });
        }
        transcript.push({
          role: 'user',
          content: `[RESULTADO ${call.name}] ${JSON.stringify(result).slice(0, 5000)}`,
        });
      }
    }

    return done({
      reply: ['Dame un momento, ya reviso con el equipo y te confirmo.'],
      state: 'escalado', escalate: true,
      reason: `El agente no resolvió en ${MAX_AGENT_STEPS} pasos`,
    });
  }
}
