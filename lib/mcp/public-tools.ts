export type PublicMcpTool = {
  name: string;
  description: string;
  group: "Research" | "Creators" | "Content" | "Training";
  access: "Read" | "Create" | "Manage";
};

export const PUBLIC_MCP_TOOLS = [
  { name: "search_viral_posts", description: "Search viral posts with niche, date, engagement, and format filters; focused searches can render original images.", group: "Research", access: "Read" },
  { name: "get_post", description: "Read one tracked viral post by its id, including rendered original images when available.", group: "Research", access: "Read" },
  { name: "list_niches", description: "List the niches represented by tracked creators.", group: "Research", access: "Read" },
  { name: "get_top_from_batch", description: "Read the strongest recently published posts from the latest scrape.", group: "Research", access: "Read" },
  { name: "save_post", description: "Save a LinkedIn post to the workspace bookmark library.", group: "Research", access: "Create" },
  { name: "list_saved_posts", description: "List posts saved to the workspace bookmark library.", group: "Research", access: "Read" },
  { name: "list_categories", description: "List curated and workspace-created content categories.", group: "Research", access: "Read" },
  { name: "create_category", description: "Create a private category for this workspace.", group: "Research", access: "Create" },
  { name: "list_accounts", description: "List the LinkedIn creators tracked by this workspace.", group: "Creators", access: "Read" },
  { name: "add_account", description: "Add a LinkedIn creator to the workspace's tracked sources.", group: "Creators", access: "Create" },
  { name: "update_account", description: "Update a tracked creator's workspace-specific niche.", group: "Creators", access: "Manage" },
  { name: "remove_account", description: "Stop tracking a creator while preserving shared source history.", group: "Creators", access: "Manage" },
  { name: "restore_account", description: "Resume tracking a previously removed creator.", group: "Creators", access: "Manage" },
  { name: "list_drafts", description: "List post drafts and their publishing state.", group: "Content", access: "Read" },
  { name: "get_draft", description: "Read one complete post draft, including its body and media references.", group: "Content", access: "Read" },
  { name: "create_draft", description: "Create a post, hook, or lead-magnet draft on the Posts board.", group: "Content", access: "Create" },
  { name: "schedule_draft", description: "Schedule a saved draft for LinkedIn publishing.", group: "Content", access: "Manage" },
  { name: "unschedule_draft", description: "Cancel a draft's pending LinkedIn schedule.", group: "Content", access: "Manage" },
  { name: "list_lead_magnets", description: "List the workspace's saved lead magnets.", group: "Content", access: "Read" },
  { name: "get_lead_magnet", description: "Read one lead magnet with its complete Markdown content.", group: "Content", access: "Read" },
  { name: "create_lead_magnet", description: "Create a manual lead magnet from Markdown content.", group: "Content", access: "Create" },
  { name: "get_voice", description: "Read the workspace's generated writing voice and patterns.", group: "Training", access: "Read" },
  { name: "create_voice", description: "Start voice-profile generation from a LinkedIn profile.", group: "Training", access: "Create" },
  { name: "list_preferences", description: "List standing writing rules applied to every Cowork generation.", group: "Training", access: "Read" },
  { name: "create_preference", description: "Create a standing workspace writing rule.", group: "Training", access: "Create" },
  { name: "list_creator_styles", description: "List writing styles distilled from tracked creators or saved posts.", group: "Training", access: "Read" },
  { name: "get_creator_style", description: "Read one creator style and the sources used to build it.", group: "Training", access: "Read" },
  { name: "create_creator_style", description: "Start a creator-style distillation job from approved sources.", group: "Training", access: "Create" },
  { name: "list_templates", description: "List built-in and workspace-created writing templates.", group: "Training", access: "Read" },
  { name: "get_template", description: "Read one built-in or custom writing template.", group: "Training", access: "Read" },
  { name: "create_template", description: "Create a reusable workspace writing template.", group: "Training", access: "Create" },
  { name: "list_skills", description: "List workspace-created Cowork skills and their instructions.", group: "Training", access: "Read" },
  { name: "get_skill", description: "Read one workspace-created Cowork skill.", group: "Training", access: "Read" },
  { name: "create_skill", description: "Create a validated workspace Cowork skill.", group: "Training", access: "Create" },
] as const satisfies readonly PublicMcpTool[];
