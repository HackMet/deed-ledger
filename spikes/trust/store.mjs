// In-memory draft store for E6/E8 trust scenarios (Lane C, day-one spike).
// Deterministic: no model calls, no I/O. Mirrors the non-negotiables that the
// later D1 implementation must enforce: store scoping on every call, revision
// match on confirm, operation-key uniqueness, provider message-ID dedupe.
export class TrustError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class DraftStore {
  constructor() {
    this.drafts = new Map(); // draft_id -> draft record
    this.operationKeys = new Map(); // operation_key -> { draft_id, revision }
    this.messages = new Map(); // message_id -> { store, draft_id }
    this.contentRefs = new Map(); // `${store}:${ref}` -> first draft_id
    this.warnings = []; // reviewable warnings (e.g. duplicate content)
    this.commits = 0;
  }

  static #requireStore(store) {
    if (typeof store !== "string" || store.length === 0) {
      return { ok: false, reason: "missing_store", message: "Store context is required." };
    }
    return null;
  }

  #getScoped(draftId, store) {
    const draft = this.drafts.get(draftId);
    if (!draft || draft.store !== store) {
      return { ok: false, reason: "wrong_store", message: "Draft not found in this store." };
    }
    return { ok: true, draft };
  }

  create_draft({ draft_id, store, kind }) {
    const missing = DraftStore.#requireStore(store);
    if (missing) return missing;
    if (this.drafts.has(draft_id)) {
      return { ok: false, reason: "duplicate_draft", message: "Draft already exists." };
    }
    const draft = {
      draft_id,
      store,
      kind: kind ?? null,
      state: "open",
      revision: 1,
      committed_revision: null,
      corrections: [],
      notes: [],
      duplicate_of: null,
    };
    this.drafts.set(draft_id, draft);
    return { ok: true, draft_id, revision: 1 };
  }

  confirm({ draft_id, revision, store, operation_key }) {
    const missing = DraftStore.#requireStore(store);
    if (missing) return missing;
    const scoped = this.#getScoped(draft_id, store);
    if (!scoped.ok) return scoped;
    const draft = scoped.draft;
    if (this.operationKeys.has(operation_key)) {
      return { ok: false, reason: "duplicate_operation", message: "Already recorded; ignoring repeat." };
    }
    if (draft.state === "committed") {
      return { ok: false, reason: "already_committed", message: "Already recorded; ignoring repeat." };
    }
    if (draft.state !== "open") {
      return { ok: false, reason: "not_open", message: "Draft is not open for approval." };
    }
    if (revision !== draft.revision) {
      return { ok: false, reason: "stale_revision", message: "This version is outdated; review the latest." };
    }
    draft.state = "committed";
    draft.committed_revision = revision;
    this.operationKeys.set(operation_key, { draft_id, revision });
    this.commits += 1;
    return { ok: true, draft_id, committed_revision: revision };
  }

  correct_draft({ draft_id, store, changes }) {
    const missing = DraftStore.#requireStore(store);
    if (missing) return missing;
    const scoped = this.#getScoped(draft_id, store);
    if (!scoped.ok) return scoped;
    const draft = scoped.draft;
    if (draft.state !== "open") {
      return { ok: false, reason: "not_open", message: "Only an open draft can be corrected." };
    }
    draft.revision += 1;
    draft.corrections.push({ revision: draft.revision, changes: changes ?? {} });
    return { ok: true, draft_id, revision: draft.revision };
  }

  abandon({ draft_id, store }) {
    const missing = DraftStore.#requireStore(store);
    if (missing) return missing;
    const scoped = this.#getScoped(draft_id, store);
    if (!scoped.ok) return scoped;
    const draft = scoped.draft;
    if (draft.state !== "open") {
      return { ok: false, reason: "not_open", message: "Only an open draft can be left." };
    }
    draft.state = "abandoned";
    return { ok: true, draft_id };
  }

  ingest_message({ message_id, store, kind, ref, body }) {
    const missing = DraftStore.#requireStore(store);
    if (missing) return missing;
    if (this.messages.has(message_id)) {
      return { ok: false, reason: "duplicate_message", message: "Message already received; ignoring replay." };
    }
    const contentKey = ref ? `${store}:${ref}` : null;
    const firstDraftId = contentKey ? this.contentRefs.get(contentKey) : undefined;
    if (firstDraftId !== undefined) {
      // Same bytes, new provider message: a resend, not a retry. Record a
      // reviewable warning; never a silent second commit.
      const draft_id = `D-${message_id}`;
      const draft = {
        draft_id,
        store,
        kind: kind ?? null,
        state: "open",
        revision: 1,
        committed_revision: null,
        corrections: [],
        notes: body ? [body] : [],
        duplicate_of: firstDraftId,
      };
      this.drafts.set(draft_id, draft);
      this.messages.set(message_id, { store, draft_id });
      this.warnings.push({ type: "duplicate_content", draft_id, duplicate_of: firstDraftId, ref });
      return { ok: true, draft_id, duplicate_warning: true };
    }
    // Returning owner: resume the most recently abandoned draft in this store
    // so a follow-up correction is never lost.
    let resumed = null;
    for (const draft of this.drafts.values()) {
      if (draft.store === store && draft.state === "abandoned") resumed = draft;
    }
    if (resumed) {
      resumed.state = "open";
      if (body) resumed.notes.push(body);
      this.messages.set(message_id, { store, draft_id: resumed.draft_id });
      if (contentKey) this.contentRefs.set(contentKey, resumed.draft_id);
      return { ok: true, draft_id: resumed.draft_id, resumed: true };
    }
    const draft_id = `D-${message_id}`;
    this.drafts.set(draft_id, {
      draft_id,
      store,
      kind: kind ?? null,
      state: "open",
      revision: 1,
      committed_revision: null,
      corrections: [],
      notes: body ? [body] : [],
      duplicate_of: null,
    });
    this.messages.set(message_id, { store, draft_id });
    if (contentKey) this.contentRefs.set(contentKey, draft_id);
    return { ok: true, draft_id, created: true };
  }

  // Harness-level delay (E8-03 step 2): simulates elapsed time without
  // touching tenant state, so it takes no store context.
  wait({ delay } = {}) {
    return { ok: true, elapsed: delay ?? "none" };
  }

  getDraft(draft_id) {
    return this.drafts.get(draft_id);
  }

  openDraftsForMessage(message_id) {
    const link = this.messages.get(message_id);
    if (!link) return 0;
    const draft = this.drafts.get(link.draft_id);
    return draft && draft.state === "open" ? 1 : 0;
  }

  hasDuplicateWarning() {
    return this.warnings.some((w) => w.type === "duplicate_content");
  }
}
