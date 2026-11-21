import { MCP_SERVERS, TOOL_LIMITS } from './agent-tools.ts';
import { CREW_MAX_MEMBERS, CREW_NAME_MAX, DELIVERABLE_MAX, MEMBER_NAME_MAX, MODELS, MODES, PARAM_HINT_MAX, PARAMS_MAX, PATHS_MAX, RELATION_MAX, ROLE_MAX, RULES_MAX, VALUE_MAX } from './crew.ts';
import { SKILLS, SKILLS_PER_AGENT_MAX } from './skills.ts';

// A template of a team as JSON Schema, with what each field is for: the tool save_team_template of the MCP server
// of Forchetta takes it (mcp/team.ts), and a team drawn from a description comes back in this shape
// (shared/describe.ts). Forchetta checks it again as its panel does (cleanTemplate). No Node module here: the
// studio of the browser uses it too.

/** What an agent is, the lead or a member: its name, role, model, permissions, skills and tools. */
const AGENT_FIELDS = {
  name: {
    type: 'string',
    maxLength: MEMBER_NAME_MAX,
    description: `Its name, also in the requests and in Claude Code: letters, digits, spaces, ".", "_" and "-", starting with a letter or a digit; ${MEMBER_NAME_MAX} characters at most, each one different.`,
  },
  role: {
    type: 'string',
    maxLength: ROLE_MAX,
    description: `What it does: it goes into its system prompt after "Your role:", and the lead and the other members read it too, so write it in the third person ("Reviews the code…", not "You review…"). ${ROLE_MAX} characters at most.`,
  },
  model: { type: 'string', enum: [...MODELS], description: 'Its model; none: the model of the user.' },
  mode: { type: 'string', enum: [...MODES], description: 'The permission mode of its session; none: the one of the user.' },
  skills: {
    type: 'array',
    items: { type: 'string' },
    maxItems: SKILLS_PER_AGENT_MAX,
    description: `Skills of Claude Code for this agent only, by name; Forchetta fetches them when the team starts, outside the project. ${SKILLS_PER_AGENT_MAX} at most; only what the role needs, or none. The open-source catalog of Forchetta: ${SKILLS.map((skill) => `${skill.id} (${skill.summary.replace(/\.$/, '')})`).join('; ')}. The skills the user added in the studio are allowed too: list_team_templates names them.`,
  },
  tools: {
    type: 'object',
    description:
      'Its tools besides its role, for its session only: limits on the tools of Claude Code, and MCP servers of the catalog of Forchetta. Only what the role needs; none: the usual tools of Claude Code and the MCP servers of the user.',
    properties: {
      limits: {
        type: 'array',
        items: { type: 'string', enum: TOOL_LIMITS.map((limit) => limit.id) },
        description: `What it may not do: ${TOOL_LIMITS.map((limit) => `"${limit.id}": ${limit.summary}`).join(' ')} For example a reviewer that must not change the code: read-only and no-push.`,
      },
      mcp: {
        type: 'array',
        items: { type: 'string', enum: MCP_SERVERS.map((server) => server.id) },
        description: `MCP servers for it alone: ${MCP_SERVERS.map((server) => `"${server.id}": ${server.summary}`).join(' ')} For example a tester of a web app: playwright.`,
      },
      strictMcp: { type: 'boolean', description: 'Start it without the MCP servers of the user: only its own and those of the team.' },
    },
    additionalProperties: false,
  },
} as const;

