import {
  Body,
  Controller,
  Get,
  Global,
  Injectable,
  Module,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SkipThrottle } from '@nestjs/throttler';
import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { CurrentUser, Public } from '../auth/decorators';
import { AuthUser, isPlatformRole } from '../common/constants';

/**
 * Tiempo real del panel vía SSE (Server-Sent Events).
 * Eventos por organización: message.new, conversation.updated, typing.
 * Emisor en memoria: los workers de colas corren en el mismo proceso
 * (si algún día hay multi-instancia, esto migra a pub/sub de Redis).
 */
@Injectable()
export class EventsService {
  private emitter = new EventEmitter();
  private subscribers = 0;

  constructor() {
    this.emitter.setMaxListeners(500);
  }

  emit(companyId: string, event: { type: string; [k: string]: any }) {
    this.emitter.emit(`co:${companyId}`, { ...event, at: Date.now() });
  }

  subscribe(companyId: string, listener: (event: any) => void): () => void {
    const channel = `co:${companyId}`;
    this.emitter.on(channel, listener);
    this.subscribers++;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.subscribers--;
      this.emitter.off(channel, listener);
    };
  }

  /** Conexiones SSE vivas (para el panel de salud de Dev Tools). */
  subscriberCount(): number {
    return this.subscribers;
  }
}

@Controller('events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Stream SSE del panel. EventSource no permite headers → el JWT viaja por
   * query y se verifica manualmente con la misma firma/expiración del API.
   */
  @Public()
  @SkipThrottle()
  @Get('stream')
  async stream(
    @Query('token') token: string,
    @Query('companyId') companyId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    let user: AuthUser;
    try {
      const payload = await this.jwt.verifyAsync(token ?? '', {
        secret: process.env.JWT_SECRET,
      });
      user = {
        id: payload.sub, email: payload.email, name: payload.name,
        role: payload.role, companyId: payload.companyId ?? null,
      };
    } catch {
      res.status(401).end();
      return;
    }
    // Mínimo privilegio: el rol de área no escucha los eventos de la empresa
    if (user.role === 'COMPANY_AREA') {
      res.status(403).end();
      return;
    }
    // Aislamiento: un usuario de empresa solo escucha SU organización
    const scoped = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!scoped) {
      res.status(400).end();
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`event: hello\ndata: {"ok":true}\n\n`);

    const unsubscribe = this.events.subscribe(scoped, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }

  /** "Fulano está escribiendo…" — presencia efímera entre usuarios del equipo. */
  @Post('typing')
  typing(
    @CurrentUser() user: AuthUser,
    @Body() dto: { conversationId: string; companyId?: string },
  ) {
    const scoped = isPlatformRole(user.role) ? dto.companyId : user.companyId;
    if (!scoped || !dto.conversationId) return { ok: false };
    this.events.emit(scoped, {
      type: 'typing',
      conversationId: dto.conversationId,
      userName: user.name,
      userId: user.id,
    });
    return { ok: true };
  }
}

@Global()
@Module({
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
