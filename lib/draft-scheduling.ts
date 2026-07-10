export const SCHEDULABLE_DRAFT_STATUSES = ["idea", "drafting", "ready"] as const;

export const SCHEDULABLE_SCHEDULE_STATUS_FILTER =
  "schedule_status.is.null,schedule_status.in.(scheduled,failed)";

export const DRAFT_SCHEDULING_CONFLICT =
  "This draft is already publishing or published and can't be rescheduled.";
