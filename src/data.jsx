// Empty states — real data comes from the backend when wired up.
// Structure preserved so components keep their contracts; all arrays and
// strings are empty or neutral until real data flows in.
const Data = {
  // Per-assistant conversation lists (sidebar history)
  conversations: {
    personal:  { today: [], yesterday: [], last7: [] },
    marketing: { today: [], yesterday: [], last7: [] },
  },

  assistants: {
    personal: {
      key: "personal",
      name: "Personal assistant",
      blurb: "Your calendar, inbox, notes and daily briefings.",
      accent: "personal",
      icon: "Calendar",
      chips: [
        "What's on my calendar today?",
        "Summarise overnight replies",
        "Draft a quick note",
        "Prep me for my next meeting",
      ],
      emptyGreetingBlurb: "Your inbox, calendar, and daily rhythm.",
      activityToday: 0,
      recent: [],
    },
    marketing: {
      key: "marketing",
      name: "Marketing assistant",
      blurb: "Leads, decision-makers, campaigns and outreach.",
      accent: "marketing",
      icon: "TrendingUp",
      chips: [
        "Pull leads from a batch",
        "Find the MAN for a company",
        "Enrich a batch of contacts",
        "Draft warm-intro emails",
      ],
      emptyGreetingBlurb: "Sourcing, enrichment, and outreach for your pipeline.",
      activityToday: 0,
      recent: [],
    },
  },

  // The daily briefing string. Empty until calendar + inbox are connected.
  briefing: "",

  // Seed messages per assistant. Empty — the chat opens clean.
  seedMessages: {
    personal: [],
    marketing: [],
  },

  // Generic suggestion chips (no specific names/companies/dates)
  chips: [
    "What's on my calendar today?",
    "Pull leads from a batch",
    "Find the MAN for a company",
    "Draft a quick note",
  ],


  // Skills — mirror the ten real OpenClaw skills scaffolded under
  // ~/.openclaw/workspace/agents/{personal,marketing}/skills/. All start off
  // and marked as "scaffold" until their SKILL.md implementations are wired up.
  skills: [
    { id: "daily-briefing",  name: "Daily briefing",    description: "Morning summary — calendar, inbox, overnight news.",              group: "personal",  on: false, status: "scaffold" },
    { id: "calendar-check",  name: "Calendar check",    description: "Read-only calendar lookups with travel buffers.",                 group: "personal",  on: false, status: "scaffold" },
    { id: "email-triage",    name: "Email triage",      description: "Sorts and prioritises inbox — never sends a reply.",              group: "personal",  on: false, status: "scaffold" },
    { id: "meeting-prep",    name: "Meeting prep",      description: "One-page brief before a meeting — attendees, context, agenda.",   group: "personal",  on: false, status: "scaffold" },
    { id: "note-capture",    name: "Note capture",      description: "Files a quick thought into memory.",                              group: "personal",  on: false, status: "scaffold" },
    { id: "identify-man",    name: "Identify the MAN",  description: "Finds the MAN at a company — shareholder priority order.",        group: "marketing", on: false, status: "scaffold" },
    { id: "enrich-contact",  name: "Enrich contact",    description: "Gets email + mobile via Cognism → Lusha cascade.",                group: "marketing", on: false, status: "scaffold" },
    { id: "pipeline-review", name: "Pipeline review",   description: "Current batch status — found, pending, spend vs cap.",            group: "marketing", on: false, status: "scaffold" },
    { id: "lead-batch-run",  name: "Lead batch run",    description: "Processes a full batch end-to-end with budget guards.",           group: "marketing", on: false, status: "scaffold" },
    { id: "campaign-draft",  name: "Campaign draft",    description: "Drafts outreach — marked awaiting approval, never sends.",        group: "marketing", on: false, status: "scaffold" },
  ],

  // Catalogue of skills Sir Adam can add. Discovery metadata only.
  skillGallery: [
    { name: "Whitepaper researcher",  desc: "Deep-reads industry papers and gives you a brief." },
    { name: "LinkedIn post drafter",  desc: "Drafts posts in your voice, never publishes alone." },
    { name: "FX rate monitor",        desc: "Watches currency pairs and pings you on moves." },
    { name: "Industry research",      desc: "Travel, defence, and oil & gas context on demand." },
    { name: "Voice mode",             desc: "Talk instead of typing, with a natural voice." },
    { name: "Phone dialer",           desc: "Place calls and leave voicemails for you." },
  ],

  // Long-term memory bullets. Empty until the assistant learns things.
  memory: [],

  // Recent conversations list. Empty until real chats exist.
  recentConvos: [],

  // Activity log. Empty until the assistant does real work.
  activity: [],

  // Pipeline stage labels (structural — kept so columns render).
  pipelineSteps: [
    { label: "Find companies" },
    { label: "Identify the MAN" },
    { label: "Get contacts" },
  ],

  // Live pipeline progress feed. Empty until a real batch runs.
  pipelineRun: [],

  // Pipeline results. Empty until a real batch completes.
  pipelineResults: [],
};

export default Data;