/** The fields of a template, as save_team_template takes them. */
export const TEMPLATE_PROPERTIES = {
  name: { type: 'string', maxLength: CREW_NAME_MAX, description: `The name of the template, also the name the team gets; ${CREW_NAME_MAX} characters at most.` },
  lead: {
    type: 'object',
    description: 'The lead: a Claude session that splits the work into requests to the members, or the user, who writes the requests from the app.',
    properties: {
      kind: { type: 'string', enum: ['claude', 'you'], description: '"claude": a lead session; "you": the user leads, from the app, and no lead session starts (name, role, model and mode are then ignored).' },
      ...AGENT_FIELDS,
    },
    required: ['kind'],
    additionalProperties: false,
  },
  talk: {
    type: 'string',
    enum: ['twoway', 'oneway'],
    description:
      'How the members talk with the one they report to, unless a member says otherwise: "twoway", the final message of each request goes back and the member can ask questions; "oneway", the member executes only. Default "twoway". Follow the document when it says; otherwise choose for each member (its own talk).',
  },
  worktrees: { type: 'boolean', description: 'Each member in a git worktree of its own (only in a git repository), unless a member says otherwise; the lead merges their branches. Default false: all in the folder of the team.' },
  rules: {
    type: 'string',
    maxLength: RULES_MAX,
    description: `What every agent of the team follows, whatever its role: the conventions, how to commit, what never to do, the shared context of the document. Every session gets them in its system prompt. ${RULES_MAX} characters at most; leave it out when there is nothing shared.`,
  },
  deliverable: {
    type: 'string',
    maxLength: DELIVERABLE_MAX,
    description: `What the team hands over when its work is done, in a line: a pull request, a file (its path), a report. The Claude lead says when it is ready with the tool deliver, and the user is told. ${DELIVERABLE_MAX} characters at most; leave it out when the work has no single result.`,
  },
  params: {
    type: 'array',
    maxItems: PARAMS_MAX,
    description:
      'The parameters of the texts: what changes each time the team starts (a ticket, a branch, an area of the code, a customer). Write {name} for it in a role, a relation, the rules or the deliverable ("Fix the bug of {ticket}"), and declare it here with what to write; the user fills it when the team starts. None when nothing changes.',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,23}$', description: 'Its name as written between braces: lowercase letters, digits, "_" and "-".' },
        hint: { type: 'string', maxLength: PARAM_HINT_MAX, description: 'What to write there, for the user: "the ticket, like APP-123".' },
        default: { type: 'string', maxLength: VALUE_MAX, description: 'Its value when the user gives none (a branch: "main"); none: the user must give one.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  members: {
    type: 'array',
    minItems: 1,
    maxItems: CREW_MAX_MEMBERS,
    description: 'The members, the lead aside: as many as the team needs, on as many levels as it has (reportsTo).',
    items: {
      type: 'object',
      properties: {
        ...AGENT_FIELDS,
        talk: {
          type: 'string',
          enum: ['twoway', 'oneway'],
          description:
            'Its own way of talking with the one it reports to; none: the one of the team. "twoway" when that one needs something back from it: a report, a verdict, facts or an answer to go on with, or when it may need to ask. "oneway" when its work shows in the files and no report is needed (formatting, running a fixed step, writing a text nobody checks): it costs no turn above it, but it cannot ask questions.',
        },
        reportsTo: {
          type: 'string',
          maxLength: MEMBER_NAME_MAX,
          description: 'The name of the member it reports to, which leads it and gives it requests; none: the lead. No circles: each chain goes up to the lead.',
        },
        relation: {
          type: 'string',
          maxLength: RELATION_MAX,
          description: `The prompt of its relation with the one it reports to: how the two work together (what is asked and how, what comes back and in what form, when to ask). Both read it, so write it about the two of them in the third person ("The senior gives…, the junior reports…"). None: just the roles. ${RELATION_MAX} characters at most.`,
        },
        approve: {
          type: 'boolean',
          description:
            'The requests the one it reports to sends it wait for the approval of the user in Forchetta first: a checkpoint where the user looks at the work before it goes on (the plan of the lead before the members build it, a change before it is made). Only where the document or the user asks for one: each one stops the team until the user answers.',
        },
        worktree: { type: 'boolean', description: 'Its own choice of a git worktree; none: the one of the team.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          maxItems: PATHS_MAX,
          description: 'The only files it may change, relative to the folder of the team: folders ("src/ui/"), files, or patterns ("*.test.ts", "docs/**"). Forchetta stops its edits elsewhere, and the edits of the other members there. None: any file no other member has.',
        },
        reviews: { type: 'boolean', description: 'It reviews the commits of the others and records a verdict on each; the lead merges only what it approved.' },
      },
      required: ['name', 'role'],
      additionalProperties: false,
    },
  },
} as const;

/** A template as JSON Schema: the fields above, a name, a lead and members needed. */
export const TEMPLATE_SCHEMA = { type: 'object', properties: TEMPLATE_PROPERTIES, required: ['name', 'lead', 'members'], additionalProperties: false } as const;

/** How to make a good team, for whoever writes a template: a session from a document, or Claude from a description. */
export const TEMPLATE_GUIDE = [
  'Forchetta adds by itself who the lead and the members are and how requests, answers and questions travel between them (the tools send_request, wait_for_answers and ask_lead): the roles say only what each one does. Rules the whole team shares, longer than a role (the conventions of the project, how to commit, what never to do), go in rules: every session of the team gets them in its system prompt, and nothing is written in the folder of the project.',
  'The org chart can have more levels: a member reports to the lead, or to another member (reportsTo), which then leads it, gives it requests and gets its answers; a junior under a senior under the lead. Each one talks only with the one it reports to and with those that report to it. The relation of a member with the one it reports to can have its own prompt (relation): how the two work together, what goes down, what comes back, when to ask; both read it. Put there what is said about that link (formats of requests and reports, rules), not in the roles.',
  'Give an agent tools only where its role needs them (a browser for a tester of a web app; read-only and no-push for a reviewer), a checkpoint of the user (approve) only where one is asked, parameters ({ticket}) for what changes each time the team starts, and a deliverable when the work has one result.',
].join(' ');
