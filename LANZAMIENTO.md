# Checklist de salida a producción — módulo de pedidos (Nexus y siguientes)

Lista de verificación previa a conectar el número REAL de WhatsApp de una
empresa. Nada de esto es opcional: se marca TODO antes de quitar el sandbox.

## 1. Credenciales y secretos

- [ ] Llave DeepInfra de la empresa cargada (Configuración → Llave DeepInfra) y probada con `POST /engine/simulate`.
- [ ] Cuenta Twilio DE LA EMPRESA: `accountSid` + `authToken` cargados desde el panel de la línea (el token queda cifrado como `authTokenEnc`; verificar que `GET /integrations` devuelva solo `twilioConfigured: true`).
- [ ] `fromNumber` de la línea = número de WhatsApp aprobado por Meta.
- [ ] `MASTER_ENCRYPTION_KEY` definida en `.env` del servidor (NO la de desarrollo) y respaldada en un lugar seguro — sin ella no se descifra ninguna credencial.
- [ ] `JWT_SECRET` fuerte en `.env` (no efímero).
- [ ] Rotar la contraseña de MongoDB Atlas y restringir IPs de acceso.
- [ ] `git log -p | grep -i` de llaves/tokens: el repositorio NO contiene secretos.

## 2. Twilio / Meta

- [ ] `WEBHOOK_BASE_URL` (Dev Tools → Settings) apuntando al dominio público HTTPS definitivo.
- [ ] Webhook de Twilio configurado a `POST <base>/api/webhooks/<slug>/twilio` y status callback a `/twilio/status`.
- [ ] Firma X-Twilio-Signature VALIDANDO (probar un POST sin firma → 403; en sandbox no valida, en producción sí).
- [ ] Plantillas de Meta aprobadas y cargadas en la organización (`waTemplatesJson`: key + contentSid) para: `recordatorio_cliente`, `feedback_cliente` y cualquier envío fuera de la ventana de 24 h.
- [ ] Tarifas Meta por categoría revisadas (`orderConfig.metaRatesUsd`) para que el panel de consumo declare costos correctos.

## 3. Configuración de la organización

- [ ] Agenda real: días, horarios, corte, anticipación mínima, franjas, capacidad y festivos del año (Pedidos → Configuración → Agenda).
- [ ] Catálogo completo con áreas asignadas; reglas de distribución cubren todos los productos (el reporte diario alerta ítems sin área).
- [ ] Áreas con responsables y canal de aviso reales (los WHATSAPP proactivos exigen plantilla aprobada).
- [ ] Base de conocimiento (FAQs) cargada: pagos, cobertura, políticas.
- [ ] Plantillas de recordatorio revisadas con el cliente.
- [ ] Reporte diario configurado (hora local + canal + correo de gerencia).
- [ ] `feedbackDelayHours` acordado con el cliente.
- [ ] Bot ACTIVO (no DRAFT) con personalidad validada en el simulador.

## 4. Cuentas y roles

- [ ] Usuarios reales creados con contraseñas fuertes; `COMPANY_AREA` con su `productionAreaId` correcto.
- [ ] Verificado en vivo: el usuario de área SOLO ve su vista (login → redirige a /app/area, resto 403).
- [ ] Cuentas de prueba/demo desactivadas para ese tenant.

## 5. Pruebas (todas en verde ANTES de quitar el sandbox)

- [ ] Suite Jest completa: `pnpm --filter @backoffice/api test`.
- [ ] E2E de seguridad contra el API vivo: `node apps/api/test/e2e-security.mjs` (multi-tenant, secretos, área, SSE, rate limit).
- [ ] Prueba de carga: `node apps/api/test/load-test.mjs` sin errores 5xx.
- [ ] Semana de prueba EN SANDBOX con pedidos reales del cliente: flujo completo mensaje → pedido → confirmación → recordatorios → entrega → feedback, verificado desde el panel (el sandbox jamás envía mensajes reales).

## 6. Operación

- [ ] Redis con `brew services` (o systemd) en arranque automático; colas wa-inbound/wa-outbound/engine arriba en los logs.
- [ ] Proceso del API supervisado (launchd/pm2) con reinicio automático; `uploads/` y Atlas con respaldo.
- [ ] Monitoreo: `GET /reports/ops-health` en verde; revisar diario los primeros días (recordatorios fallidos, mensajes FAILED, escalamientos anormales).
- [ ] SMTP real cargado en Dev Tools (los correos QUEUED salen con reenvío).
- [ ] Zona horaria de la empresa correcta (los cortes y recordatorios dependen de ella).

## 7. El interruptor final

- [ ] Con TODO lo anterior en verde: quitar `sandbox: true` del config de la línea desde el panel.
- [ ] Enviar un mensaje de prueba real desde un teléfono del equipo y verificar: respuesta de la IA, ticks de entrega, costo Meta registrado.
- [ ] Primer pedido real acompañado de una persona mirando la bandeja (modo humano listo por si acaso).
