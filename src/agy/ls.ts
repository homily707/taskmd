import type { SessionStatus } from '../ui/port.js';

export interface AgyConversation {
  id?: string;
  metadata?: {
    createTime?: string;
    projectId?: string;
    environmentId?: string;
    parentConversationId?: string;
    rootConversationId?: string;
    tags?: string[];
  };
  annotations?: {
    title?: string;
    tags?: string[];
    archived?: boolean;
    pinned?: boolean;
    starred?: boolean;
    conversationGroupId?: string;
  };
  state?: {
    summary?: string;
    runState?: string;
    updateTime?: string;
  };
}

export interface ConversationServiceClient {
  listConversations(options?: { includeArchived?: boolean; pageSize?: number; projectId?: string }): Promise<SessionStatus[]>;
  getConversation(conversationId: string): Promise<SessionStatus | undefined>;
  createConversation(options: { projectId?: string; title?: string; prompt?: string; model?: string }): Promise<{ sessionId: string }>;
}

export function mapConversationToStatus(conv: AgyConversation): SessionStatus | undefined {
  const id = typeof conv.id === 'string' ? conv.id.trim() : '';
  if (!id) return undefined;
  const runState = conv.state?.runState ?? '';
  const running = runState === 'RUN_STATE_RUNNING' || runState === 'RUN_STATE_CANCELLING';
  const title = conv.annotations?.title?.trim() || conv.state?.summary?.trim() || undefined;
  const updatedAtRaw = conv.state?.updateTime || conv.metadata?.createTime;
  const updatedAt = updatedAtRaw ? Date.parse(updatedAtRaw) : NaN;
  return {
    sessionId: id,
    running,
    archived: Boolean(conv.annotations?.archived),
    child: Boolean(conv.metadata?.parentConversationId),
    ...(title ? { title } : {}),
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
  };
}

export function createConversationServiceClient(options?: {
  lsAddress?: string;
  csrfToken?: string;
  fetchImpl?: typeof fetch;
}): ConversationServiceClient {
  const lsAddress = options?.lsAddress ?? process.env.ANTIGRAVITY_LS_ADDRESS ?? '';
  const csrfToken = options?.csrfToken ?? process.env.ANTIGRAVITY_CSRF_TOKEN ?? '';
  const fetchImpl = options?.fetchImpl ?? fetch;

  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    if (!lsAddress || !csrfToken) {
      throw new Error('Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN.');
    }
    const base = lsAddress.startsWith('http://') || lsAddress.startsWith('https://')
      ? lsAddress
      : `http://${lsAddress}`;
    const response = await fetchImpl(`${base}/product.v1.ConversationService/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-antigravity-csrf-token': csrfToken,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`ConversationService/${method} failed (${response.status}): ${detail || response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  return {
    async listConversations(opts = {}) {
      const body: Record<string, unknown> = {
        pageSize: opts.pageSize ?? 100,
        includeArchived: opts.includeArchived ?? true,
      };
      if (opts.projectId) body.projectId = opts.projectId;
      const result = await call<{ conversations?: AgyConversation[] }>('ListConversations', body);
      const statuses: SessionStatus[] = [];
      for (const conv of result.conversations ?? []) {
        const mapped = mapConversationToStatus(conv);
        if (mapped) statuses.push(mapped);
      }
      return statuses;
    },

    async getConversation(conversationId: string) {
      const result = await call<AgyConversation | { conversation?: AgyConversation }>('GetConversation', { conversationId });
      const conv = 'conversation' in result && result.conversation ? result.conversation : (result as AgyConversation);
      return mapConversationToStatus(conv);
    },

    async createConversation(opts) {
      const body: Record<string, unknown> = {};
      if (opts.projectId) body.projectId = opts.projectId;
      if (opts.title) body.title = opts.title;
      if (opts.model) body.model = opts.model;
      if (opts.prompt) body.prompt = [{ text: opts.prompt }];
      const result = await call<{ conversation?: AgyConversation }>('CreateConversation', body);
      const id = result.conversation?.id;
      if (!id) throw new Error('CreateConversation did not return a conversation ID.');
      return { sessionId: id };
    },
  };
}
