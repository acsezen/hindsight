import { z } from "zod";
import type {
  ConsentUpdate,
  LibreChatHindsightConfig,
  LibreChatMemory,
  LibreChatUser,
} from "./librechat.js";

/** The request fields LibreChat's auth and config middleware provide. */
export interface ConsentRequest {
  user?: LibreChatUser & { tenantId?: unknown };
  config?: { config?: { hindsight?: LibreChatHindsightConfig } };
  params: { conversationId?: string };
  body?: unknown;
}

export interface ConsentResponse {
  status(code: number): ConsentResponse;
  json(body: unknown): unknown;
}

const updateBody = z.object({ enabled: z.boolean() }).strict();
const conversationId = z.string().min(1).max(256);

const failureStatus: Record<Extract<ConsentUpdate, { ok: false }>["code"], number> = {
  hindsight_unavailable: 403,
  conversation_not_found: 404,
  conversation_unsupported: 409,
  generation_active: 409,
  consent_conflict: 409,
};

/**
 * Express-compatible handlers for the per-conversation toggle. Responses carry
 * stable codes only; store failures never expose driver errors.
 */
export function consentHandlers(memory: LibreChatMemory) {
  const config = (request: ConsentRequest) => request.config?.config?.hindsight;
  return {
    availability(request: ConsentRequest, response: ConsentResponse): void {
      response.status(200).json({ available: memory.available(config(request), request.user) });
    },

    async read(request: ConsentRequest, response: ConsentResponse): Promise<void> {
      const id = conversationId.safeParse(request.params.conversationId);
      if (!id.success) {
        response.status(404).json({ code: "conversation_not_found" });
        return;
      }
      try {
        response.status(200).json(await memory.readConsent(config(request), request.user, id.data));
      } catch {
        response.status(503).json({ code: "consent_store_unavailable" });
      }
    },

    async update(request: ConsentRequest, response: ConsentResponse): Promise<void> {
      const id = conversationId.safeParse(request.params.conversationId);
      const body = updateBody.safeParse(request.body);
      if (!id.success || !body.success) {
        response.status(400).json({ code: "invalid_consent_request" });
        return;
      }
      try {
        const result = await memory.updateConsent(
          config(request),
          request.user,
          id.data,
          body.data.enabled
        );
        if (result.ok) {
          response.status(200).json({ enabled: result.enabled });
        } else {
          response.status(failureStatus[result.code]).json({ code: result.code });
        }
      } catch {
        response.status(503).json({ code: "consent_store_unavailable" });
      }
    },
  };
}
