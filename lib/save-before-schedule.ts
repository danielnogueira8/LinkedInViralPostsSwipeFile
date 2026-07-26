export type SaveThenScheduleResult<T> =
  | { ok: true; value: T }
  | { ok: false; stage: "save" }
  | { ok: false; stage: "schedule"; error: unknown };

/** One ordering seam shared by exact-time and recurring-queue scheduling. */
export async function saveThenSchedule<T>(input: {
  save: () => Promise<boolean>;
  schedule: () => Promise<T>;
}): Promise<SaveThenScheduleResult<T>> {
  if (!(await input.save())) return { ok: false, stage: "save" };
  try {
    return { ok: true, value: await input.schedule() };
  } catch (error) {
    return { ok: false, stage: "schedule", error };
  }
}

