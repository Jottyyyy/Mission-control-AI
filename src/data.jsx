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

  // Apps currently connected to the assistant. Empty on first launch.
  connectedApps: [],

  // Apps available to connect. Discovery-only metadata — not fake "on" state.
  availableApps: [
    { name: "Calendar", desc: "Read your schedule and book meetings", icon: "Calendar", explain: [
      "See your schedule and upcoming meetings.",
      "Book, move, or cancel — always shown to you first.",
      "You can disconnect at any time.",
    ]},
    { name: "Gmail", desc: "Read and draft emails", icon: "Mail", explain: [
      "Read your inbox so briefings can surface what matters.",
      "Drafts replies in your voice — never sends alone.",
      "Disconnect anytime.",
    ]},
    { name: "Notes", desc: "Save and find your notes", icon: "NotebookPen", explain: [
      "Keep a searchable record of your thoughts.",
      "Retrieve notes by meaning, not filename.",
      "Stays on this Mac Mini.",
    ]},
    { name: "Lusha", desc: "Find contact details for leads", icon: "Users", explain: [
      "Premium fallback for emails and direct numbers.",
      "Used only when the primary source misses.",
      "Respects your monthly credit cap.",
    ]},
    { name: "Cognism", desc: "Verified B2B contact data", icon: "Users", explain: [
      "Primary enrichment source.",
      "Monthly credit cap honoured — no auto-top-up.",
      "Every call is logged with cost.",
    ]},
    { name: "RocketReach", desc: "Enrich contact records", icon: "Users", explain: [
      "Secondary lookup for named decision-makers.",
      "Used only when prior sources miss.",
      "Respects your monthly cap.",
    ]},
    { name: "Surfe", desc: "Sync contacts to your CRM", icon: "Layers", explain: [
      "Push enriched contacts into your CRM automatically.",
      "Mirrors changes both ways.",
      "Nothing syncs without your say-so.",
    ]},
    { name: "Zint data", desc: "Companies House and UK filings", icon: "Database", explain: [
      "Pull UK company filings and shareholder data.",
      "Used for MAN identification.",
      "Read-only.",
    ]},
    { name: "Fame data", desc: "UK company financials", icon: "Database", explain: [
      "UK financial data to qualify leads by size.",
      "Supports mid-market filters.",
      "Read-only.",
    ]},
    { name: "Slack", desc: "Read and send messages", icon: "Slack", explain: [
      "Read channels and DMs so the assistant can follow up on threads.",
      "Send messages on your behalf — always shown to you first.",
      "You can disconnect at any time.",
    ]},
    { name: "WhatsApp Business", desc: "Message clients directly", icon: "MessageSquare", explain: [
      "Reply to client messages from one place.",
      "Draft responses in your voice.",
      "Only business numbers, no personal chats.",
    ]},
    { name: "LinkedIn", desc: "Research people and firms", icon: "Linkedin", explain: [
      "Look up profiles of leads and decision makers.",
      "Save useful findings to your memory.",
      "Never post anything without your say-so.",
    ]},
    { name: "HubSpot", desc: "Sync leads and deals", icon: "Briefcase", explain: [
      "Keep your CRM up to date automatically.",
      "Pull deal context into briefings.",
      "Mirror changes both ways.",
    ]},
    { name: "Salesforce", desc: "Sync your opportunity pipeline", icon: "Briefcase", explain: [
      "Bring Salesforce records into conversations.",
      "Log call notes and follow-ups for you.",
      "Read-only until you're ready to enable writes.",
    ]},
    { name: "Xero", desc: "See accounts and invoices", icon: "FileText", explain: [
      "Summarise payables and receivables on request.",
      "Flag overdue invoices in morning briefings.",
      "Never moves money.",
    ]},
    { name: "Dropbox", desc: "Read documents in your folders", icon: "Folder", explain: [
      "Find files by describing them.",
      "Summarise long PDFs.",
      "Only folders you allow.",
    ]},
    { name: "Zoom", desc: "Join and summarise meetings", icon: "Video", explain: [
      "Auto-join your meetings if you'd like.",
      "Share a tidy summary afterwards.",
      "You control which meetings.",
    ]},
    { name: "Google Drive", desc: "Read your files", icon: "Folder", explain: [
      "Search across your Drive by meaning, not filename.",
      "Pull context into drafts.",
      "Nothing is copied off this Mac Mini.",
    ]},
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
