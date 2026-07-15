import { stripArtifactFences } from "@/lib/artifact-fences";

export function replaceOrAppendArtifact<T extends { id: string }>(
  existing: T[],
  incoming: T,
): T[] {
  const index = existing.findIndex((artifact) => artifact.id === incoming.id);
  if (index === -1) return [...existing, incoming];
  return existing.map((artifact, current) => current === index ? incoming : artifact);
}

export function persistedDraftPanelArtifacts<T extends { id: string }>(
  persisted: readonly T[],
): T[] {
  const uniquePersisted: T[] = [];
  // Draft cards expose persistence-backed actions (edit, save, schedule, and
  // delete), so a streamed artifact is deliberately excluded until the
  // canonical assistant message has been loaded into `persisted`.
  for (const artifact of persisted) {
    const existing = uniquePersisted.findIndex(
      (candidate) => candidate.id === artifact.id,
    );
    if (existing === -1) uniquePersisted.push(artifact);
    else uniquePersisted[existing] = artifact;
  }
  return uniquePersisted;
}

export function sameFiles(a?: string[], b?: string[]): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((file, index) => file === b[index]);
}

export type SessionViewMessage<Tool, Plan, Ask, Artifact, Recoverable> = {
  id: string;
  role: "user" | "assistant";
  text: string;
  files?: string[];
  tools?: Tool[];
  plan?: Plan[];
  ask?: Ask;
  artifacts?: Artifact[];
  draftRendered?: boolean;
  recoverable?: Recoverable;
  streaming?: boolean;
};

export function runOverlay<Tool, Plan, Ask, Artifact extends { kind: string }, Recoverable>(
  run: {
    userMsg: SessionViewMessage<Tool, Plan, Ask, Artifact, Recoverable>;
    assistantId: string;
    rawText: string;
    tools: Tool[];
    plan: Plan[];
    ask?: Ask;
    artifacts: Artifact[];
    recoverable?: Recoverable;
    streaming: boolean;
  },
  base: SessionViewMessage<Tool, Plan, Ask, Artifact, Recoverable>[] = [],
): SessionViewMessage<Tool, Plan, Ask, Artifact, Recoverable>[] {
  const lastUser = [...base].reverse().find((message) => message.role === "user");
  const alreadyInBase =
    Boolean(lastUser) &&
    lastUser!.text === run.userMsg.text &&
    sameFiles(lastUser!.files, run.userMsg.files);
  const assistant = {
    id: run.assistantId,
    role: "assistant" as const,
    text: stripArtifactFences(run.rawText),
    tools: run.tools,
    plan: run.plan,
    ask: run.ask,
    artifacts: run.artifacts.filter((artifact) => artifact.kind === "cite"),
    draftRendered: run.artifacts.some(
      (artifact) => artifact.kind === "post" || artifact.kind === "hook",
    ),
    recoverable: run.recoverable,
    streaming: run.streaming,
  };
  return [...(alreadyInBase ? [] : [run.userMsg]), assistant];
}

export function shouldApplyAskTurnReload<
  M extends SessionViewMessage<unknown, unknown, unknown, unknown, unknown>,
>(
  currentBase: M[],
  reloadedBase: M[],
): boolean {
  if (!reloadedBase.some((message) => message.role === "assistant" && Boolean(message.ask))) {
    return false;
  }
  const currentLast = currentBase.at(-1)?.id ?? null;
  const reloadedLast = reloadedBase.at(-1)?.id ?? null;
  return !(currentBase.length > reloadedBase.length && currentLast !== reloadedLast);
}
