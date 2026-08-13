import { useEffect, useState, useSyncExternalStore } from "react";
import type { DeliveryAction, DeliveryContext, DeliveryPlan, PullRequestDraft } from "../../types";

export type DeliveryFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ReviewedDeliverySnapshot {
  context: DeliveryContext | null;
  selectedPaths: string[];
  action: DeliveryAction;
  message: string;
  remote: string;
  base: string;
  title: string;
  body: string;
  plan: DeliveryPlan | null;
  error: string | null;
  busy: boolean;
  loading: boolean;
}

export interface ReviewedDeliverySessionAdapters {
  request?: DeliveryFetch;
}

function deliveryError(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeliveryContext(value: unknown): value is DeliveryContext {
  if (!isRecord(value) || !Array.isArray(value.remotes)) return false;
  return typeof value.repository === "string" && typeof value.worktree === "string";
}

function isDeliveryPlan(value: unknown): value is DeliveryPlan {
  return isRecord(value) && typeof value.id === "string" && typeof value.summary === "string";
}

function isPullRequestDraft(value: unknown): value is PullRequestDraft {
  return isRecord(value) && typeof value.title === "string" && typeof value.body === "string";
}

export function initialReviewedDeliverySnapshot(): ReviewedDeliverySnapshot {
  return {
    context: null,
    selectedPaths: [],
    action: "stage",
    message: "",
    remote: "",
    base: "main",
    title: "",
    body: "",
    plan: null,
    error: null,
    busy: false,
    loading: false,
  };
}

/**
 * Owns Code-hosted git delivery transport (inspect/draft/prepare/execute)
 * while ChangesPanel retains chrome and the host retains git authority.
 */
export class ReviewedDeliverySessionModule {
  private snapshot: ReviewedDeliverySnapshot = initialReviewedDeliverySnapshot();
  private readonly listeners = new Set<() => void>();
  private operationId = 0;
  private planGeneration = 0;
  private readonly request: DeliveryFetch;

  constructor(adapters: ReviewedDeliverySessionAdapters = {}) {
    this.request = adapters.request ?? fetch;
  }

  getSnapshot = (): ReviewedDeliverySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  reset(): void {
    this.operationId += 1;
    this.planGeneration += 1;
    this.replace(initialReviewedDeliverySnapshot());
  }

  /** Drop repository-bound inspect/plan state; keep authored draft fields. */
  resetScope(): void {
    this.operationId += 1;
    this.planGeneration += 1;
    this.patch({
      context: null,
      selectedPaths: [],
      remote: "",
      plan: null,
      error: null,
      busy: false,
      loading: false,
    });
  }

  clearPlan(): void {
    this.invalidatePlan();
  }

  setAction(action: DeliveryAction): void {
    this.invalidatePlan({ action });
  }

  setMessage(message: string): void {
    this.invalidatePlan({ message });
  }

  setRemote(remote: string): void {
    this.invalidatePlan({ remote });
  }

  setBase(base: string): void {
    this.invalidatePlan({ base });
  }

  setTitle(title: string): void {
    this.invalidatePlan({ title });
  }

  setBody(body: string): void {
    this.invalidatePlan({ body });
  }

  toggleSelectedPaths(paths: readonly string[], selected: boolean): void {
    this.invalidatePlan({
      selectedPaths: selected
        ? [...new Set([...this.snapshot.selectedPaths, ...paths])]
        : this.snapshot.selectedPaths.filter((path) => !paths.includes(path)),
    });
  }

  async inspect(root: string, worktree: string): Promise<void> {
    const operationId = ++this.operationId;
    this.patch({ loading: true, error: null });
    try {
      const response = await this.request("/api/delivery/inspect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root, worktree }),
      });
      const result: unknown = await response.json();
      if (operationId !== this.operationId) return;
      if (!response.ok) {
        throw new Error(deliveryError(result, "Delivery state could not be inspected."));
      }
      if (!isDeliveryContext(result)) {
        throw new Error("Delivery state could not be inspected.");
      }
      this.patch({
        context: result,
        remote: this.snapshot.remote || result.remotes[0]?.name || "",
        loading: false,
      });
    } catch (cause) {
      if (operationId !== this.operationId) return;
      this.patch({
        loading: false,
        error: cause instanceof Error ? cause.message : "Delivery state could not be inspected.",
      });
    }
  }

  async generatePullRequestDraft(root: string, worktree: string): Promise<void> {
    const operationId = ++this.operationId;
    this.patch({ busy: true, error: null });
    try {
      const response = await this.request("/api/delivery/pr-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root, worktree, base: this.snapshot.base }),
      });
      const result: unknown = await response.json();
      if (operationId !== this.operationId) return;
      if (!response.ok) {
        throw new Error(deliveryError(result, "The pull-request draft could not be generated."));
      }
      if (!isPullRequestDraft(result)) {
        throw new Error("The pull-request draft could not be generated.");
      }
      this.patch({ title: result.title, body: result.body, busy: false });
    } catch (cause) {
      if (operationId !== this.operationId) return;
      this.patch({
        busy: false,
        error:
          cause instanceof Error ? cause.message : "The pull-request draft could not be generated.",
      });
    }
  }

  async prepare(root: string, worktree: string): Promise<void> {
    const operationId = ++this.operationId;
    const planGeneration = this.planGeneration;
    this.patch({ busy: true, error: null });
    try {
      const { action, selectedPaths, message, remote, base, title, body } = this.snapshot;
      const input =
        action === "stage"
          ? { paths: selectedPaths }
          : action === "commit"
            ? { message }
            : action === "push"
              ? { remote }
              : { remote, base, title, body };
      const response = await this.request("/api/delivery/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root, worktree, action, input }),
      });
      const result: unknown = await response.json();
      if (operationId !== this.operationId) return;
      if (planGeneration !== this.planGeneration) {
        this.patch({ busy: false });
        return;
      }
      if (!response.ok) {
        throw new Error(deliveryError(result, "The action could not be prepared."));
      }
      if (!isDeliveryPlan(result)) throw new Error("The action could not be prepared.");
      this.patch({ plan: result, busy: false });
    } catch (cause) {
      if (operationId !== this.operationId) return;
      if (planGeneration !== this.planGeneration) {
        this.patch({ busy: false });
        return;
      }
      this.patch({
        busy: false,
        error: cause instanceof Error ? cause.message : "The action could not be prepared.",
      });
    }
  }

  async execute(root: string, worktree: string, onRefresh: () => void): Promise<void> {
    const plan = this.snapshot.plan;
    if (!plan) return;
    const operationId = ++this.operationId;
    this.patch({ busy: true, error: null });
    try {
      const response = await this.request(`/api/delivery/plans/${plan.id}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root, worktree }),
      });
      const result: unknown = await response.json();
      if (operationId !== this.operationId) return;
      if (!response.ok) {
        throw new Error(deliveryError(result, "The approved action failed."));
      }
      this.planGeneration += 1;
      this.patch({ plan: null, selectedPaths: [], busy: false });
      await Promise.all([this.inspect(root, worktree), Promise.resolve(onRefresh())]);
    } catch (cause) {
      if (operationId !== this.operationId) return;
      this.patch({
        busy: false,
        error: cause instanceof Error ? cause.message : "The approved action failed.",
      });
    }
  }

  private invalidatePlan(next: Partial<ReviewedDeliverySnapshot> = {}): void {
    this.planGeneration += 1;
    this.patch({ plan: null, ...next });
  }

  private patch(next: Partial<ReviewedDeliverySnapshot>): void {
    this.replace({ ...this.snapshot, ...next });
  }

  private replace(snapshot: ReviewedDeliverySnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function useReviewedDeliverySession(options: {
  root: string;
  worktree: string;
  active: boolean;
}): { snapshot: ReviewedDeliverySnapshot; session: ReviewedDeliverySessionModule } {
  const [session] = useState(() => new ReviewedDeliverySessionModule());
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(() => {
    session.resetScope();
    if (!options.active) return;
    void session.inspect(options.root, options.worktree);
  }, [options.active, options.root, options.worktree, session]);
  return { snapshot, session };
}
