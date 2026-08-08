import type { Usage } from "@earendil-works/pi-ai";

export type DiagnosticKind =
  | "config"
  | "checkpoint"
  | "task"
  | "provider"
  | "capacity"
  | "lifecycle";

export interface DiagnosticRecord {
  kind: DiagnosticKind;
  message: string;
  at: string;
}

export interface DiagnosticSnapshot {
  records: readonly DiagnosticRecord[];
  counters: Readonly<Record<string, number>>;
  usageTokens: {
    consumed: number;
    discarded: number;
  };
}

/** 保存 Pi-press 运行期诊断和 usage 分类，不写入 session。 */
export class Diagnostics {
  private readonly records: DiagnosticRecord[] = [];
  private readonly counters = new Map<string, number>();
  private consumedTokens = 0;
  private discardedTokens = 0;

  record(kind: DiagnosticKind, message: string): void {
    this.records.push({ kind, message, at: new Date().toISOString() });
    if (this.records.length > 100) {
      this.records.shift();
    }
  }

  count(name: string): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  recordUsage(kind: "consumed" | "discarded", usage: Usage | undefined): void {
    const totalTokens = usage?.totalTokens;
    if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0) {
      return;
    }
    if (kind === "consumed") {
      this.consumedTokens += totalTokens;
    } else {
      this.discardedTokens += totalTokens;
    }
  }

  snapshot(): DiagnosticSnapshot {
    return {
      records: [...this.records],
      counters: Object.fromEntries(this.counters),
      usageTokens: {
        consumed: this.consumedTokens,
        discarded: this.discardedTokens,
      },
    };
  }
}
