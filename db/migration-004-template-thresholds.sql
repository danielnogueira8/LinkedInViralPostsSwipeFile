-- Separate threshold for auto-templating, higher than the swipe-file threshold.
-- Posts between the two stay in the swipe file but skip auto-templating to save
-- Anthropic spend. The "Generate template" button still works on any post.

insert into settings (key, value) values
  ('template_thresholds', '{"min_reactions": 500, "min_comments": 100}'::jsonb)
on conflict (key) do nothing;
