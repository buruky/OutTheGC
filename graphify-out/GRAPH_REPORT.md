# Graph Report - OutTheGC  (2026-10-08)

## Corpus Check
- 88 files · ~77,636 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 6 file(s) not represented in the graph (top: (none) 3, .css 2, .toml 1)

## Summary
- 297 nodes · 630 edges · 17 communities (16 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.92)
- Token cost: 120,808 input · 0 output

## Community Hubs (Navigation)
- Project Docs & Specialist Agents
- Lint/Build Tooling Config
- Expo SDK Dependencies
- App Manifest & Icons
- Root Layout & Splash Animation
- Sign-up & Profile Screens
- Shared Form/Text Components
- Tab Navigation Layout
- Sign-in & Auth Context
- Project Reset Script
- Trips List Screen
- Trip Detail & Invite Link
- Join-by-Code Screen
- Hint Row & Color Scheme Hook
- TypeScript Config
- Collapsible/Themed View Components
- Fake Trips Data

## God Nodes (most connected - your core abstractions)
1. `ThemedText()` - 30 edges
2. `ThemedView()` - 30 edges
3. `OutTheGC Product Spec` - 24 edges
4. `react-native` - 23 edges
5. `OutTheGC Build Roadmap` - 18 edges
6. `react` - 14 edges
7. `Spacing` - 14 edges
8. `expo` - 13 edges
9. `expo-router` - 12 edges
10. `PrimaryButton()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `decision-record Skill` --references--> `Backfill ADRs (Supabase/Expo/user-bring-posts decisions)`  [EXTRACTED]
  .claude/skills/decision-record/SKILL.md → CLAUDE.md
- `OutTheGC Build Roadmap` --references--> `react-native-maps`  [EXTRACTED]
  OutTheGC-roadmap.md → .claude/agents/mobile-expert.md
- `Mobile App AGENTS.md` --references--> `Expo Go vs Development Build Distinction`  [EXTRACTED]
  apps/mobile/AGENTS.md → .claude/agents/mobile-expert.md
- `Mobile App README` --semantically_similar_to--> `Mobile App AGENTS.md`  [INFERRED] [semantically similar]
  apps/mobile/README.md → apps/mobile/AGENTS.md
- `CLAUDE.md Project Instructions` --references--> `mobile-expert Agent`  [EXTRACTED]
  CLAUDE.md → .claude/agents/mobile-expert.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Specialist Agent Routing (owner per area)** — claude, claude_agents_mobile_expert, claude_agents_pipeline_expert, claude_agents_supabase_expert, claude_agents_security_reviewer [EXTRACTED 1.00]
- **LLM Extraction Pipeline Flow** — concept_llm_extraction_pipeline, outthegc_spec_posts, outthegc_spec_post_candidates, claude_agents_pipeline_expert, claude_skills_extraction_eval_skill [INFERRED 0.85]
- **ADR Decision Recording Workflow** — claude_skills_decision_record_skill, claude_skills_decision_record_references_template, concept_backfill_adrs, claude [EXTRACTED 1.00]

## Communities (17 total, 1 thin omitted)

### Community 0 - "Project Docs & Specialist Agents"
Cohesion: 0.14
Nodes (31): Mobile App AGENTS.md, Mobile App README, CLAUDE.md Project Instructions, mobile-expert Agent, pipeline-expert Agent, security-reviewer Agent, supabase-expert Agent, ADR Template (+23 more)

### Community 1 - "Lint/Build Tooling Config"
Cohesion: 0.05
Nodes (37): { defineConfig }, expoConfig, devDependencies, eslint, eslint-config-expo, @types/react, typescript, main (+29 more)

### Community 2 - "Expo SDK Dependencies"
Cohesion: 0.07
Nodes (28): dependencies, expo, expo-clipboard, expo-constants, expo-device, expo-font, expo-glass-effect, expo-image (+20 more)

### Community 3 - "App Manifest & Icons"
Cohesion: 0.08
Nodes (24): backgroundColor, backgroundImage, foregroundImage, monochromeImage, adaptiveIcon, predictiveBackGestureEnabled, reactCompiler, typedRoutes (+16 more)

### Community 4 - "Root Layout & Splash Animation"
Cohesion: 0.10
Nodes (18): RootLayout(), RootNavigator(), styles, AnimatedSplashOverlay(), glowKeyframe, keyframe, logoKeyframe, styles (+10 more)

### Community 5 - "Sign-up & Profile Screens"
Cohesion: 0.19
Nodes (18): SignUpScreen(), Status, styles, ProfileScreen(), styles, NewTripScreen(), Status, styles (+10 more)

### Community 6 - "Shared Form/Text Components"
Cohesion: 0.21
Nodes (9): styles, TextFieldProps, styles, ThemedTextProps, ThemedViewProps, styles, Fonts, ThemeColor (+1 more)

### Community 7 - "Tab Navigation Layout"
Cohesion: 0.17
Nodes (11): AppTabs(), AppTabs(), CustomTabList(), styles, TabButton(), ExternalLink(), Props, Colors (+3 more)

### Community 8 - "Sign-in & Auth Context"
Cohesion: 0.21
Nodes (12): ResendStatus, SignInScreen(), Status, styles, AuthContext, AuthContextValue, supabase, isEmailNotConfirmedError() (+4 more)

### Community 9 - "Project Reset Script"
Cohesion: 0.17
Nodes (7): exampleDirPath, fs, oldDirs, path, readline, rl, root

### Community 10 - "Trips List Screen"
Cohesion: 0.27
Nodes (9): formatDateRange(), styles, TripRowItem(), TripsScreen(), BottomTabInset, fetchTrips(), JoinTripResult, NewTripInput (+1 more)

### Community 11 - "Trip Detail & Invite Link"
Cohesion: 0.31
Nodes (8): buildInviteLink(), Status, styles, TripDetailScreen(), FAKE_PLACES_BY_TRIP, getPlacesForTrip(), Place, fetchTripById()

### Community 12 - "Join-by-Code Screen"
Cohesion: 0.32
Nodes (6): isInvalidCodeError(), JoinTripScreen(), Status, styles, MaxContentWidth, joinTripByCode()

### Community 13 - "Hint Row & Color Scheme Hook"
Cohesion: 0.25
Nodes (5): HintRow(), HintRowProps, styles, Spacing, react

### Community 14 - "TypeScript Config"
Cohesion: 0.25
Nodes (7): compilerOptions, paths, strict, extends, include, @/assets/*, expo/tsconfig.base

### Community 15 - "Collapsible/Themed View Components"
Cohesion: 0.53
Nodes (5): ThemedView(), Collapsible(), styles, WebBadge(), useTheme()

## Knowledge Gaps
- **17 isolated node(s):** `@expo/ui`, `expo-constants`, `expo-device`, `expo-font`, `expo-glass-effect` (+12 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 147 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `Expo SDK Dependencies` to `Lint/Build Tooling Config`?**
  _High betweenness centrality (0.119) - this node is a cross-community bridge._
- **What connects `@expo/ui`, `expo-constants`, `expo-device` to the rest of the system?**
  _17 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Project Docs & Specialist Agents` be split into smaller, more focused modules?**
  _Cohesion score 0.1358974358974359 - nodes in this community are weakly interconnected._
- **Why does `react-native` connect `Shared Form/Text Components` to `Lint/Build Tooling Config`, `Root Layout & Splash Animation`, `Sign-up & Profile Screens`, `Tab Navigation Layout`, `Sign-in & Auth Context`, `Trips List Screen`, `Trip Detail & Invite Link`, `Join-by-Code Screen`, `Hint Row & Color Scheme Hook`, `Collapsible/Themed View Components`?**
  _High betweenness centrality (0.116) - this node is a cross-community bridge._
- **Should `Lint/Build Tooling Config` be split into smaller, more focused modules?**
  _Cohesion score 0.05263157894736842 - nodes in this community are weakly interconnected._
- **Why does `react` connect `Hint Row & Color Scheme Hook` to `Lint/Build Tooling Config`, `Root Layout & Splash Animation`, `Sign-up & Profile Screens`, `Tab Navigation Layout`, `Sign-in & Auth Context`, `Trips List Screen`, `Trip Detail & Invite Link`, `Join-by-Code Screen`, `Collapsible/Themed View Components`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Should `Expo SDK Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._