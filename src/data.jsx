// Sample data across screens. All names fictional.

const Data = {
  // Per-assistant conversation lists
  conversations: {
    personal: {
      today: [
        { id: "p1", title: "Morning briefing" },
        { id: "p2", title: "Reynolds meeting prep" },
      ],
      yesterday: [
        { id: "p3", title: "Calendar rearranged for Thursday" },
        { id: "p4", title: "Note to Tom about the Q2 list" },
      ],
      last7: [
        { id: "p5", title: "GBPUSD movement analysis" },
        { id: "p6", title: "Flight to Manchester booked" },
      ],
    },
    marketing: {
      today: [
        { id: "m1", title: "Acme Manufacturing enrichment" },
        { id: "m2", title: "Q2 pipeline — shortlist" },
      ],
      yesterday: [
        { id: "m3", title: "Q2 lead pipeline review" },
        { id: "m4", title: "Travel sector campaign ideas" },
      ],
      last7: [
        { id: "m5", title: "Cotswold Industrial research" },
        { id: "m6", title: "Pennine Steel intro email" },
        { id: "m7", title: "Whitepaper — UK manufacturers 2026" },
      ],
    },
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
        "Draft a quick note to Tom",
        "Book a table for dinner on Thursday",
      ],
      emptyGreetingBlurb: "Your inbox, calendar, and daily rhythm.",
      activityToday: 7,
      recent: [
        { title: "Morning briefing", time: "08:12" },
        { title: "Reynolds meeting prep", time: "10:28" },
      ],
    },
    marketing: {
      key: "marketing",
      name: "Marketing assistant",
      blurb: "Leads, decision-makers, campaigns and outreach.",
      accent: "marketing",
      icon: "TrendingUp",
      chips: [
        "Pull 20 leads from the Zint batch",
        "Who's the MAN at Acme Manufacturing Ltd?",
        "Find the MAN at these 50 companies",
        "Draft warm-intro emails for the Q2 list",
      ],
      emptyGreetingBlurb: "Sourcing, enrichment, and outreach for your pipeline.",
      activityToday: 12,
      recent: [
        { title: "Acme Manufacturing enrichment", time: "09:40" },
        { title: "Q2 pipeline — shortlist", time: "11:55" },
      ],
    },
  },

  briefing:
    "Today you have 3 meetings (Reynolds at 11, internal at 2, Cotswold at 4:30), 2 leads replied overnight (Acme and Pennine), and GBPUSD is up 0.4% since yesterday's close.",

  // Seed messages per assistant for the "active" state
  seedMessages: {
    personal: [
      { from: "user", text: "What's on my calendar today?" },
      {
        from: "assistant",
        text:
          "Three things:\n\n• 11:00 — Reynolds (prep ready, I've pulled the last three emails)\n• 14:00 — Internal with the FX desk\n• 16:30 — Cotswold, at their office\n\nYou've also got 40 minutes free between 12 and 1. Shall I hold that for lunch?",
      },
      { from: "user", text: "Yes please, and let Tom know I'll be back by 2." },
      {
        from: "assistant",
        text:
          "Done. I've blocked 12–12:45 for lunch and dropped Tom a note that you'll be back by 2.",
      },
    ],
    marketing: [
      { from: "user", text: "Who's the MAN at Acme Manufacturing Ltd?" },
      {
        from: "assistant",
        text:
          "At Acme Manufacturing Ltd, the main decision maker looks to be John Smith, the CFO. He's been there since 2019 and signs off on all financing arrangements.\n\nWant me to pull his contact details and check for a recent intro point?",
      },
      { from: "user", text: "Yes please. And add him to the Q2 list." },
      {
        from: "assistant",
        text:
          "Done. John Smith — j.smith@acme.co.uk, +44 7700 900123. Added to your Q2 list.\n\nTwo nearby intros: Sarah Whittaker at Pennine Steel (worked with him at Rolls-Royce) and David Reynolds — he mentioned Acme in your last call. Want a warm-intro draft to either?",
      },
    ],
  },

  // Legacy fallback (not used directly after split, but kept for safety)
  chips: [
    "What's on my calendar today?",
    "Pull 20 leads from the Zint batch",
    "Who's the MAN at Acme Manufacturing Ltd?",
    "Draft a quick note to Tom",
  ],

  connectedApps: [
    { name: "Calendar", desc: "Read your schedule and book meetings", connected: true, icon: "Calendar" },
    { name: "Gmail", desc: "Read and draft emails", connected: true, icon: "Mail" },
    { name: "Notes", desc: "Save and find your notes", connected: true, icon: "NotebookPen" },
    { name: "Lusha", desc: "Find contact details for leads", connected: true, icon: "Users" },
    { name: "Cognism", desc: "Verified B2B contact data", connected: true, icon: "Users" },
    { name: "RocketReach", desc: "Enrich contact records", connected: true, icon: "Users" },
    { name: "Surfe", desc: "Sync contacts to your CRM", connected: true, icon: "Layers" },
    { name: "Zint data", desc: "Companies House and UK filings", connected: true, icon: "Database" },
    { name: "Fame data", desc: "UK company financials", connected: true, icon: "Database" },
  ],

  availableApps: [
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

  skills: [
    { name: "Daily morning briefing", desc: "A short summary each morning — meetings, replies, FX.", on: true },
    { name: "Lead sourcer", desc: "Pulls fresh leads from your chosen data sources.", on: true },
    { name: "Decision-maker finder", desc: "Identifies the MAN at each target company.", on: true },
    { name: "Contact enricher", desc: "Fills in emails and direct numbers for a list.", on: true },
    { name: "Meeting summariser", desc: "Turns calls into tidy notes and action items.", on: true },
    { name: "Travel booker", desc: "Finds and books flights and hotels within your rules.", on: false },
  ],

  skillGallery: [
    { name: "Whitepaper researcher", desc: "Deep-reads industry papers and gives you a brief." },
    { name: "LinkedIn post drafter", desc: "Drafts posts in your voice, never publishes alone." },
    { name: "FX rate monitor", desc: "Watches currency pairs and pings you on moves." },
    { name: "Industry research", desc: "Travel, defence, and oil & gas context on demand." },
    { name: "Voice mode", desc: "Talk instead of typing, with a natural voice." },
    { name: "Phone dialer", desc: "Place calls and leave voicemails for you." },
  ],

  memory: [
    "Your name is Adam and you work at JSP in London.",
    "You prefer short, plain-English replies — no jargon.",
    "You deal in FX (mainly GBPUSD, EURUSD) and UK mid-market lending.",
    "Your assistant in the office is Tom — emails to him can be informal.",
    "You dislike the phrase \"circle back\" — don't use it.",
    "Your preferred meeting time is 11am; avoid before 9 or after 6.",
    "Your Q2 lead list is focused on UK manufacturers with £5–50M turnover.",
  ],

  recentConvos: [
    { title: "Morning briefing", date: "Today, 08:12" },
    { title: "Acme Manufacturing enrichment", date: "Today, 09:40" },
    { title: "Reynolds meeting prep", date: "Today, 10:28" },
    { title: "Q2 lead pipeline review", date: "Yesterday, 16:02" },
    { title: "Travel sector campaign ideas", date: "Yesterday, 11:15" },
    { title: "GBPUSD movement analysis", date: "Wed, 14:48" },
    { title: "Cotswold Industrial research", date: "Tue, 10:06" },
    { title: "Pennine Steel intro email", date: "Mon, 17:22" },
  ],

  activity: [
    { time: "2 minutes ago", cat: "Marketing", text: "Enriched 15 contacts from the Zint batch.", detail: "Of 15 companies, identified the MAN in 14. Got email and mobile for 12, email only for 2." },
    { time: "28 minutes ago", cat: "Personal", text: "Prepared your 11am Reynolds meeting.", detail: "Pulled last three emails, recent Companies House filing, and mutual contacts." },
    { time: "1 hour ago", cat: "Personal", text: "Morning briefing sent.", detail: "3 meetings, 2 overnight replies, GBPUSD up 0.4%." },
    { time: "3 hours ago", cat: "Marketing", text: "Drafted 4 intro emails for the manufacturing batch.", detail: "Saved to drafts. Each references a specific Companies House filing." },
    { time: "Yesterday, 17:41", cat: "Mission Control", text: "Connected the Surfe sync.", detail: "Two-way sync to your CRM is live." },
    { time: "Yesterday, 16:02", cat: "Personal", text: "Summarised the Q2 pipeline review.", detail: "12 live opportunities, £4.2M weighted." },
    { time: "Yesterday, 11:15", cat: "Marketing", text: "Generated travel-sector campaign ideas.", detail: "Six concepts grouped by audience segment." },
    { time: "Wed, 14:48", cat: "Personal", text: "Analysed GBPUSD over the last 30 days.", detail: "Highlighted two interest-rate-driven moves." },
  ],

  pipelineSteps: [
    { label: "Find companies" },
    { label: "Identify the MAN" },
    { label: "Get contacts" },
  ],

  pipelineRun: [
    { company: "Acme Manufacturing Ltd", status: "Checking Companies House..." },
    { company: "Pennine Steel Holdings", status: "Found MAN: Sarah Whittaker, MD" },
    { company: "Greenwich Marine Engineering", status: "Enriching via Lusha..." },
    { company: "Cotswold Industrial Group", status: "Found MAN: Alan Perch, Chairman" },
    { company: "Reynolds & Partners", status: "Found MAN: David Reynolds, Founder" },
    { company: "Harbour Plastics Ltd", status: "Enriching via Cognism..." },
    { company: "Thorne & Bellamy Ltd", status: "Checking Companies House..." },
    { company: "Weatherby Castings", status: "Found MAN: Linda Weatherby, CEO" },
    { company: "Kilburn Precision Ltd", status: "Enriching via RocketReach..." },
    { company: "Mercia Fabrications", status: "Found MAN: Peter Ellis, CFO" },
  ],

  pipelineResults: [
    { company: "Acme Manufacturing Ltd", name: "John Smith, CFO", email: "j.smith@acme.co.uk", phone: "+44 7700 900123", sources: ["Lusha", "Companies House"] },
    { company: "Pennine Steel Holdings", name: "Sarah Whittaker, MD", email: "s.whittaker@penninesteel.co.uk", phone: "+44 7700 900456", sources: ["Cognism", "Companies House"] },
    { company: "Reynolds & Partners", name: "David Reynolds, Founder", email: "d.reynolds@reynolds-partners.co.uk", phone: "+44 7700 900789", sources: ["RocketReach", "Lusha"] },
    { company: "Cotswold Industrial Group", name: "Alan Perch, Chairman", email: "a.perch@cotswold-industrial.co.uk", phone: null, sources: ["Cognism"] },
    { company: "Greenwich Marine Engineering", name: "Rupert Hale, CEO", email: "r.hale@greenwichmarine.co.uk", phone: "+44 7700 900234", sources: ["Lusha"] },
    { company: "Harbour Plastics Ltd", name: "Gillian Park, MD", email: "g.park@harbourplastics.co.uk", phone: "+44 7700 900345", sources: ["Cognism", "Companies House"] },
    { company: "Weatherby Castings", name: "Linda Weatherby, CEO", email: "linda@weatherbycastings.co.uk", phone: null, sources: ["Lusha"] },
  ],
};

window.Data = Data;
